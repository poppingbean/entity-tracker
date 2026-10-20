// Find new launches: follow each launchpad contract, and (backfill) replay recent history.
import { col, metaGet, metaSet } from '../db.js';
import { config } from '../config.js';
import { adapters } from '../launchpads.js';
import { fetchTxs, newTxHashes, accountRows } from '../near/indexer.js';
import { info, warn } from '../log.js';
import { isKnownQuote } from '../near/quotes.js';

const LOOKBACK_BLOCKS = 300; // re-read a little so a transaction the index listed late is not missed (inserts are idempotent)

async function saveLaunches(launchpad, txs) {
  let added = 0;
  for (const tx of txs) {
    if (tx.failed) continue;
    for (const l of adapters[launchpad].parse(tx)) {
      const doc = {
        launchpad, creator: l.creator, symbol: l.symbol || null, name: l.name || null, meme_id: l.memeId ?? null, pool: l.pool,
        live_ts: tx.ts, live_height: tx.height, live_tx: tx.hash, status: isKnownQuote(l.pool.quote) ? 'new' : 'skipped_quote', // pools quoted in other memecoins cannot be valued in NEAR
         sync_height: null, sync_ts: null, trades_n: 0, created_ts: Date.now(), next_process_ts: 0,
      };
      const r = await col('tokens').updateOne({ _id: l.token }, { $setOnInsert: doc }, { upsert: true });
      if (r.upsertedCount) { added++; info(`NEW ${launchpad} ${l.symbol || ''} ${l.token}`); }
    }
  }
  return added;
}

/** One polling round over every configured launchpad. */
export async function discover() {
  let total = 0;
  for (const name of config.launchpads) {
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

/** Replay a launchpad's recent history so groups can be evaluated on past launches. */
export async function backfill(launchpad, hours) {
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
