// Watchlists: anyone can keep one, through the Telegram bot (one per chat), the dashboard (one per browser, an anonymous key kept in the
// browser) or the API (an API key). A watchlist holds tokens, wallets, groups, creators and NFT collections; alerts that concern any of
// them reach its owner.
import crypto from 'node:crypto';
import { col } from '../db.js';
import { alertTargets } from './store.js';

export const KINDS = ['token', 'wallet', 'group', 'creator', 'collection'];
export const MAX_ITEMS = 50;
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

/** A fresh owner key: tg owners are their chat id; web / api owners get an unguessable random key. */
export const newKey = (kind) => `${kind}_${crypto.randomBytes(16).toString('hex')}`;
export const validKey = (k) => typeof k === 'string' && /^(web|api)_[0-9a-f]{32}$|^tg_-?\d{1,20}$/.test(k);

/** What an id is: a group id, a tracked token / NFT collection, a token creator, else a wallet. Returns { kind, id } or null. */
export async function resolveTarget(raw, hint = null) {
  const id = String(raw || '').trim().toLowerCase();
  if (/^c_[0-9a-f]{8}$/.test(id)) return (await col('clusters').findOne({ _id: id }, { projection: { _id: 1 } })) ? { kind: 'group', id } : null;
  if (!ACCOUNT.test(id)) return null;
  if (hint && KINDS.includes(hint)) return { kind: hint, id };
  if (await col('tokens').findOne({ _id: id }, { projection: { _id: 1 } })) return { kind: 'token', id };
  if (await col('nft_collections').findOne({ _id: id }, { projection: { _id: 1 } })) return { kind: 'collection', id };
  if (await col('tokens').findOne({ creator: id }, { projection: { _id: 1 } })) return { kind: 'creator', id };
  return { kind: 'wallet', id };
}

export async function getWatchlist(owner) {
  return (await col('watchlists').findOne({ _id: owner })) || { _id: owner, items: [] };
}

/** Add (or remove) one item. Returns { ok, error?, items }. */
export async function setWatch(owner, target, add = true) {
  const w = await getWatchlist(owner);
  const key = `${target.kind}:${target.id}`;
  const has = w.items.some((x) => `${x.kind}:${x.id}` === key);
  if (add && !has && w.items.length >= MAX_ITEMS) return { ok: false, error: `a watchlist holds at most ${MAX_ITEMS} items`, items: w.items };
  const items = add ? (has ? w.items : [...w.items, { kind: target.kind, id: target.id, added_ts: Date.now() }]) : w.items.filter((x) => `${x.kind}:${x.id}` !== key);
  await col('watchlists').updateOne({ _id: owner }, { $set: { items, kind: owner.split('_')[0], last_seen_ts: Date.now() }, $setOnInsert: { created_ts: Date.now() } }, { upsert: true });
  return { ok: true, items };
}

/** Everything anyone watches, by kind (for detectors that only look at watched things). */
export async function watchedSets() {
  const out = Object.fromEntries(KINDS.map((k) => [k, new Set()]));
  for await (const w of col('watchlists').find({}, { projection: { items: 1 } })) for (const x of w.items || []) out[x.kind]?.add(x.id);
  return out;
}

/** Watchlists an alert reaches. */
export async function ownersFor(alert) {
  const targets = alertTargets(alert);
  if (!targets.length) return [];
  const ors = targets.map((t) => { const [kind, ...rest] = t.split(':'); return { items: { $elemMatch: { kind, id: rest.join(':') } } }; });
  return col('watchlists').find({ $or: ors }).toArray();
}

/** Alerts for one watchlist (newest first). */
export async function alertsFor(owner, { since = 0, limit = 50 } = {}) {
  const w = await getWatchlist(owner);
  if (!w.items.length) return [];
  const by = Object.fromEntries(KINDS.map((k) => [k, w.items.filter((x) => x.kind === k).map((x) => x.id)]));
  const field = { token: 'related.tokens', wallet: 'related.wallets', group: 'related.groups', creator: 'related.creators', collection: 'related.collections' };
  const ors = KINDS.filter((k) => by[k].length).map((k) => ({ [field[k]]: { $in: by[k] } }));
  return col('alerts').find({ ts: { $gt: since }, $or: ors }).sort({ ts: -1 }).limit(limit).toArray();
}
