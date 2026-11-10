// Exchange wallets on NEAR and what is normal for each, so a drain stands out the moment it happens.
//   discovery  most exchange hot wallets have no NEAR name. They are found by what they do: the busy `hub` wallets the tracker already
//              meets while profiling buyers, the exchange-named account each one sends its reserves to (its cold wallet: that names the
//              exchange), then every other busy wallet that sends to the same cold wallet (more hot wallets of that exchange). Accounts
//              can also be added by hand (`node src/cli.js exchange-wallet <account> <exchange>`).
//   baseline   per hot wallet, from its latest outgoing NEAR transfers: the usual size (median), the large end (p99), the largest, and
//              its balance. A transfer far above that, or most of the balance, is not a customer withdrawal.
// Refreshed by the worker once a day (`exchange_wallets`); `node src/cli.js exchanges` does it by hand.
import { col } from '../db.js';
import { info } from '../log.js';
import { txIndexer } from '../near/rpc.js';
import { viewAccount } from '../audit/rpc.js';
import { builtinLabel } from '../labels.js';

const BUSY = 20000;           // transactions: a hot wallet, not a person
const SAMPLE = 400;           // latest transactions read for discovery and the baseline
const YOCTO_NEAR = 10n ** 24n;
const near = (y) => { try { return Number(BigInt(y) / 10n ** 21n) / 1e3; } catch { return 0; } };

async function txsOf(id, { limit = SAMPLE, signer = false } = {}) {
  const j = await txIndexer('/v0/account', { account_id: id, limit, desc: true, ...(signer ? { is_signer: true } : {}) }).catch(() => null);
  const hashes = (j?.account_txs || []).map((r) => r.transaction_hash);
  const out = [];
  for (let i = 0; i < hashes.length; i += 20) out.push(...((await txIndexer('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) }).catch(() => null))?.transactions || []));
  return { txs: out, total: j?.txs_count ?? null };
}
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** One wallet's profile: is it busy, which exchange does it sweep to, and its outgoing-transfer baseline. */
export async function profileWallet(id) {
  const [{ txs, total }, state] = await Promise.all([txsOf(id, { signer: true }), viewAccount(id).catch(() => null)]);
  const outs = [];
  let sweep = null;
  for (const t of txs) {
    if (t.transaction.signer_id !== id) continue;
    const l = builtinLabel(t.transaction.receiver_id);
    // the baseline is customer withdrawals: moves to the exchange's own named wallets (sweeps to cold storage) are left out
    if (l?.type !== 'exchange') for (const a of t.transaction.actions || []) if (a?.Transfer) outs.push(near(a.Transfer.deposit));
    if (!sweep && l?.type === 'exchange' && t.transaction.receiver_id !== id) sweep = { to: t.transaction.receiver_id, exchange: l.label };
  }
  const first = await txIndexer('/v0/account', { account_id: id, limit: 1, desc: false }).catch(() => null);
  return { total: total ?? first?.txs_count ?? null, sweep, balance_near: state ? near(state.amount) : null,
    // p98, not the maximum: one past drain in the sample must not make the next one look normal
    baseline: { n: outs.length, median_near: Math.round(pct(outs, 0.5) * 100) / 100, p98_near: Math.round(pct(outs, 0.98) * 100) / 100 } };
}

/** Busy accounts that sign transactions into a cold wallet: that exchange's hot wallets. */
async function hotWalletsOf(cold) {
  const { txs } = await txsOf(cold, { limit: 200 });
  const n = new Map();
  for (const t of txs) { const s = t.transaction.signer_id; if (s !== cold && /^[0-9a-f]{64}$/.test(s)) n.set(s, (n.get(s) || 0) + 1); }
  return [...n].filter(([, c]) => c >= 3).map(([s]) => s);
}

/** Discover and profile exchange wallets. Returns { wallets, exchanges }. */
export async function refreshExchangeRegistry({ log = info } = {}) {
  const [hubs, known] = await Promise.all([col('entities').find({ kind: 'hub' }, { projection: { _id: 1 } }).toArray(), col('exchange_wallets').find({}).toArray()]);
  const queue = [...new Set([...known.map((k) => k._id), ...hubs.map((h) => h._id)])];
  const seen = new Set(), colds = new Map(), rows = [];
  while (queue.length && rows.length < 400) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const prev = known.find((k) => k._id === id);
    const p = await profileWallet(id).catch(() => null);
    if (!p) continue;
    const manual = prev?.source === 'manual';
    if (!manual && (p.total ?? 0) < BUSY && !p.sweep) continue; // neither busy nor sweeping to an exchange: not a hot wallet
    const exchange = manual ? prev.exchange : p.sweep?.exchange || prev?.exchange || null;
    rows.push({ _id: id, exchange, kind: 'hot', how: manual ? prev.how : p.sweep ? `sends its reserves to ${p.sweep.to}` : `${(p.total || 0).toLocaleString('en-US')} transactions`, cold: p.sweep?.to || prev?.cold || null,
      tx_count: p.total, balance_near: p.balance_near, baseline: p.baseline, source: manual ? 'manual' : prev?.source || 'discovered', updated_ts: Date.now() });
    if (p.sweep && !colds.has(p.sweep.to)) colds.set(p.sweep.to, p.sweep.exchange);
    // the cold wallet's other senders are the same exchange's other hot wallets
    if (p.sweep && colds.get(p.sweep.to) && !seen.has(`cold:${p.sweep.to}`)) { seen.add(`cold:${p.sweep.to}`); for (const h of await hotWalletsOf(p.sweep.to)) if (!seen.has(h)) queue.push(h); }
  }
  for (const [cold, exchange] of colds) rows.push({ _id: cold, exchange, kind: 'cold', how: 'exchange-named account', updated_ts: Date.now(), source: 'named' });
  if (rows.length) await col('exchange_wallets').bulkWrite(rows.map((r) => ({ replaceOne: { filter: { _id: r._id }, replacement: r, upsert: true } })), { ordered: false });
  cache.ts = 0;
  await (await import('../ontology/writers.js')).syncFacts(['exchange_wallets', 'solvers']); // G1: new exchange wallets cut paths at once; solvers re-checked with the registry
  log(`exchange registry: ${rows.filter((r) => r.kind === 'hot').length} hot wallets (${rows.filter((r) => r.kind === 'hot' && r.exchange).length} named), ${colds.size} cold wallets`);
  return { wallets: rows.length, exchanges: [...new Set(rows.map((r) => r.exchange).filter(Boolean))] };
}

/** Add one by hand (an exchange's announced address). */
export async function addExchangeWallet(id, exchange, kind = 'hot') {
  const p = await profileWallet(id).catch(() => ({}));
  await col('exchange_wallets').replaceOne({ _id: id }, { _id: id, exchange, kind, how: 'named by hand', tx_count: p.total ?? null, balance_near: p.balance_near ?? null, baseline: p.baseline || null, source: 'manual', updated_ts: Date.now() }, { upsert: true });
  cache.ts = 0;
  await (await import('../ontology/writers.js')).syncFacts(['exchange_wallets']); // G1
}

const cache = { ts: 0, map: new Map() };
/** The registry (hot and cold wallets), cached 10 minutes; falls back to the tracker's hub wallets before the first refresh. */
export async function exchangeWalletMap() {
  if (Date.now() - cache.ts < 600e3 && cache.map.size) return cache.map;
  let rows = await col('exchange_wallets').find({}).toArray().catch(() => []);
  if (!rows.length) rows = (await col('entities').find({ kind: 'hub' }, { projection: { _id: 1, tx_count: 1 } }).toArray().catch(() => [])).map((h) => ({ _id: h._id, kind: 'hot', exchange: null, how: 'hub wallet', tx_count: h.tx_count }));
  cache.map = new Map(rows.map((r) => [r._id, r])); cache.ts = Date.now();
  return cache.map;
}

/**
 * Is this outflow of a hot wallet unusual? `nearAmount` sent, `remainingNear` left after it. Returns the reasons (empty = normal).
 * Unusual = 5x the large end of its customer withdrawals (p98), or at least half of what it held.
 */
export function unusualOutflow(w, nearAmount, remainingNear) {
  const r = [], b = w?.baseline;
  if (b?.n >= 20 && nearAmount > Math.max(5 * (b.p98_near || 0), 1000)) r.push(`${Math.round(nearAmount).toLocaleString('en-US')} NEAR is ${Math.round(nearAmount / Math.max(b.p98_near, 1))}x its usual large withdrawal (${Math.round(b.p98_near).toLocaleString('en-US')} NEAR; median ${b.median_near})`);
  if (remainingNear != null && nearAmount >= 0.5 * (nearAmount + remainingNear) && nearAmount > 1000) r.push(`it sent ${Math.round(100 * nearAmount / (nearAmount + remainingNear))}% of its balance`);
  return r;
}
export { YOCTO_NEAR };
