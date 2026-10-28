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

/** A tracked token by its symbol ($THREE, three): the most recent launch with it. */
async function tokenBySymbol(sym) {
  const s = sym.replace(/^\$/, '');
  if (!/^[a-z0-9_-]{1,20}$/i.test(s)) return null;
  return col('tokens').findOne({ symbol: new RegExp(`^${s}$`, 'i') }, { projection: { _id: 1 }, sort: { live_ts: -1 } });
}

/** What an id is, among the things the tracker knows: a group, a tracked token (by contract or symbol), an NFT collection, a token creator,
 *  a wallet it has seen. Only tokens the tracker follows can be watched (nothing would ever be read about any other). Returns { kind, id } or null. */
export async function resolveTarget(raw, hint = null) {
  const id = String(raw || '').trim().toLowerCase();
  if (!KINDS.includes(hint)) hint = null;
  if (/^c_[0-9a-f]{8}$/.test(id)) return (!hint || hint === 'group') && (await col('clusters').findOne({ _id: id }, { projection: { _id: 1 } })) ? { kind: 'group', id } : null;
  const has = async (c, f) => !!(await col(c).findOne(f, { projection: { _id: 1 } }));
  if (!hint || hint === 'token') {
    if (await has('tokens', { _id: id })) return { kind: 'token', id };
    // a bare word is a symbol, not an account: accounts here have a dot, or are 64-hex implicit accounts
    const t = !id.includes('.') && !/^[0-9a-f]{64}$/.test(id) ? await tokenBySymbol(id) : null;
    if (t) return { kind: 'token', id: t._id };
    if (hint === 'token') return null;
  }
  if (!ACCOUNT.test(id)) return null;
  if (hint === 'wallet') return id.includes('.') || /^[0-9a-f]{64}$/.test(id) ? { kind: 'wallet', id } : null; // any real account, on purpose: its trades are read as soon as it touches a tracked token
  if ((!hint || hint === 'collection') && await has('nft_collections', { _id: id })) return { kind: 'collection', id };
  if ((!hint || hint === 'creator') && await has('tokens', { creator: id })) return { kind: 'creator', id };
  if (!hint && await has('wallets', { _id: id })) return { kind: 'wallet', id };
  return null;
}

export async function getWatchlist(owner) {
  return (await col('watchlists').findOne({ _id: owner })) || { _id: owner, items: [] };
}

/** The item on a watchlist with this exact id (any kind): what an unwatch removes. */
export async function findWatched(owner, raw, hint = null) {
  const id = String(raw || '').trim().toLowerCase();
  return (await getWatchlist(owner)).items.find((x) => x.id === id && (!hint || x.kind === hint)) || null;
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
