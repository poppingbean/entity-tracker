// Data health (WP-16): know when the chain data itself is wrong or missing, instead of trusting one provider. Two checks, neither changes a verdict:
//   1. block continuity: the live watch reads every height; a run of more than DATA_GAP_BLOCKS heights that came back empty is checked against RPC
//      (a height the chain itself skipped is normal) and, when RPC has them, recorded as a gap and re-read;
//   2. a sampled cross-check: recent transactions the indexer returned are fetched from a DIFFERENT RPC host and compared (sameOutcome).
// Results go to meta `data_health` (gaps, mismatches, counts); the operator gets a private Telegram note (RING_OPERATOR_CHAT_ID) and nothing else.
import { metaGet, metaSet } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';

/** Runs of consecutive heights with no block, longer than `max`: [{ from, to }]. `present`: the heights that returned a block, ascending. */
export function gapRuns(present, from, to, max = config.data?.gapBlocks ?? 5) {
  const have = new Set(present), out = [];
  let start = null;
  for (let h = from; h <= to + 1; h++) {
    const miss = h <= to && !have.has(h);
    if (miss && start == null) start = h;
    if (!miss && start != null) { if (h - start > max) out.push({ from: start, to: h - 1 }); start = null; }
  }
  return out;
}

const logsOf = (outs) => outs.flatMap((o) => o?.outcome?.logs || []);
const failed = (outs) => outs.some((o) => o?.outcome?.status && typeof o.outcome.status === 'object' && 'Failure' in o.outcome.status);
/**
 * Do the indexer's transaction and RPC's (EXPERIMENTAL_tx_status) agree? Same success or failure, same logs; with `receipts: true` also the same
 * receipt count (RPC lists the conversion receipt too, so this is off by default until calibrated on real captures, WP-01). Returns { ok, why }.
 */
export function sameOutcome(indexerTx, rpcTx, { receipts = false } = {}) {
  const a = (indexerTx?.receipts || []).map((r) => r.execution_outcome), b = rpcTx?.receipts_outcome || [];
  if (failed(a) !== failed(b)) return { ok: false, why: `success differs (indexer ${failed(a) ? 'failed' : 'ok'}, rpc ${failed(b) ? 'failed' : 'ok'})` };
  const la = logsOf(a).slice().sort(), lb = logsOf(b).slice().sort();
  if (la.length !== lb.length || la.some((x, i) => x !== lb[i])) return { ok: false, why: `logs differ (${la.length} vs ${lb.length})` };
  if (receipts && a.length !== b.length) return { ok: false, why: `receipt count differs (${a.length} vs ${b.length})` };
  return { ok: true, why: null };
}

const KEEP = 100;
const push = (list, x) => [...(list || []), x].slice(-KEEP);
const notify = async (text) => {
  if (!config.incidents.ringOperatorChat || !config.alerts.telegramToken) return;
  const { sendTelegram } = await import('../alerts/deliver.js').catch(() => ({}));
  await sendTelegram?.(config.incidents.ringOperatorChat, text).catch(() => {});
};

/** Record a confirmed gap (RPC has blocks the watch got nothing for). */
export async function recordGap(g) {
  const h = await metaGet('data_health', {});
  await metaSet('data_health', { ...h, gaps: push(h.gaps, { ...g, ts: Date.now() }) });
  warn(`data health: blocks ${g.from}–${g.to} came back empty but RPC has them`);
  await notify(`Data health: the block feed returned nothing for heights ${g.from}–${g.to}, but RPC has them. They are being read again.`);
}

/** A run of empty heights: is it a real gap? Asks RPC for the first and the last height (a skipped height answers "unknown block"). */
export async function confirmGap(run, rpcBlock) {
  const got = await Promise.all([run.from, run.to].map((h) => rpcBlock(h).then((b) => !!b).catch(() => false)));
  return got.some(Boolean);
}

/** The sampled cross-check: `sample` recent transactions from the indexer against RPC on another host. */
export async function crossCheck({ fetchRecent, fetchRpc, sample = config.data?.checkSample ?? 10 } = {}) {
  const txs = (await fetchRecent(sample)).slice(0, sample), bad = [];
  let checked = 0;
  for (const t of txs) {
    const r = await fetchRpc(t.transaction?.hash, t.transaction?.signer_id).catch(() => null);
    if (!r) continue;
    checked++;
    const s = sameOutcome(t, r, { receipts: !!config.data?.checkReceipts });
    if (!s.ok) bad.push({ hash: t.transaction.hash, why: s.why, ts: Date.now() });
  }
  const h = await metaGet('data_health', {});
  await metaSet('data_health', { ...h, checked: (h.checked || 0) + checked, mismatch_count: (h.mismatch_count || 0) + bad.length, mismatches: bad.reduce(push, h.mismatches || []), last_check_ts: Date.now() });
  if (bad.length) { warn(`data health: ${bad.length} of ${checked} transactions differ between the indexer and RPC`); await notify(`Data health: ${bad.length} of ${checked} sampled transactions differ between the indexer and RPC (first: ${bad[0].hash}, ${bad[0].why}).`); }
  info(`data health: ${checked} transactions cross-checked, ${bad.length} mismatches`);
  return { checked, mismatches: bad };
}

/** The numbers the Accuracy page shows. */
export async function dataHealthSummary() {
  const h = await metaGet('data_health', null);
  if (!h) return null;
  const week = Date.now() - 7 * 86400e3;
  return { gaps_7d: (h.gaps || []).filter((g) => g.ts > week).length, checked: h.checked || 0, mismatches: h.mismatch_count || 0, last_check_ts: h.last_check_ts || null, unrepaired_gap: !!(h.gaps || []).some((g) => !g.repaired_ts && Date.now() - g.ts > 10 * 60e3) };
}

/** Production wiring: a tick of the hourly cross-check against another RPC host. */
export async function runCrossCheck() {
  const { txIndexer } = await import('./rpc.js');
  const hosts = config.data.rpcUrls;
  if (!hosts.length) return null;
  let i = 0;
  const fetchRecent = async (n) => {
    const j = await txIndexer('/v0/account', { account_id: 'wrap.near', limit: n, desc: true });
    const hashes = (j?.account_txs || []).map((r) => r.transaction_hash);
    return (await txIndexer('/v0/transactions', { tx_hashes: hashes }))?.transactions || [];
  };
  const fetchRpc = async (hash, signer) => {
    const url = hosts[i++ % hosts.length];
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'EXPERIMENTAL_tx_status', params: { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' } }), signal: AbortSignal.timeout(20000) }).then((x) => x.json());
    return r.result || null;
  };
  return crossCheck({ fetchRecent, fetchRpc });
}
