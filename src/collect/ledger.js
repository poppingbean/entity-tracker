// Full ledger: once a token's first 24 h are read (status 'done', the window every verdict is judged on), keep reading its trades up to
// today, so its current price, all-time high and each early buyer's current ROI stay live. Verdicts and tags still use the 1 h / 6 h / 24 h
// checkpoints (entries' `roi`), so groups stay comparable; only `roi_now`, realized / unrealized now and `tokens.ledger` move.
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { syncTokenTrades } from './trades.js';
import { buildEntries, buildLedger, buildOutcome } from './analyze.js';
import { cfgFor } from './cfg.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
const dueFilter = (now) => ({ status: 'done', $or: [{ ledger_next_ts: { $lte: now } }, { ledger_next_ts: { $exists: false } }] });

/** Read up to `passes` x LEDGER_ROWS_PER_PASS more transactions of a done token (the read position is saved after each pass). Stops
 *  early at the end of its history or at `deadline` (a timestamp). Nothing is rebuilt: call rebuildLedger once the reading is over. */
export async function readLedger(t, { passes = 1, deadline = Infinity } = {}) {
  const L = config.ledger;
  let cur = t, added = 0, caughtUp = false, lastTs = t.ledger?.synced_to_ts ?? null;
  for (let i = 0; i < passes && !caughtUp && Date.now() < deadline; i++) {
    if (i) cur = await col('tokens').findOne({ _id: t._id });
    const r = await syncTokenTrades(cur, { maxRows: L.rowsPerPass, full: true });
    added += r.added; caughtUp = r.reachedEnd; lastTs = r.lastTs ?? lastTs;
  }
  return { added, caughtUp, lastTs };
}

/** Rebuild a done token's live numbers and early entries from all its stored trades and schedule its next pass. This loads every trade,
 *  so a long catch-up should read first (readLedger) and rebuild once at the end, not after every pass. */
export async function rebuildLedger(t, { added = 0, caughtUp = false, lastTs = t.ledger?.synced_to_ts ?? null } = {}) {
  const L = config.ledger, cfg = cfgFor(t);
  const fresh = await col('tokens').findOne({ _id: t._id });
  const trades = await col('trades').find({ token: t._id }).sort({ ts: 1 }).toArray();
  const now = Date.now();
  const ledger = buildLedger(fresh, trades, cfg.outcome);
  // the rug rules read every stored trade (a creator sale after day 1 is a "creator sold" rug on its own); an old "ledger" flag is dropped
  const clear = !!(fresh.rug?.flagged && fresh.rug.source === 'ledger');
  const tok = clear ? { ...fresh, rug: null } : fresh;
  const outcome = buildOutcome(tok, trades, now, cfg.outcome); // also re-applies the current rug rules to tokens finished before they changed
  const entries = buildEntries(tok, trades, now, cfg.entry);
  for (const e of entries) e.token_rugged = outcome.rugged;
  if (entries.length) await col('entries').bulkWrite(entries.map((e) => ({ replaceOne: { filter: { _id: e._id }, replacement: e, upsert: true } })), { ordered: false });
  // next pass: at once while catching up, then by how recently it traded; stop following a token that went quiet
  const idle = now - (ledger.last_trade_ts ?? fresh.live_ts);
  let next = null, stopped = null;
  if (!caughtUp) next = now;
  else if (idle > L.stopDays * DAY) stopped = `no trades for ${L.stopDays} days`;
  else next = now + (idle > L.quietDays * DAY ? L.quietHours : L.activeHours) * HOUR;
  await col('tokens').updateOne({ _id: t._id }, { $set: {
    ledger: { ...ledger, synced_ts: now, synced_to_ts: caughtUp ? now : lastTs, caught_up: caughtUp, next_ts: next, stopped },
    ledger_next_ts: next, trades_n: trades.length, outcome,
  }, ...(clear ? { $unset: { rug: '' } } : {}) });
  if (outcome.rugged && !fresh.outcome?.rugged) info(`RUG ${fresh.symbol || ''} ${t._id}: ${outcome.rug_kinds.join(', ')} (all-time trades)`);
  if (added || caughtUp && !t.ledger?.caught_up) info(`LEDGER ${fresh.symbol || ''} ${t._id}: +${added} trades, ${trades.length} stored${caughtUp ? ', up to date' : ', more to read'}${stopped ? ', following stopped (' + stopped + ')' : ''}`);
  return { added, caughtUp };
}

/** Read up to `passes` more passes of a done token, then rebuild it and schedule its next pass. */
export async function followToken(t, { passes = 1 } = {}) {
  return rebuildLedger(t, await readLedger(t, { passes }));
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
