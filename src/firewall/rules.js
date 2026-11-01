// Transaction firewall, step 2: what each decoded action will do, and what is risky about it. Pure: the account and token facts come in
// `ctx` (built by context.js), so every rule is unit-tested. Severity -> verdict: critical = block, high = warn, medium = caution.
import { toNear } from './decode.js';
import { looksLikeInjection } from '../ai/untrusted.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'info'];
export const VERDICT = { critical: 'block', high: 'warn', medium: 'caution', info: 'ok' };

/** Contracts users interact with every day; a look-alike of one of these is phishing. */
export const TRUSTED = new Set(['wrap.near', 'v2.ref-finance.near', 'dclv2.ref-labs.near', 'intents.near', 'meta-pool.near', 'linear-protocol.near', 'usdt.tether-token.near',
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'token.sweat', 'social.near', 'aurora', 'contract.main.burrow.near', 'nearlytrade.near',
  'launchpad.justhoot.near', 'v2-launchpad.justhoot.near', 'meme-cooking.near', 'tkn.near', 'aggregatedex.near', 'dex.intear.near', 'blackdragon.tkn.near',
  'token.v2.ref-finance.near', 'lockup.near', 'poolv1.near', 'staking.near', 'near', 'mintbase1.near', 'paras-marketplace-v2.near', 'x.paras.near', 'marketplace.paras.near']);
const IMPLICIT = /^[0-9a-f]{64}$|^0x[0-9a-f]{40}$/;

/** Edit distance (small strings). */
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const fold = (s) => s.replace(/rn/g, 'm').replace(/0/g, 'o').replace(/1/g, 'l').replace(/vv/g, 'w');
/** The trusted account `id` imitates, if any: a near-identical name, or a trusted name used as a label inside another account. */
export function lookalikeOf(id, trusted = TRUSTED) {
  if (!id || trusted.has(id) || IMPLICIT.test(id)) return null;
  for (const t of trusted) {
    if (t.length < 6 || id.endsWith('.' + t)) continue; // too short to judge / a real sub-account of it
    if (lev(id, t) <= 2 || fold(id) === fold(t)) return t;
    if (id.includes(t.replace(/\.near$/, '')) && t.includes('.') && t.replace(/\.near$/, '').length >= 6) return t; // "wrap.near-claim.near", "v2.ref-finance.near.gift.near"
  }
  return null;
}

const short = (s) => (typeof s === 'string' && IMPLICIT.test(s) && s.length > 20 ? s.slice(0, 8) + '…' : s);
const nf = (x, d = 4) => (x == null ? '?' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d }));
/** Token amount from its raw integer string and decimals. */
export function tokenAmount(raw, decimals) {
  try { const v = BigInt(raw); if (decimals == null) return null; const d = 10n ** BigInt(decimals); return Number(v / d) + Number(v % d) / Number(d); } catch { return null; }
}

/** Every string inside the args (receivers, token ids in swap messages, memos). */
function argStrings(args, out = [], depth = 0) {
  if (depth > 6 || out.length > 200) return out;
  if (typeof args === 'string') { out.push(args); if (/^[[{]/.test(args.trim())) try { argStrings(JSON.parse(args), out, depth + 1); } catch {} }
  else if (Array.isArray(args)) args.forEach((x) => argStrings(x, out, depth + 1));
  else if (args && typeof args === 'object') Object.values(args).forEach((x) => argStrings(x, out, depth + 1));
  return out;
}
const ACCOUNTISH = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** Accounts an action touches besides its receiver (who gets tokens / rights, tokens swapped). */
export function accountsIn(a) {
  if (a.kind === 'transfer' || a.kind === 'stake' || a.kind === 'create_account') return [];
  if (a.kind === 'delete_account') return [a.beneficiary];
  if (a.kind === 'add_key' && a.permission !== 'full') return [a.permission.receiver];
  if (a.kind !== 'function_call') return [];
  return [...new Set(argStrings(a.args).filter((s) => s.length >= 2 && s.length <= 64 && ACCOUNTISH.test(s) && (s.includes('.') || IMPLICIT.test(s))))];
}

/** The token a DEX swap message buys (Ref v2: the last action's token_out; Ref DCL: Swap.output_token), if the msg is one. */
export function swapTarget(msg) {
  let m; try { m = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch { return null; }
  if (Array.isArray(m?.actions) && m.actions.length) return m.actions[m.actions.length - 1].token_out || null;
  return m?.Swap?.output_token || m?.SwapByOutput?.output_token || null;
}
const GRANT = /approve|allowance|set_operator|add_operator|grant|authori[sz]e|set_owner|transfer_ownership|change_owner|set_admin|add_admin|add_guardian|set_manager/i;
const BENIGN_METHODS = /^(storage_deposit|storage_withdraw|storage_unregister|near_deposit|near_withdraw|ft_balance_of|deposit_and_stake|unstake|withdraw|withdraw_all|claim|harvest|register_tokens|swap|nft_revoke|nft_revoke_all)$/;

/**
 * Check decoded transactions. ctx = {
 *   accounts: Map(id -> { exists, contract, flags: [{ severity, reason }], label, role, known, token: { symbol, decimals, price_near, rugged, flags: [...] },
 *                         audit: { risk_level, confirmed_malicious } }),
 *   signers: Map(id -> { exists, balance_near, contract, full_keys: [public keys], tokens: Map(token -> raw balance) }),
 *   trusted: Set, near_usd }
 * Returns { verdict, risk, findings, transactions: [{ signer, receiver, meta, actions: [{ index, kind, text }], findings }] }.
 */
export function checkTransactions(txs, ctx = {}) {
  const acc = (id) => ctx.accounts?.get(id) || {};
  const trusted = ctx.trusted || TRUSTED;
  const all = [];
  const out = txs.map((tx, ti) => {
    const f = [], signer = tx.signer, receiver = tx.receiver, me = ctx.signers?.get(signer) || {};
    const add = (severity, code, title, detail, index = null) => f.push({ severity, code, title, detail, tx: ti, action: index });
    const own = signer && receiver === signer; // actions on the signer's own account (keys, code, deletion)
    const creating = tx.actions.some((a) => a.kind === 'create_account');
    const R = acc(receiver);
    const actions = [];

    // ---- who the transaction goes to
    const look = lookalikeOf(receiver, trusted);
    if (look) add('critical', 'lookalike_receiver', `${receiver} imitates ${look}`, `The transaction goes to ${receiver}, a name made to look like ${look}. Phishing sites use look-alike contracts to take deposits and tokens.`);
    for (const fl of R.flags || []) add(fl.severity, 'flagged_receiver', `${receiver}: ${fl.reason}`, fl.detail || fl.reason);
    if (!R.audit?.confirmed_malicious?.length && (R.audit?.risk_level === 'high' || R.audit?.risk_level === 'critical')) add('high', 'risky_contract', `${receiver} is a high-risk contract`, `Its contract audit rates it ${R.audit.risk_level} risk${R.audit.findings?.length ? `: ${R.audit.findings.slice(0, 3).map((x) => x.detail || x.key).join('; ')}` : ''}.`);
    if (R.exists === false && !creating && !IMPLICIT.test(receiver)) add('medium', 'no_such_account', `${receiver} does not exist`, 'There is no account with this name: the transaction will fail. Check for a typo.');

    for (const a of tx.actions) {
      const i = a.index;
      let text = '';
      switch (a.kind) {
        case 'transfer': {
          text = `Send ${nf(a.deposit_near)} NEAR to ${short(receiver)}`;
          if (me.balance_near != null && a.deposit_near >= 0.9 * me.balance_near && a.deposit_near > 0.1) add('medium', 'drains_near', `Sends almost all your NEAR`, `${nf(a.deposit_near)} of your ${nf(me.balance_near)} NEAR goes to ${receiver}.`, i);
          break;
        }
        case 'add_key': {
          if (a.permission === 'full') {
            text = `Give FULL ACCESS to ${own ? 'your account' : receiver} to key ${a.public_key}`;
            if (own) add('critical', 'full_access_key', 'Gives full control of your account', `Whoever holds key ${a.public_key} can move all your NEAR and tokens, add or remove keys and delete your account. Only sign this if you created that key yourself (a new device or a backup). Sites asking for this are draining wallets.`, i);
            else if (creating) add('info', 'new_account_key', `New account ${receiver} gets a full-access key`, `This creates ${receiver} controlled by key ${a.public_key}.`, i);
          } else {
            const p = a.permission, allow = p.allowance == null ? null : toNear(p.allowance);
            text = `Let key ${a.public_key} call ${p.methods?.length ? p.methods.join(', ') : 'any method'} on ${p.receiver}${allow == null ? ' (no spending limit for fees)' : ` (up to ${nf(allow)} NEAR in fees)`}`;
            const pr = acc(p.receiver);
            if ((pr.flags || []).some((x) => x.severity === 'critical' || x.severity === 'high')) add('high', 'key_for_flagged', `Login key for a flagged contract`, `${p.receiver}: ${pr.flags.map((x) => x.reason).join('; ')}.`, i);
            else if (own && !trusted.has(p.receiver) && allow == null) add('medium', 'unlimited_key', 'A login key with no fee limit', `${p.receiver} gets a key that can spend your NEAR on gas without limit (it cannot transfer funds or attach deposits).`, i);
          }
          break;
        }
        case 'delete_key': {
          text = `Remove key ${a.public_key} from ${own ? 'your account' : receiver}`;
          if (own && me.full_keys) {
            const removing = tx.actions.filter((x) => x.kind === 'delete_key' && me.full_keys.includes(x.public_key)).map((x) => x.public_key);
            const left = me.full_keys.filter((k) => !removing.includes(k)).length, addsFull = tx.actions.some((x) => x.kind === 'add_key' && x.permission === 'full');
            if (removing.includes(a.public_key) && left === 0 && addsFull) add('critical', 'key_swap', 'Replaces your keys with someone else\'s', 'This removes every full-access key you have and adds a new one: whoever holds the new key owns your account and you lose it.', i);
            else if (removing.includes(a.public_key) && left === 0) add('critical', 'lockout', 'Removes your last full-access key', 'After this nobody can control the account any more: everything in it is locked forever.', i);
            else if (removing.includes(a.public_key)) add('medium', 'remove_full_key', 'Removes a full-access key', `Make sure ${a.public_key} is not the key you use.`, i);
          }
          break;
        }
        case 'delete_account': {
          text = `DELETE ${own ? 'your account' : receiver} and send its NEAR to ${a.beneficiary}`;
          if (own) add(a.beneficiary === signer ? 'high' : 'critical', 'delete_account', 'Deletes your account', `Your account is deleted and its NEAR goes to ${a.beneficiary}. Tokens and NFTs still held are lost.`, i);
          break;
        }
        case 'deploy_contract': case 'use_global_contract': case 'deploy_global_contract': {
          text = a.kind === 'use_global_contract' ? `Set ${own ? 'your account' : receiver}'s code to ${a.contract}` : `Deploy code (${nf(a.code_len, 0)} bytes) to ${own ? 'your account' : receiver}`;
          if (own && a.kind !== 'deploy_global_contract') add(me.contract ? 'high' : 'critical', 'deploy_to_account', me.contract ? 'Replaces your contract code' : 'Turns your wallet into a contract',
            me.contract ? 'New code runs on your account: check it is the release you expect.' : 'Code put on your account can move your funds by itself, without your keys. Wallet drainers do this.', i);
          break;
        }
        case 'stake': text = `Stake ${nf(toNear(a.stake))} NEAR with key ${a.public_key}`; break;
        case 'create_account': text = `Create account ${receiver}`; break;
        case 'function_call': {
          const args = a.args || {}, m = a.method;
          const tok = R.token;
          text = `Call ${m} on ${short(receiver)}${a.deposit_near ? ` with ${nf(a.deposit_near)} NEAR attached` : ''}`;
          if (m === 'ft_transfer' || m === 'ft_transfer_call') {
            const amt = tokenAmount(args.amount, tok?.decimals), sym = tok?.symbol || receiver;
            const out = m === 'ft_transfer_call' ? swapTarget(args.msg) : null;
            text = out ? `Swap ${amt == null ? args.amount : nf(amt)} ${sym} for ${acc(out).token?.symbol || short(out)} on ${short(args.receiver_id)}`
              : `Send ${amt == null ? args.amount : nf(amt)} ${sym} to ${short(args.receiver_id)}${m === 'ft_transfer_call' ? ' (and let that contract act on them)' : ''}`;
            const bal = me.tokens?.get(receiver);
            if (bal != null && BigInt(bal) > 0n && BigInt(args.amount || 0) * 10n >= BigInt(bal) * 9n) add('medium', 'drains_token', `Sends all your ${sym}`, `This sends ${amt == null ? 'all' : nf(amt)} ${sym}, at least 90% of what you hold.`, i);
            if (m === 'ft_transfer_call' && args.receiver_id && !trusted.has(args.receiver_id) && !acc(args.receiver_id).known_dapp) add('medium', 'tokens_to_unknown_contract', `Tokens go to a contract you may not know`, `${args.receiver_id} receives ${sym} and decides what to do with them (msg: ${String(args.msg ?? '').slice(0, 80) || 'empty'}).`, i);
          } else if (m === 'nft_transfer' || m === 'nft_transfer_call') {
            text = `Send NFT #${args.token_id} of ${short(receiver)} to ${short(args.receiver_id)}`;
          } else if (m === 'nft_approve') {
            text = `Let ${short(args.account_id)} transfer your NFT #${args.token_id} of ${short(receiver)}`;
            const sp = acc(args.account_id);
            add(trusted.has(args.account_id) || sp.known_dapp ? 'info' : 'high', 'nft_approval', `Lets ${args.account_id} take NFT #${args.token_id}`,
              `${args.account_id} can transfer this NFT out of your wallet at any time until you revoke it. Normal for a marketplace listing; otherwise it is how NFT thieves work.`, i);
          } else if (GRANT.test(m) && !BENIGN_METHODS.test(m) && !trusted.has(receiver)) {
            add('high', 'grants_rights', `${m}: gives someone rights`, `The method name says it grants rights (spending, ownership or admin) on ${receiver}. Check who receives them: ${accountsIn(a).filter((x) => x !== signer).slice(0, 3).join(', ') || 'see the arguments'}.`, i);
          }
          if (a.deposit_near >= 1 && !trusted.has(receiver) && !R.known_dapp && !tok) add('medium', 'deposit_to_unknown', `Attaches ${nf(a.deposit_near)} NEAR to ${receiver}`, `The contract receives ${nf(a.deposit_near)} NEAR. Only do this if you trust ${receiver}.`, i);
          if (a.args_binary) add('info', 'binary_args', 'Arguments are not readable', 'The call data is binary, so what it asks for cannot be shown.', i);
          if (looksLikeInjection(...argStrings(a.args).slice(0, 50))) add('medium', 'ai_manipulation', 'The call data talks to automated reviewers', 'Text in the arguments tries to instruct AI or security checks: a sign of a malicious payload.', i);
          break;
        }
        default: text = a.kind;
      }
      // ---- accounts the action gives something to (token receivers, approvals, beneficiaries) and tokens it trades
      for (const id of accountsIn(a)) {
        if (id === signer || id === receiver) continue;
        const x = acc(id), lk = lookalikeOf(id, trusted);
        if (lk) add('critical', 'lookalike_account', `${id} imitates ${lk}`, `The action involves ${id}, a name made to look like ${lk}.`, i);
        for (const fl of x.flags || []) add(fl.severity, 'flagged_account', `${id}: ${fl.reason}`, fl.detail || fl.reason, i);
        if (x.token?.flags?.length) add(x.token.rugged ? 'high' : 'medium', 'risky_token', `${x.token.symbol || id}: ${x.token.flags[0]}`, `This action trades or touches ${x.token.symbol || id}. ${x.token.flags.join(' ')}`, i);
      }
      if (a.kind === 'function_call' && R.token?.flags?.length && !all.concat(f).some((y) => y.code === 'risky_token' && y.tx === ti)) add(R.token.rugged ? 'high' : 'medium', 'risky_token', `${R.token.symbol || receiver}: ${R.token.flags[0]}`, `${R.token.symbol || receiver}: ${R.token.flags.join(' ')}`, i);
      actions.push({ index: i, kind: a.kind, text, ...(a.method ? { method: a.method } : {}), ...(a.deposit_near ? { deposit_near: a.deposit_near } : {}) });
    }
    if (tx.meta) add('info', 'meta_transaction', 'Signed as a meta transaction', `A relayer${tx.relayer ? ` (${tx.relayer})` : ''} pays the gas; the actions run as ${signer}.`);
    // one finding per code and action (a flag can be reached twice: as receiver and inside the args)
    const seen = new Set(), uniq = f.filter((x) => { const k = `${x.code}|${x.action}|${x.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
    all.push(...uniq);
    return { signer, receiver, ...(tx.meta ? { meta: true } : {}), actions, findings: uniq };
  });
  all.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const risk = all.length ? all[0].severity : 'info';
  const top = all.filter((x) => x.severity !== 'info');
  return {
    verdict: VERDICT[risk], risk: risk === 'info' ? 'low' : risk,
    summary: top.length ? `${top[0].title.replace(/\.+$/, '')}${top.length > 1 ? ` (+${top.length - 1} more warning${top.length > 2 ? 's' : ''})` : ''}.` : 'No known risk found in this transaction.',
    findings: all, transactions: out,
  };
}
