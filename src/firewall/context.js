// Transaction firewall, step 3: the facts the rules need about every account a transaction touches, read in parallel under a time
// budget (a wallet waits on this before showing the signing screen). Whatever does not answer in time is left unknown and the response
// says so (complete: false); a missing fact never becomes a flag.
import { col } from '../db.js';
import { viewAccount, viewAccessKeyList, viewFunction, EMPTY_CODE_HASH } from '../audit/rpc.js';
import { getCachedAudit, summarizeAudit, validNearAddress } from '../audit/service.js';
import { builtinLabel } from '../labels.js';
import { accountRole, KNOWN_ACTORS } from '../analysis/prompt.js';
import { nearUsdPrice } from '../near/quotes.js';
import { accountsIn, TRUSTED } from './rules.js';

const BUDGET_MS = 2500, CACHE_MS = 60e3, MAX_ACCOUNTS = 40;
const cache = new Map(); // key -> { ts, value }
async function cached(key, ms, f) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < ms) return c.value;
  const value = await f();
  cache.set(key, { ts: Date.now(), value });
  if (cache.size > 5000) for (const k of [...cache.keys()].slice(0, 1000)) cache.delete(k);
  return value;
}
/** f() or `fallback` when it takes longer than the budget left (the lookup keeps running and fills the cache for the next check). */
const within = (deadline, f, fallback) => Promise.race([f().catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), Math.max(50, deadline - Date.now())))]);
const UNKNOWN = Symbol('unknown');

const yocto = (y) => { try { return Number(BigInt(y) / 10n ** 18n) / 1e6; } catch { return null; } };
const known = new Map(KNOWN_ACTORS.flatMap((k) => k.ids.map((id) => [id, k])));
const knownActor = (id) => known.get(id) || (/^[0-9a-f]{64}$/.test(id) ? known.get(id.slice(0, 8)) : null);

/** On-chain facts about one account (cached a minute). */
const chainFacts = (id) => cached(`acc:${id}`, CACHE_MS, async () => {
  const a = await viewAccount(id);
  if (!a) return { exists: false };
  return { exists: true, contract: a.code_hash !== EMPTY_CODE_HASH || !!a.global_contract_hash || !!a.global_contract_account_id, balance_near: yocto(a.amount) };
});
const tokenMeta = (id) => cached(`meta:${id}`, 3600e3, async () => { const m = await viewFunction(id, 'ft_metadata'); return m ? { symbol: m.symbol || null, decimals: Number.isInteger(m.decimals) ? m.decimals : null } : null; });

/** What the tracker knows about these accounts: tokens (rugged, creator record, tax), dev-rug blacklist, creators' rug history, reports. */
async function trackerFacts(ids) {
  const [toks, black, flags, ruggers] = await Promise.all([
    col('tokens').find({ _id: { $in: ids } }, { projection: { symbol: 1, creator: 1, 'outcome.rugged': 1, 'outcome.rug_kinds': 1, 'ledger.collapsed': 1, tax: 1 } }).toArray(),
    col('blacklist').find({ _id: { $in: ids } }).toArray(),
    col('firewall_flags').find({ _id: { $in: ids } }).toArray(),
    col('tokens').aggregate([{ $match: { creator: { $in: ids } } }, { $group: { _id: '$creator', launches: { $sum: 1 }, rugged: { $sum: { $cond: ['$outcome.rugged', 1, 0] } } } }]).toArray(),
  ]);
  // the creators of the tokens touched: their blacklist status and rug record
  const creators = [...new Set(toks.map((t) => t.creator).filter(Boolean))];
  const [cBlack, cRec] = creators.length ? await Promise.all([
    col('blacklist').find({ _id: { $in: creators } }).toArray(),
    col('tokens').aggregate([{ $match: { creator: { $in: creators } } }, { $group: { _id: '$creator', launches: { $sum: 1 }, rugged: { $sum: { $cond: ['$outcome.rugged', 1, 0] } } } }]).toArray(),
  ]) : [[], []];
  const cb = new Set(cBlack.map((b) => b._id)), cr = new Map(cRec.map((x) => [x._id, x]));
  return { toks: new Map(toks.map((t) => [t._id, { ...t, creator_blacklisted: cb.has(t.creator), creator_record: cr.get(t.creator) }])), black: new Map(black.map((b) => [b._id, b])), flags: new Map(flags.map((f) => [f._id, f])), ruggers: new Map(ruggers.map((x) => [x._id, x])) };
}

/** Build the rules' ctx for decoded transactions. Returns { ctx, complete, accounts_checked }. */
export async function buildContext(txs) {
  const deadline = Date.now() + BUDGET_MS;
  const signers = [...new Set(txs.map((t) => t.signer).filter(Boolean))];
  const ids = [...new Set([...signers, ...txs.map((t) => t.receiver), ...txs.flatMap((t) => t.actions.flatMap(accountsIn))])].filter(validNearAddress).slice(0, MAX_ACCOUNTS);
  let complete = true;
  const miss = (v) => { if (v === UNKNOWN) { complete = false; return null; } return v; };

  const [facts, tracker, audits, usd] = await Promise.all([
    Promise.all(ids.map((id) => within(deadline, () => chainFacts(id), UNKNOWN))),
    within(deadline, () => trackerFacts(ids), UNKNOWN),
    within(deadline, () => Promise.all(ids.map((id) => getCachedAudit(id))), UNKNOWN),
    within(deadline, () => nearUsdPrice(), null),
  ]);
  const T = miss(tracker) || { toks: new Map(), black: new Map(), flags: new Map(), ruggers: new Map() };
  const A = miss(audits) || [];
  const accounts = new Map();
  ids.forEach((id, i) => {
    const f = miss(facts[i]) || {}, label = builtinLabel(id), role = accountRole(id), ka = knownActor(id), au = A[i] ? summarizeAudit(A[i]) : null;
    const flags = [];
    const rep = T.flags.get(id); if (rep) flags.push({ severity: rep.severity || 'high', reason: rep.reason || 'reported', detail: rep.detail || rep.reason });
    const bl = T.black.get(id); if (bl) flags.push({ severity: 'high', reason: 'a token creator on the dev-rug blacklist', detail: `${id} dumped its own token${bl.symbol ? ` ${bl.symbol}` : ''} (${bl.reason || 'balance emptied'}).` });
    const rr = T.ruggers.get(id); if (rr?.rugged >= 2) flags.push({ severity: 'medium', reason: `created ${rr.rugged} tokens that rugged`, detail: `${id} launched ${rr.launches} tokens; ${rr.rugged} of them rugged.` });
    if (au?.confirmed_malicious?.length) flags.push({ severity: 'critical', reason: 'contract with malicious code', detail: au.confirmed_malicious.map((x) => x.detail || x.key).join('; ') });
    const t = T.toks.get(id);
    let token = null;
    if (t) {
      const tf = [];
      if (t.outcome?.rugged) tf.push(`It rugged (${(t.outcome.rug_kinds || []).join(', ') || 'flagged'}).`);
      if (t.creator_blacklisted) tf.push('Its creator dumped their supply before (dev-rug blacklist).');
      else if (t.creator_record?.rugged >= 1) tf.push(`Its creator's tokens rugged ${t.creator_record.rugged} time(s) out of ${t.creator_record.launches}.`);
      if (au?.risk_level === 'high' || au?.risk_level === 'critical') tf.push(`Contract audit: ${au.risk_level} risk.`);
      token = { symbol: t.symbol || null, rugged: !!t.outcome?.rugged, flags: tf, transfer_fee_pct: t.tax?.transferFeePips ? t.tax.transferFeePips / 1e4 : null };
    }
    accounts.set(id, { exists: f.exists, contract: f.contract, flags, label: label?.label || null, label_type: label?.type || null, role, known: ka ? ka.note : null,
      audit: au?.available ? au : null, token, known_dapp: TRUSTED.has(id) || label?.type === 'service' || (au?.available && au.risk_level === 'low') });
  });

  // token metadata for amounts, and what the signer holds (balance, keys, token balances) when the transaction moves it
  const tokenIds = [...new Set(txs.flatMap((t) => t.actions.filter((a) => a.kind === 'function_call' && /^ft_transfer/.test(a.method)).map(() => t.receiver)))];
  await Promise.all(tokenIds.map(async (id) => {
    const m = miss(await within(deadline, () => tokenMeta(id), UNKNOWN));
    const cur = accounts.get(id) || {};
    accounts.set(id, { ...cur, token: { ...(cur.token || { flags: [] }), symbol: cur.token?.symbol || m?.symbol || null, decimals: m?.decimals ?? null } });
  }));
  const sig = new Map();
  await Promise.all(signers.map(async (s) => {
    const f = accounts.get(s) || {};
    const needsKeys = txs.some((t) => t.signer === s && t.actions.some((a) => ['delete_key', 'add_key', 'deploy_contract', 'use_global_contract'].includes(a.kind)));
    const keys = needsKeys ? miss(await within(deadline, () => viewAccessKeyList(s), UNKNOWN)) : null;
    const tokens = new Map();
    const held = [...new Set(txs.filter((x) => x.signer === s && x.actions.some((a) => a.kind === 'function_call' && /^ft_transfer/.test(a.method))).map((x) => x.receiver))];
    await Promise.all(held.map(async (tok) => {
      const b = miss(await within(deadline, () => viewFunction(tok, 'ft_balance_of', { account_id: s }), UNKNOWN));
      if (b != null) tokens.set(tok, String(b));
    }));
    sig.set(s, { exists: f.exists, contract: f.contract, balance_near: f.balance_near ?? null, full_keys: keys ? keys.filter((k) => k.access_key?.permission === 'FullAccess').map((k) => k.public_key) : null, tokens });
  }));
  return { ctx: { accounts, signers: sig, trusted: TRUSTED, near_usd: usd }, complete, accounts_checked: ids.length };
}

/** A compact reputation of one account, for "send to" screens (GET /api/v1/account). */
export async function accountReputation(id) {
  const { ctx, complete } = await buildContext([{ signer: null, receiver: id, actions: [] }]);
  const a = ctx.accounts.get(id) || {};
  const worst = (a.flags || []).map((f) => f.severity).sort((x, y) => ['critical', 'high', 'medium', 'info'].indexOf(x) - ['critical', 'high', 'medium', 'info'].indexOf(y))[0] || null;
  return { account: id, exists: a.exists ?? null, contract: a.contract ?? null, label: a.label, role: a.role, flags: a.flags || [], risk: worst === 'critical' ? 'critical' : worst || 'none', token: a.token, audit: a.audit ? { risk_level: a.audit.risk_level, trust_level: a.audit.trust_level } : null, complete };
}
