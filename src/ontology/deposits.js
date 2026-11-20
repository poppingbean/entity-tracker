// Exchange deposit addresses, read from the chain (the ontology layer's coverage work, docs/ontology-layer-research.md section 5).
// An exchange that gives each customer an address on NEAR sweeps what arrives into its hot wallet. So such an address (a 64-hex implicit account) receives from outside,
// and everything it sends goes to one exchange's wallets, over and over. The registry (src/incident/exchanges.js) finds hot wallets by their sweeps to a cold wallet; this
// is the same idea one level down.
//   sweepsInto(flows, wallets)     pure: the NEAR transfers from outside accounts into an exchange's hot wallets (the candidates)
//   judgeDeposit({ account, flows, wallets })   pure: does this account's own history look like a deposit address?
//   watchDeposits(blocks)          the block watcher: count sweeps per candidate, verify the ones with enough of them, tell the ontology
// A verified account becomes `exchange/deposit_address` (behaviour, 0.7), `operated_by` the exchange and `swept_to` its hot wallet (writer `deposit_addresses`).
// It is evidence of a pattern, not of a label the exchange gave: sharing a deposit address links the wallets of one customer, so the class does not cut links (classes.js).
import { flowsOfReceipt } from '../incident/flows.js';

export const DEPOSIT = { minNear: 1, minSweeps: 3, minIn: 2, sweepShare: 0.9, history: 60, verifyPerTick: 2 };
export const isImplicit = (a) => /^[0-9a-f]{64}$/.test(String(a || ''));
const near = (f) => { try { return f.token === 'near' ? Number(BigInt(f.raw) / 10n ** 18n) / 1e6 : 0; } catch { return 0; } };

/** The NEAR transfers from an outside implicit account into a hot wallet of a named exchange: [{ account, hot, exchange, near, ts, tx }]. `wallets`: Map(account -> { exchange, kind }). */
export function sweepsInto(flows, wallets) {
  const out = [];
  for (const f of flows) {
    const w = wallets.get(f.to), n = near(f);
    if (!w || w.kind !== 'hot' || !w.exchange || n < DEPOSIT.minNear || !isImplicit(f.from) || wallets.has(f.from)) continue;
    out.push({ account: f.from, hot: f.to, exchange: w.exchange, near: n, ts: f.ts, tx: f.tx });
  }
  return out;
}

/**
 * Does the account behave like one exchange's deposit address? From its own recent flows: it received from outside at least `minIn` times, sent NEAR at least `minSweeps` times,
 * every one of those sends went to the same exchange's registry wallets (none to anyone else), and it passed on at least `sweepShare` of what it received.
 * Returns { ok, exchange, hots, in_n, in_near, out_n, out_near, reasons } (reasons: why not).
 */
export function judgeDeposit({ account, flows, wallets }) {
  const ins = flows.filter((f) => f.to === account && near(f) >= DEPOSIT.minNear && !wallets.has(f.from));
  const outs = flows.filter((f) => f.from === account && near(f) >= DEPOSIT.minNear);
  const toEx = outs.filter((f) => wallets.get(f.to)?.exchange);
  const exchanges = new Set(toEx.map((f) => wallets.get(f.to).exchange)), hots = [...new Set(toEx.filter((f) => wallets.get(f.to).kind === 'hot').map((f) => f.to))];
  const inNear = ins.reduce((s, f) => s + near(f), 0), outNear = outs.reduce((s, f) => s + near(f), 0);
  const reasons = [];
  if (!isImplicit(account)) reasons.push('not an implicit account');
  if (wallets.has(account)) reasons.push('it is an exchange wallet itself');
  if (ins.length < DEPOSIT.minIn) reasons.push(`only ${ins.length} deposits from outside`);
  if (outs.length < DEPOSIT.minSweeps) reasons.push(`only ${outs.length} sends`);
  if (toEx.length !== outs.length) reasons.push(`${outs.length - toEx.length} sends went to accounts that are not an exchange's`);
  if (exchanges.size !== 1) reasons.push(exchanges.size ? 'sends to more than one exchange' : 'sends to no exchange');
  if (!hots.length) reasons.push('none of its sends reached a hot wallet');
  if (!(outNear >= DEPOSIT.sweepShare * inNear) || !(inNear > 0)) reasons.push('it does not pass on what it receives');
  const depositors = new Set(ins.map((f) => f.from)).size, sizes = ins.map(near).sort((a, b) => a - b);
  return { ok: reasons.length === 0, exchange: exchanges.size === 1 ? [...exchanges][0] : null, hots, in_n: ins.length, in_near: Math.round(inNear), out_n: outs.length, out_near: Math.round(outNear), depositors, median_deposit_near: Math.round(sizes[Math.floor(sizes.length / 2)] || 0), reasons };
}

/** The NEAR flows of a batch of blocks, without prices (the watcher already values the ones it needs). */
export function nearFlowsOfBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    const height = b.block.header.height, ts = Number(b.block.header.timestamp_nanosec) / 1e6;
    for (const s of b.shards || []) for (const ro of s.receipt_execution_outcomes || []) for (const f of flowsOfReceipt(ro, { tx: ro.tx_hash || null, height, ts })) if (f.token === 'near') out.push(f);
  }
  return out;
}

/** Verify one account against its own history (reads the chain). Never throws. */
export async function verifyAccount(account, wallets) {
  try {
    const { accountTxHashes, fetchTxs } = await import('../incident/trace.js'), { flowsOfTx } = await import('../incident/flows.js');
    const { hashes } = await accountTxHashes(account, { limit: DEPOSIT.history });
    return { ...judgeDeposit({ account, flows: (await fetchTxs(hashes)).flatMap(flowsOfTx), wallets }), txs_read: hashes.length };
  } catch (e) { return { ok: false, reasons: [`could not read its history: ${e.message}`], error: true }; }
}

/**
 * The block watcher's step: count the sweeps into exchange hot wallets per sending account, then verify the few candidates that have enough of them
 * (at most `verifyPerTick` per call) and tell the ontology about the ones that pass. Returns { candidates, verified, passed }.
 */
export async function watchDeposits(blocks) {
  const { col } = await import('../db.js'), { exchangeWalletMap } = await import('../incident/exchanges.js');
  const wallets = await exchangeWalletMap();
  if (!wallets.size) return { candidates: 0, verified: 0, passed: 0 };
  const hits = sweepsInto(nearFlowsOfBlocks(blocks), wallets);
  const by = new Map();
  for (const h of hits) { const c = by.get(h.account) || { n: 0, near: 0, last: 0, hot: h.hot, exchange: h.exchange }; c.n++; c.near += h.near; c.last = Math.max(c.last, h.ts); by.set(h.account, c); }
  if (by.size) await col('deposit_candidates').bulkWrite([...by].map(([account, c]) => ({ updateOne: { filter: { _id: account }, update: { $inc: { sweeps: c.n, near: c.near }, $set: { last_ts: c.last, exchange: c.exchange, hot: c.hot }, $setOnInsert: { first_ts: Date.now() } }, upsert: true } })), { ordered: false });
  // a candidate whose history could not be read is tried again after an hour; one that was judged stays judged
  const due = await col('deposit_candidates').find({ sweeps: { $gte: DEPOSIT.minSweeps }, verified: { $exists: false }, $or: [{ retry_ts: { $exists: false } }, { retry_ts: { $lt: Date.now() } }] }).sort({ sweeps: -1 }).limit(DEPOSIT.verifyPerTick).toArray();
  let passed = 0;
  for (const d of due) {
    const j = await verifyAccount(d._id, wallets);
    if (j.error) { await col('deposit_candidates').updateOne({ _id: d._id }, { $set: { retry_ts: Date.now() + 3600e3, judged: { ...j, ts: Date.now() } } }); continue; }
    await col('deposit_candidates').updateOne({ _id: d._id }, { $set: { verified: j.ok, judged: { ...j, ts: Date.now(), sweeps_then: d.sweeps }, ...(j.ok ? { exchange: j.exchange, hot: j.hots[0] } : {}) } });
    if (j.ok) passed++;
  }
  if (due.length) await (await import('./writers.js')).syncFacts(['deposit_addresses'], { scope: { deposit_addresses: { ids: due.map((d) => d._id) } } });
  return { candidates: by.size, verified: due.length, passed };
}
