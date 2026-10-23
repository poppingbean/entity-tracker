// Find new launches: follow each launchpad contract, and (backfill) replay recent history.
import { col, metaGet, metaSet } from '../db.js';
import { config } from '../config.js';
import { adapters } from '../launchpads.js';
import { fetchTxs, newTxHashes, accountRows, accountPage } from '../near/indexer.js';
import { view } from '../near/rpc.js';
import { DCL, REFV2, WNEAR, QUOTES } from '../near/quotes.js';
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

const REF_SWAP = /^Swapped (\d+) ([^\s,]+) for (\d+) ([^\s,]+)/; // "..., total fee N, admin fee N" follows
/** The Ref v2 pool id a swap in this transaction names for `token` (in an ft_transfer_call message's actions), or null. */
function refv2PoolId(tx, token) {
  for (const c of tx.calls) {
    let msg = null; try { msg = typeof c.args?.msg === 'string' ? JSON.parse(c.args.msg) : null; } catch {}
    const a = (msg?.actions || []).find((x) => x.pool_id != null && (x.token_in === token || x.token_out === token));
    if (a) return a.pool_id;
  }
  return null;
}

/** The first pool event naming `token` in these transactions: a DCL create_pool / liquidity_added / swap, or a Ref v2 swap against wNEAR. */
function poolHit(token, txs) {
  for (const tx of txs) {
    if (tx.failed) continue;
    const e = tx.events.find((x) => x.executor === DCL && ['create_pool', 'liquidity_added', 'swap'].includes(x.event) && (x.data?.[0]?.pool_id || '').split('|').slice(0, 2).includes(token));
    if (e) return { tx, pool: { dex: 'dcl', poolId: e.data[0].pool_id, quote: e.data[0].pool_id.split('|').slice(0, 2).find((x) => x !== token) } };
    const swap = tx.logs.some((l) => { const m = l.executor === REFV2 && REF_SWAP.exec(l.text); return m && ((m[2] === token && m[4] === WNEAR) || (m[2] === WNEAR && m[4] === token)); });
    if (swap) return { tx, pool: { dex: 'refv2', poolId: refv2PoolId(tx, token) ?? QUOTES[token]?.bridge?.poolId ?? null, quote: WNEAR } };
  }
  return null;
}

/**
 * tkn.near tokens get a pool whenever their owner adds liquidity: on Ref DCL, or on a classic Ref v2 pool against wNEAR (BLACKDRAGON's
 * pool #4276). Walk the token's history oldest first, page by page, up to `maxRows` transactions, for the first pool event; that
 * transaction is the token's live time. A token whose pool is already known (a quote bridge in near/quotes.js) falls back to that pool
 * when the walk finds nothing (an airdrop can fill thousands of transactions before the first trade). Returns true when a pool was stored.
 */
export async function checkTknPool(t, { maxRows = 200 } = {}) {
  const now = Date.now();
  let hit = null, resume = null, seen = 0;
  while (!hit && seen < maxRows) {
    const p = await accountPage(t._id, { desc: false, limit: Math.min(200, maxRows - seen), resume });
    seen += p.rows.length;
    hit = poolHit(t._id, await fetchTxs(p.rows.filter((r) => r.ok).map((r) => r.hash)));
    if (!p.resume || !p.rows.length) break;
    resume = p.resume;
  }
  const known = QUOTES[t._id]?.bridge;
  if (!hit && known) hit = { tx: null, pool: { ...known, quote: WNEAR } }; // keeps the token's own live time
  if (!hit) {
    await col('tokens').updateOne({ _id: t._id }, { $set: { pool_check_ts: now, ...(t.status === 'awaiting_pool' && now - t.created_ts > 7 * 86400e3 ? { status: 'no_pool' } : {}) } });
    return false;
  }
  const { quote } = hit.pool;
  await col('tokens').updateOne({ _id: t._id }, { $set: { pool: hit.pool, ...(hit.tx ? { live_ts: hit.tx.ts, live_height: hit.tx.height, live_tx: hit.tx.hash } : {}), status: isKnownQuote(quote) ? 'new' : 'skipped_quote', next_process_ts: 0, sync_height: null, pool_check_ts: now } });
  info(`POOL ${t.launchpad} ${t.symbol || ''} ${t._id}: ${hit.pool.dex} ${hit.pool.poolId ?? ''}${hit.tx ? '' : ` (known pool, not seen in its first ${seen} transactions)`}`);
  return true;
}

/** For tkn.near tokens still "awaiting_pool", look for their pool every 10 minutes; after 7 days without one a token becomes "no_pool". */
export async function discoverTknPools(limit = 12) {
  const now = Date.now();
  const todo = await col('tokens').find({ status: 'awaiting_pool', $or: [{ pool_check_ts: null }, { pool_check_ts: { $lt: now - 10 * 60e3 } }] }).sort({ pool_check_ts: 1 }).limit(limit).toArray();
  let found = 0;
  for (const t of todo) {
    try { if (await checkTknPool(t)) found++; }
    catch (e) { warn(`pool discovery for ${t._id} failed: ${e.message}`); await col('tokens').updateOne({ _id: t._id }, { $set: { pool_check_ts: now } }); }
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

/** Tokens stored as skipped_quote before their quote became a known one (QUOTES) are queued for their first sync. */
export async function requeueSkippedQuotes() {
  const r = await col('tokens').updateMany({ status: 'skipped_quote', 'pool.quote': { $in: Object.keys(QUOTES) } }, { $set: { status: 'new', next_process_ts: 0 } });
  if (r.modifiedCount) info(`re-queued ${r.modifiedCount} token(s) whose pool quote is now supported`);
  return r.modifiedCount;
}
