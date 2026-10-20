// Per-token pipeline: read new trades, rebuild the token's early entries and outcome, queue new wallets for profiling.
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { syncTokenTrades } from './trades.js';
import { buildEntries, buildOutcome } from './analyze.js';
import { cfgFor } from './cfg.js';

const MIN = 60e3;

/** Process one token. Safe to call repeatedly: everything is rebuilt from the stored trades. */
export async function processToken(t) {
  const now = Date.now();
  const sync = await syncTokenTrades(t);
  const fresh = await col('tokens').findOne({ _id: t._id });
  const trades = await col('trades').find({ token: t._id }).sort({ ts: 1 }).toArray();
  // pools that exist before trading opens (qlyphs, tkn): the token goes live at its first trade
  const cfg = cfgFor(fresh);
  if (fresh.live_on_first_trade) { // the first real trade (a dust probe does not open trading)
    const first = trades.find((x) => x.near >= cfg.entry.minNear);
    if (first && first.ts !== fresh.live_ts) { await col('tokens').updateOne({ _id: t._id }, { $set: { live_ts: first.ts } }); fresh.live_ts = first.ts; }
  }
  const outcome = buildOutcome(fresh, trades, now, cfg.outcome);
  const entries = buildEntries(fresh, trades, now, cfg.entry);
  for (const e of entries) e.token_rugged = outcome.rugged;

  if (entries.length) {
    await col('entries').bulkWrite(entries.map((e) => ({ replaceOne: { filter: { _id: e._id }, replacement: e, upsert: true } })), { ordered: false });
    // a stub per wallet; the profiler fills in funding / flows later
    await col('wallets').bulkWrite(entries.map((e) => ({ updateOne: { filter: { _id: e.wallet }, update: { $set: { is_early: true }, $setOnInsert: { _id: e.wallet, profiled: false, first_seen_ts: now, cluster_id: null } }, upsert: true } })), { ordered: false });
  }
  const ageMin = (now - fresh.live_ts) / MIN;
  const windowOpen = ageMin < config.entry.windowMinutes + 1;
  const done = sync.done && outcome.complete;
  // poll often while early buyers are still arriving, then back off
  const lastCp = config.outcome.minutes[config.outcome.minutes.length - 1];
  const wait = windowOpen ? 60e3 : done ? 0 : ageMin >= lastCp ? 0 : ageMin < 120 ? 10 * MIN : 30 * MIN; // an old token that is not fully read yet continues at once
  await col('tokens').updateOne({ _id: t._id }, { $set: {
    outcome, entries_n: entries.length, status: done ? 'done' : windowOpen ? 'entries_open' : 'tracking',
    next_process_ts: done ? null : now + wait, processed_ts: now,
  } });
  info(`PROCESSED ${fresh.symbol || ''} ${t._id}: ${entries.length} early entries, ${outcome.rugged ? 'RUG' : 'ok'}, +${sync.added} trades${done ? ', done' : ''}`);
  return { entries: entries.length, done };
}

/**
 * Process the tokens that are due, newest launch first (a fresh launch must not wait behind an old backlog), a few at a time.
 * Returns how many were processed.
 */
export async function processDue(limit = 16, concurrency = 4) {
  const due = await col('tokens').find({ status: { $nin: ['done', 'skipped_quote', 'awaiting_pool', 'no_pool'] }, next_process_ts: { $lte: Date.now() } }).sort({ live_ts: -1 }).limit(limit).toArray();
  let n = 0, idx = 0;
  const worker = async () => {
    while (idx < due.length) {
      const t = due[idx++];
      try { await processToken(t); n++; }
      catch (e) {
        warn(`process ${t._id} failed: ${e.message}`);
        try { await col('tokens').updateOne({ _id: t._id }, { $set: { next_process_ts: Date.now() + 5 * MIN, last_error: e.message.slice(0, 300) } }); } catch {} // the database itself may be the problem
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return n;
}
