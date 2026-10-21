// Rugged tokens: recompute a token's outcome and early entries from the trades already stored (no network), and flag tokens known to be
// rugs from outside the price series: the scanner's dev-rug blacklist (the creator emptied their balance while a position was held).
import { col } from '../db.js';
import { info } from '../log.js';
import { buildEntries, buildOutcome, RUG_RULES_V } from './analyze.js';
import { cfgFor } from './cfg.js';

/** Rebuild one token's outcome and entries from its stored trades and write them. Returns the entries count, or null when no trades are stored. */
export async function recomputeToken(t, now = Date.now()) {
  const trades = await col('trades').find({ token: t._id }).sort({ ts: 1 }).toArray();
  if (!trades.length) return null;
  const cfg = cfgFor(t);
  const outcome = buildOutcome(t, trades, now, cfg.outcome);
  const entries = buildEntries(t, trades, now, cfg.entry);
  for (const e of entries) e.token_rugged = outcome.rugged;
  if (entries.length) await col('entries').bulkWrite(entries.map((e) => ({ replaceOne: { filter: { _id: e._id }, replacement: e, upsert: true } })), { ordered: false });
  await col('tokens').updateOne({ _id: t._id }, { $set: { outcome, entries_n: entries.length } });
  return entries.length;
}

/** Mark one token as a known rug (e.g. a creator was just blacklisted for dumping it) and refresh its outcome. */
export async function flagRug(tokenId, { source, reason, creator = null, ts = Date.now() }) {
  const r = await col('tokens').updateOne({ _id: tokenId, 'rug.flagged': { $ne: true } }, { $set: { rug: { flagged: true, source, reason: reason || null, creator, ts } } });
  if (!r.modifiedCount) return false;
  const t = await col('tokens').findOne({ _id: tokenId });
  await recomputeToken(t).catch(() => {}); // a token without stored trades picks the flag up when it is processed
  return true;
}

/** Re-apply the current rug rules to tokens whose stored outcome came from an older version of them (a token whose processing is done is not
 * recomputed otherwise, so a new rule would never reach it). Returns the number refreshed. */
export async function refreshStaleOutcomes(limit = 300) {
  const toks = await col('tokens').find({ outcome: { $exists: true }, trades_n: { $gt: 0 }, 'outcome.rules_v': { $ne: RUG_RULES_V } }).limit(limit).toArray();
  let n = 0;
  for (const t of toks) if ((await recomputeToken(t).catch(() => null)) != null) n++;
  if (n) info(`RUGS re-applied the rug rules to ${n} tokens with an older outcome`);
  return n;
}

/** Flag every token named in the blacklist that is not flagged yet. Returns the number newly flagged. */
export async function flagRugs() {
  const bl = await col('blacklist').find({ token: { $ne: null } }).toArray();
  let n = 0;
  for (const b of bl) if (await flagRug(b.token, { source: b.source || 'tracker', reason: b.reason, creator: b._id, ts: b.ts })) n++;
  if (n) info(`RUGS flagged ${n} tokens from the creator blacklist`);
  return n;
}
