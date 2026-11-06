// Checks for each kind of contract (read-only views), and recent behaviour (who called the powerful methods, do users' actions fail).
// Each returns findings [{ severity, key, title, detail }] and facts for the page.
import { viewFunction } from './rpc.js';
import { txIndexer } from '../near/rpc.js';
import { corroborateOwnerChecks, payoutsOf } from './destination.js';

const yocto = (y) => { try { return Number(BigInt(y) / 10n ** 18n) / 1e6; } catch { return null; } };
const MUTABLE_HOST = /^https?:\/\/(?!ipfs\.|arweave\.net|[a-z0-9]+\.ipfs\.|[a-z0-9.-]*arweave)/i;
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

/** Views for the contract's role. `exports` limits calls to methods that exist. `owners` = controller accounts. */
export async function typeChecks(account, role, exports, { owners = [] } = {}) {
  const has = (m) => exports?.includes(m), f = [], facts = {};
  const add = (severity, key, title, detail) => f.push({ severity, key, title, detail });
  try {
    if (role === 'nft') {
      const meta = has('nft_metadata') ? await viewFunction(account, 'nft_metadata') : null;
      const total = has('nft_total_supply') ? Number(await viewFunction(account, 'nft_total_supply')) : null;
      facts.name = meta?.name || null; facts.symbol = meta?.symbol || null; facts.base_uri = meta?.base_uri || null; facts.total_supply = Number.isFinite(total) ? total : null;
      // a sample token: where its media lives
      const sample = has('nft_tokens') ? (await viewFunction(account, 'nft_tokens', { from_index: '0', limit: 3 }))?.[0] : null;
      const media = sample?.metadata?.media || null;
      const mediaUrl = media && !/^https?:/.test(media) && meta?.base_uri ? `${meta.base_uri.replace(/\/$/, '')}/${media}` : media;
      facts.sample_media = mediaUrl;
      if (mediaUrl && MUTABLE_HOST.test(mediaUrl)) add('medium', 'nft_mutable_media', 'NFT media sits on a normal web server', `${mediaUrl.slice(0, 120)}: whoever runs that server can change or remove the images after you buy (IPFS or Arweave can't be changed).`);
      if (meta?.base_uri && MUTABLE_HOST.test(meta.base_uri)) add('low', 'nft_mutable_base_uri', 'Metadata base URI is a normal web server', meta.base_uri.slice(0, 120));
      // how much the owners hold
      if (facts.total_supply && has('nft_supply_for_owner')) for (const o of owners.slice(0, 3)) {
        const n = Number(await viewFunction(account, 'nft_supply_for_owner', { account_id: o }));
        if (n > 0 && n / facts.total_supply >= 0.2) add('medium', 'nft_owner_holds', `The owner holds ${pct(n / facts.total_supply)} of the collection`, `${o} holds ${n} of ${facts.total_supply} tokens and can sell into the market at any time.`);
      }
      if (sample && has('nft_payout')) {
        const pay = await viewFunction(account, 'nft_payout', { token_id: sample.token_id, balance: '10000', max_len_payout: 10 });
        const shares = Object.entries(pay?.payout || {}).filter(([a]) => a !== sample.owner_id).map(([, v]) => Number(v));
        const royalty = shares.reduce((s, x) => s + x, 0) / 10000;
        facts.royalty = royalty;
        if (royalty >= 0.25) add('medium', 'nft_high_royalty', `Royalties take ${pct(royalty)} of every sale`, 'A large part of each resale goes to the creators.');
      }
      if (!exports.some((m) => /max_supply|get_max|supply_cap/.test(m)) && exports.some((m) => /^nft_mint|^mint/.test(m))) add('low', 'nft_no_max_supply', 'No maximum supply exposed', 'The contract mints and does not show a supply cap: the owner may mint more later.');
    } else if (role === 'staking_pool') {
      const fee = has('get_reward_fee_fraction') ? await viewFunction(account, 'get_reward_fee_fraction') : null;
      const paused = has('is_staking_paused') ? await viewFunction(account, 'is_staking_paused') : null;
      if (fee) { facts.reward_fee = fee.numerator / fee.denominator; if (facts.reward_fee > 0.2) add('medium', 'pool_high_fee', `The validator keeps ${pct(facts.reward_fee)} of rewards`, 'Above the usual 1-10 %; the owner can change it.'); }
      if (paused) add('medium', 'pool_paused', 'Staking is paused', 'The pool is not staking: deposits earn nothing.');
    } else if (role === 'liquid_staking') {
      const price = has('get_st_near_price') ? await viewFunction(account, 'get_st_near_price') : has('ft_price') ? await viewFunction(account, 'ft_price') : null;
      if (price != null) { facts.share_price_near = yocto(price); if (facts.share_price_near < 1) add('high', 'lst_below_par', `One share is worth ${facts.share_price_near} NEAR`, 'Liquid-staking shares only grow; below 1 NEAR means losses (slashing or a bug).'); }
      const paused = has('is_paused') ? await viewFunction(account, 'is_paused') : null;
      if (paused) add('medium', 'lst_paused', 'The protocol is paused', 'Deposits or withdrawals may be blocked.');
    } else if (role === 'dao') {
      const pol = has('get_policy') ? await viewFunction(account, 'get_policy') : null;
      const council = (pol?.roles || []).flatMap((r) => r.kind?.Group || []);
      facts.council = council.length;
      if (council.length === 1) add('medium', 'dao_single_member', 'The DAO has one council member', `${council[0]} alone decides every proposal: it works like a single wallet.`);
    } else if (role === 'bridge') {
      const paused = has('pa_all_paused') ? await viewFunction(account, 'pa_all_paused') : null;
      if (Array.isArray(paused) ? paused.length : paused) add('medium', 'bridge_paused', 'Some bridge features are paused', JSON.stringify(paused).slice(0, 120));
    } else if (role === 'token') {
      const meta = has('ft_metadata') ? await viewFunction(account, 'ft_metadata') : null;
      facts.symbol = meta?.symbol || null; facts.decimals = meta?.decimals ?? null;
    }
  } catch { /* a check that fails is skipped, never a finding */ }
  return { findings: f, facts };
}

/**
 * Recent behaviour: calls to the contract's powerful methods (who, how often, when) and users' calls failing. Reads the newest pages
 * of the contract's history (FastNEAR indexer).
 */
export async function recentBehaviour(account, powers, { ownerHints = [], notPayees = [] } = {}) {
  const powerOf = new Map(powers.flatMap((p) => p.methods.map((m) => [m, p])));
  let rows = [];
  try { rows = ((await txIndexer('/v0/account', { account_id: account, desc: true, limit: 200 })).account_txs || []).slice(0, 200); } catch { return { findings: [], facts: { history: null } }; }
  if (!rows.length) return { findings: [], facts: { history: 0 } };
  const hashes = rows.slice(0, 60).map((r) => r.transaction_hash);
  let txs = [];
  try { for (let i = 0; i < hashes.length; i += 20) txs.push(...((await txIndexer('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) })).transactions || [])); } catch {}
  // the owner-check hints from the code, checked against the chain: did every payout of those methods go to the address committed at creation?
  const owner_payouts = ownerHints.length ? await ownerPayouts(account, ownerHints, txs, notPayees).catch(() => null) : null;
  const confirmed = new Set(owner_payouts?.corroborated || []);
  const used = new Map(), userCalls = new Map();
  for (const t of txs) {
    const tx = t.transaction; if (tx?.receiver_id !== account) continue;
    const fc = (tx.actions || []).map((a) => a.FunctionCall).find(Boolean); if (!fc) continue;
    const failed = (t.receipts || []).some((r) => r.execution_outcome?.outcome?.executor_id === account && r.execution_outcome.outcome.status?.Failure);
    const p = powerOf.get(fc.method_name);
    if (p && !failed) { const k = `${p.power}|${fc.method_name}`; const x = used.get(k) || { power: p, method: fc.method_name, n: 0, signers: new Set(), last: 0 }; x.n++; x.signers.add(tx.signer_id); x.last = Math.max(x.last, Number(t.execution_outcome?.block_timestamp || 0) / 1e6); used.set(k, x); }
    else if (!p) { const x = userCalls.get(fc.method_name) || { n: 0, failed: 0, signers: new Set(), failedSigners: new Set() }; x.n++; x.signers.add(tx.signer_id); if (failed) { x.failed++; x.failedSigners.add(tx.signer_id); } userCalls.set(fc.method_name, x); }
  }
  const f = [];
  for (const x of used.values()) {
    if (x.power.power === 'move_user_funds' || x.power.power === 'account_control') {
      // a use whose every payout the chain shows went to the committed owner is one step milder (never more)
      const ok = x.power.power === 'move_user_funds' && confirmed.has(x.method);
      const sev = x.power.severity === 'critical' ? 'critical' : 'high';
      f.push({ severity: ok ? (sev === 'critical' ? 'high' : 'medium') : sev, key: `used_${x.power.power}`, title: `${x.method} was used ${x.n} time${x.n > 1 ? 's' : ''} recently`,
        detail: `By ${[...x.signers].slice(0, 3).join(', ')}. ${x.power.label}.${ok ? ' Every payout it made went to the address committed when the contract was set up (checked on the chain).' : ''}` });
    }
    else if (x.power.power === 'upgrade' || x.power.power === 'set_admins') f.push({ severity: 'info', key: `used_${x.power.power}`, title: `${x.method} called recently`, detail: `By ${[...x.signers].slice(0, 3).join(', ')}${x.last ? `, last ${new Date(x.last).toISOString().slice(0, 10)}` : ''}.` });
  }
  // users' withdrawals / transfers failing for several wallets while few succeed: the honeypot pattern, for any kind of contract
  for (const [m, x] of userCalls) if (/withdraw|unstake|transfer|redeem|claim|sell|exit/.test(m) && x.failedSigners.size >= 3 && x.failed / x.n >= 0.6)
    f.push({ severity: 'high', key: 'user_calls_failing', title: `${m} fails for most users`, detail: `${x.failed} of ${x.n} recent ${m} calls failed, for ${x.failedSigners.size} different wallets.` });
  return { findings: f, facts: { history: rows.length, sampled: txs.length, ...(owner_payouts ? { owner_payouts } : {}), admin_calls: [...used.values()].map((x) => ({ method: x.method, n: x.n, signers: [...x.signers].slice(0, 3) })) } };
}

/**
 * On-chain corroboration of owner-check hints (destination.js): the successful calls of `methods` among `txs` (the newest history), their payouts,
 * and the arguments of the account's init call (its oldest transactions). The callers are added to `notPayees`.
 * -> { corroborated: [method], seen: { method: { calls, paying, matched } }, init_found }
 */
export async function ownerPayouts(account, methods, txs, notPayees = []) {
  const calls = [];
  for (const t of txs) {
    const tx = t.transaction; if (tx?.receiver_id !== account) continue;
    const fc = (tx.actions || []).map((a) => a.FunctionCall).find(Boolean); if (!fc || !methods.includes(fc.method_name)) continue;
    if ((t.receipts || []).some((r) => r.execution_outcome?.outcome?.executor_id === account && r.execution_outcome.outcome.status?.Failure)) continue;
    calls.push({ method: fc.method_name, args: Buffer.from(fc.args || '', 'base64'), payouts: payoutsOf(t, account), signer: tx.signer_id });
  }
  if (!calls.length) return { corroborated: [], seen: {}, init_found: null };
  const oldest = ((await txIndexer('/v0/account', { account_id: account, desc: false, limit: 10 })).account_txs || []).map((r) => r.transaction_hash);
  const old = oldest.length ? ((await txIndexer('/v0/transactions', { tx_hashes: oldest })).transactions || []) : [];
  const init = [];
  for (const t of old) for (const r of t.receipts || []) if (r.receipt?.receiver_id === account)
    for (const a of r.receipt.receipt?.Action?.actions || []) if (a.FunctionCall && /^(new|init|initialize|new_default_meta)$/.test(a.FunctionCall.method_name)) init.push(Buffer.from(a.FunctionCall.args || '', 'base64'));
  const r = corroborateOwnerChecks({ init, calls, exclude: [...notPayees, ...calls.map((c) => c.signer)] });
  return { ...r, init_found: init.length > 0 };
}
