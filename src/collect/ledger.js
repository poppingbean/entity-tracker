// Full ledger: once a token's first 24 h are read (status 'done', the window every verdict is judged on), keep reading its trades up to
// today, so its current price, all-time high and each early buyer's current ROI stay live. Verdicts and tags still use the 1 h / 6 h / 24 h
// checkpoints (entries' `roi`), so groups stay comparable; only `roi_now`, realized / unrealized now and `tokens.ledger` move.
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { syncTokenTrades } from './trades.js';
import { buildEntries, buildLedger } from './analyze.js';
import { cfgFor } from './cfg.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
const dueFilter = (now) => ({ status: 'done', $or: [{ ledger_next_ts: { $lte: now } }, { ledger_next_ts: { $exists: false } }] });

/** Read up to `passes` x LEDGER_ROWS_PER_PASS more transactions of a done token, rebuild its live numbers and early entries, schedule the next pass. */
export async function followToken(t, { passes = 1 } = {}) {
  const L = config.ledger, cfg = cfgFor(t);
  let cur = t, added = 0, caughtUp = false, lastTs = t.ledger?.synced_to_ts ?? null;
  for (let i = 0; i < passes && !caughtUp; i++) {
    if (i) cur = await col('tokens').findOne({ _id: t._id });
    const r = await syncTokenTrades(cur, { maxRows: L.rowsPerPass, full: true });
    added += r.added; caughtUp = r.reachedEnd; lastTs = r.lastTs ?? lastTs;
  }
  const fresh = await col('tokens').findOne({ _id: t._id });
  const trades = await col('trades').find({ token: t._id }).sort({ ts: 1 }).toArray();
  const now = Date.now();
  const ledger = buildLedger(fresh, trades, cfg.outcome);
  const entries = buildEntries(fresh, trades, now, cfg.entry);
  for (const e of entries) e.token_rugged = !!fresh.outcome?.rugged;
  if (entries.length) await col('entries').bulkWrite(entries.map((e) => ({ replaceOne: { filter: { _id: e._id }, replacement: e, upsert: true } })), { ordered: false });
  // next pass: at once while catching up, then by how recently it traded; stop following a token that went quiet
  const idle = now - (ledger.last_trade_ts ?? fresh.live_ts);
  let next = null, stopped = null;
  if (!caughtUp) next = now;
  else if (idle > L.stopDays * DAY) stopped = `no trades for ${L.stopDays} days`;
  else next = now + (idle > L.quietDays * DAY ? L.quietHours : L.activeHours) * HOUR;
  await col('tokens').updateOne({ _id: t._id }, { $set: {
    ledger: { ...ledger, synced_ts: now, synced_to_ts: caughtUp ? now : lastTs, caught_up: caughtUp, next_ts: next, stopped },
    ledger_next_ts: next, trades_n: trades.length,
  } });
  if (added || caughtUp && !t.ledger?.caught_up) info(`LEDGER ${fresh.symbol || ''} ${t._id}: +${added} trades, ${trades.length} stored${caughtUp ? ', up to date' : ', more to read'}${stopped ? ', following stopped (' + stopped + ')' : ''}`);
  return { added, caughtUp };
}

/** Follow the done tokens that are due, newest launch first, a few per cycle. Returns how many were followed. */
export async function followDue(limit = config.ledger.perCycle, concurrency = 2) {
  if (!config.ledger.enabled) return 0;
  const due = await col('tokens').find(dueFilter(Date.now())).sort({ live_ts: -1 }).limit(limit).toArray();
  let n = 0, idx = 0;
  const worker = async () => {
    while (idx < due.length) {
      const t = due[idx++];
      try { await followToken(t); n++; }
      catch (e) {
        warn(`ledger ${t._id} failed: ${e.message}`);
        try { await col('tokens').updateOne({ _id: t._id }, { $set: { ledger_next_ts: Date.now() + 30 * 60e3, 'ledger.error': e.message.slice(0, 300) } }); } catch {}
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  return n;
}

/** Done tokens waiting for a ledger pass (the worker skips its sleep while there are some). */
export const ledgerBacklog = () => (config.ledger.enabled ? col('tokens').countDocuments(dueFilter(Date.now())) : Promise.resolve(0));
