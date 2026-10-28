// Alerts: one record per event, keyed so the same event is never raised twice. Each alert names what it concerns (tokens, wallets,
// groups, creators, NFT collections) so watchlists can match it, and is delivered by alerts/deliver.js.
import { col } from '../db.js';
import { info } from '../log.js';

export const SEVERITIES = ['high', 'medium', 'info'];
export const TYPES = {
  rug: { label: 'Rugged', group: 'rug' },
  creator_sold: { label: 'Creator sold', group: 'rug' },
  creator_blacklisted: { label: 'Creator dumped its supply', group: 'rug' },
  collapse: { label: 'Price collapse', group: 'rug' },
  rugger_launch: { label: 'Rugger launched again', group: 'activity' },
  code_changed: { label: 'Contract code changed', group: 'contract' },
  full_access_key: { label: 'New full-access key', group: 'contract' },
  watched_buy: { label: 'Watched wallet bought early', group: 'activity' },
  watched_sell: { label: 'Watched wallet sold', group: 'activity' },
  watched_launch: { label: 'Watched creator launched', group: 'activity' },
  token_big_sell: { label: 'Large sell', group: 'activity' },
  token_creator_sell: { label: 'Creator selling', group: 'rug' },
  token_price_drop: { label: 'Fast price drop', group: 'rug' },
  token_transfer: { label: 'Large transfer', group: 'activity' },
  nft_team_sell: { label: 'NFT team selling', group: 'nft' },
  nft_wash: { label: 'NFT wash trades', group: 'nft' },
};

/**
 * Raise an alert once. `key` identifies the event (a second call with the same key does nothing).
 * related: { tokens, wallets, groups, creators, collections } (arrays of ids) - what a watchlist can match.
 * Returns true when the alert is new.
 */
export async function raise(key, { type, severity = 'medium', title, text, url = null, related = {}, data = null, ts = Date.now() }) {
  if (!TYPES[type]) throw new Error(`unknown alert type ${type}`);
  const rel = Object.fromEntries(['tokens', 'wallets', 'groups', 'creators', 'collections'].map((k) => [k, [...new Set((related[k] || []).filter(Boolean))].slice(0, 50)]));
  const r = await col('alerts').updateOne({ _id: key }, { $setOnInsert: { _id: key, ts, type, severity, title: String(title).slice(0, 200), text: String(text || '').slice(0, 1200), url, related: rel, data, delivered: false } }, { upsert: true });
  if (r.upsertedCount) info(`ALERT ${severity} ${type}: ${title}`);
  return !!r.upsertedCount;
}

/** Every id an alert concerns, as watchlist items ("kind:id"). */
export const alertTargets = (a) => Object.entries({ token: a.related?.tokens, wallet: a.related?.wallets, group: a.related?.groups, creator: a.related?.creators, collection: a.related?.collections })
  .flatMap(([k, ids]) => (ids || []).map((id) => `${k}:${id}`));
