// Token creators ("contract creators"): who launched which tokens, how many of them were rugged, and who is on the dev-rug blacklist.
// Used to flag groups that contain a creator (member wallet or any linked wallet), on the creators page, and next to every token.
import { col } from '../db.js';

/**
 * Map creator account -> { account, launches, rugged, rug_rate, blacklisted: {ts, reason, token, symbol, source} | null, tokens: [{ id, symbol, launchpad, live_ts, rugged, kinds }] }.
 * `only` limits it to a set of accounts (all creators when omitted).
 */
export async function creatorIndex(only = null) {
  const match = only ? { creator: { $in: [...only] } } : { creator: { $ne: null } };
  const rows = await col('tokens').find(match, { projection: { creator: 1, symbol: 1, launchpad: 1, live_ts: 1, 'outcome.rugged': 1, 'outcome.rug_kinds': 1, 'rug.flagged': 1 } }).sort({ live_ts: -1 }).toArray();
  const out = new Map();
  for (const t of rows) {
    const c = out.get(t.creator) || { account: t.creator, launches: 0, rugged: 0, tokens: [], blacklisted: null };
    c.launches++;
    const rugged = !!t.outcome?.rugged || !!t.rug?.flagged;
    if (rugged) c.rugged++;
    c.tokens.push({ id: t._id, symbol: t.symbol || null, launchpad: t.launchpad, live_ts: t.live_ts, rugged, kinds: t.outcome?.rug_kinds || [] });
    out.set(t.creator, c);
  }
  const bl = await col('blacklist').find(only ? { _id: { $in: [...only] } } : {}).toArray();
  for (const b of bl) {
    const c = out.get(b._id) || { account: b._id, launches: 0, rugged: 0, tokens: [], blacklisted: null };
    c.blacklisted = { ts: b.ts, reason: b.reason || null, token: b.token || null, symbol: b.symbol || null, source: b.source || 'tracker' };
    out.set(b._id, c);
  }
  for (const c of out.values()) c.rug_rate = c.launches ? c.rugged / c.launches : null;
  return out;
}

/** Short form kept on groups / wallets / token rows: what matters at a glance. */
export const creatorBrief = (c) => (c ? { launches: c.launches, rugged: c.rugged, blacklisted: !!c.blacklisted, reason: c.blacklisted?.reason || null } : null);

/** 'blacklisted' > 'rugger' (at least one rugged launch) > 'creator' (launched tokens) > null. */
export const creatorFlag = (c) => (!c ? null : c.blacklisted ? 'blacklisted' : c.rugged > 0 ? 'rugger' : c.launches > 0 ? 'creator' : null);
