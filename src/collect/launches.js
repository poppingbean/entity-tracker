// Find new launches: follow each launchpad contract, and (backfill) replay recent history.
import { col, metaGet, metaSet } from '../db.js';
import { config } from '../config.js';
import { adapters } from '../launchpads.js';
import { fetchTxs, newTxHashes, accountRows } from '../near/indexer.js';
import { view } from '../near/rpc.js';
import { DCL } from '../near/quotes.js';
import { info, warn } from '../log.js';
import { isKnownQuote } from '../near/quotes.js';

const LOOKBACK_BLOCKS = 300; // re-read a little so a transaction the index listed late is not missed (inserts are idempotent)

export async function saveLaunches(launchpad, txs) {
  let added = 0;
  for (const tx of txs) {
    if (tx.failed) continue;
    for (const l of adapters[launchpad].parse(tx)) {
      // launches that do not name the token (meme.cooking, qlyphs): ask the token contract
      if (!l.symbol) { try { const md = await view(l.token, 'ft_metadata'); l.symbol = md?.symbol || null; l.name = l.name || md?.name || null; } catch {} }
      const doc = {
        launchpad: l.launchpad || launchpad, creator: l.creator, symbol: l.symbol || null, name: l.name || null, meme_id: l.memeId ?? null, pool: l.pool,
        dev_buy_near: l.devBuyNear ?? null, dev_buy_quote_raw: l.devBuyQuoteRaw ?? null, lp: l.lp ?? null, tax: l.tax ?? null, liquidity_near: l.liquidityNear ?? null,
        live_ts: tx.ts, live_height: tx.height, live_tx: tx.hash, status: l.awaitingPool ? 'awaiting_pool' : isKnownQuote(l.pool.quote) || l.pool.dex === 'curve' ? 'new' : 'skipped_quote', // pools quoted in other memecoins cannot be valued in NEAR
         sync_height: null, sync_ts: null, trades_n: 0, created_ts: Date.now(), next_process_ts: l.awaitingPool ? null : 0,
        // tracked for early investors only: the scanner (gates, AI analyst, simulated buys) skips these
        live_on_first_trade: !!l.liveOnFirstTrade,
        ...(l.trackOnly ? { track_only: true, scan_done: true, scan: { ts: Date.now(), skipped: true, decision: `tracking only (${launchpad}): no gates / AI / simulated buy` } } : {}),
      };
      const r = await col('tokens').updateOne({ _id: l.token }, { $setOnInsert: doc }, { upsert: true });
      if (r.upsertedCount) { added++; info(`NEW ${launchpad} ${l.symbol || ''} ${l.token}`); }
    }
  }
  return added;
}

/**
 * tkn.near tokens get a pool whenever their owner adds liquidity on Ref DCL. For tokens still "awaiting_pool", look through the token's own
 * history for a DCL create_pool / liquidity_added / swap event naming it; the pool opening is the token's live time. Gives up after 7 days.
 */
export async function discoverTknPools(limit = 12) {
  const now = Date.now();
  const todo = await col('tokens').find({ status: 'awaiting_pool', $or: [{ pool_check_ts: null }, { pool_check_ts: { $lt: now - 10 * 60e3 } }] }).sort({ pool_check_ts: 1 }).limit(limit).toArray();
  let found = 0;
  for (const t of todo) {
    try {
      const { rows } = await accountRows(t._id, { desc: false, maxRows: 80 });
      let hit = null;
      for (const tx of await fetchTxs(rows.filter((r) => r.ok).map((r) => r.hash))) {
        if (tx.failed) continue;
        const e = tx.events.find((x) => x.executor === DCL && ['create_pool', 'liquidity_added', 'swap'].includes(x.event) && (x.data?.[0]?.pool_id || '').split('|').slice(0, 2).includes(t._id));
        if (e) { hit = { tx, poolId: e.data[0].pool_id }; break; }
      }
      if (hit) {
        const quote = hit.poolId.split('|').slice(0, 2).find((x) => x !== t._id);
        await col('tokens').updateOne({ _id: t._id }, { $set: { pool: { dex: 'dcl', poolId: hit.poolId, quote }, live_ts: hit.tx.ts, live_height: hit.tx.height, live_tx: hit.tx.hash, status: isKnownQuote(quote) ? 'new' : 'skipped_quote', next_process_ts: 0, sync_height: null, pool_check_ts: now } });
        info(`POOL ${t.launchpad} ${t.symbol || ''} ${t._id}: ${hit.poolId}`); found++;
      } else await col('tokens').updateOne({ _id: t._id }, { $set: { pool_check_ts: now, ...(now - t.created_ts > 7 * 86400e3 ? { status: 'no_pool' } : {}) } });
    } catch (e) { warn(`pool discovery for ${t._id} failed: ${e.message}`); await col('tokens').updateOne({ _id: t._id }, { $set: { pool_check_ts: now } }); }
  }
  return found;
}

/** One polling round over every configured launchpad. */
export async function discover() {
  let total = 0;
  try { total += await discoverTknPools(); } catch (e) { warn(`tkn pool discovery failed: ${e.message}`); }
  for (const name of expandPads(config.launchpads)) {
    const a = adapters[name];
    if (!a) { warn(`unknown launchpad ${name}`); continue; }
    try {
      const cursor = await metaGet(`cursor:${name}`, 0);
      const { hashes, head } = await newTxHashes(a.account, cursor ? Math.max(0, cursor - LOOKBACK_BLOCKS) : 0);
      if (!cursor) { await metaSet(`cursor:${name}`, head); info(`[${name}] following from block ${head} (use backfill for history)`); continue; }
      if (hashes.length) total += await saveLaunches(name, await fetchTxs(hashes));
      await metaSet(`cursor:${name}`, Math.max(cursor, head));
      await metaSet(`poll:${name}`, { ts: Date.now(), ok: true });
    } catch (e) { warn(`[${name}] poll failed: ${e.message}`); await metaSet(`poll:${name}`, { ts: Date.now(), ok: false, error: e.message }); }
  }
  return total;
}

/** A launchpad that moved to a new contract keeps one name in the config: justhoot also follows its v2 launcher. */
const ALIASES = { justhoot: ['justhoot_v2'] };
export const expandPads = (names) => [...new Set(names.flatMap((n) => [n, ...(ALIASES[n] || [])]))];

/** Replay a launchpad's recent history so groups can be evaluated on past launches. */
export async function backfill(launchpad, hours) {
  if (ALIASES[launchpad]) { let n = 0; for (const x of [launchpad, ...ALIASES[launchpad]]) n += await backfill(x, hours); return n; }
  const a = adapters[launchpad];
  if (!a) throw new Error(`unknown launchpad ${launchpad}`);
  const since = Date.now() - hours * 3600e3;
  const { rows } = await accountRows(a.account, { desc: true, maxRows: 40000, sinceTs: since });
  const inWindow = rows.filter((r) => r.ts >= since && r.ok);
  info(`[${launchpad}] backfill: ${inWindow.length} transactions in the last ${hours} h`);
  let added = 0;
  for (let i = 0; i < inWindow.length; i += 200) {
    added += await saveLaunches(launchpad, await fetchTxs(inWindow.slice(i, i + 200).map((r) => r.hash)));
  }
  info(`[${launchpad}] backfill: ${added} new tokens`);
  return added;
}
