// Alert detectors, run by the worker beside its loop (alertsTick). Each raises alerts with a key unique to the event, so re-running is safe.
//   rug in progress   a token flagged rugged, its creator selling, its creator dumping its supply (dev-rug blacklist), a price collapse
//   contract changes  code hash or full-access keys of recent launches, NFT collections and anything watched
//   watched activity  a watched wallet / group buying early or selling, a watched creator launching, a rugger launching again
//   watched tokens    trades re-read every few minutes: large sells, large wallet-to-wallet transfers, the creator selling, a fast price drop
//                     (and the rug checks at any age)
//   NFT               the team (or wallets it funded) selling, suspected wash trades rising
import { col, metaGet, metaSet } from '../db.js';
import { config } from '../config.js';
import { warn } from '../log.js';
import { followToken } from '../collect/ledger.js';
import { priceSeries } from '../collect/analyze.js';
import { tokenSupply, lastPrice } from '../collect/supply.js';
import { INFRA } from '../collect/trades.js';
import { builtinLabel } from '../labels.js';
import { viewAccount, viewAccessKeyList } from '../audit/rpc.js';
import { creatorIndex } from '../evaluate/creators.js';
import { getNftAnalysis } from '../nft/analysis.js';
import { raise } from './store.js';
import { watchedSets } from './watch.js';

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const RECENT_LAUNCH = 3 * DAY;      // rug / contract watch covers launches this recent (plus anything watched)
const CONTRACT_EVERY = 30 * MIN;    // code hash / access keys re-read this often per contract
const sym = (t) => t.symbol || t._id;
const tokUrl = (id) => `/tokens/${encodeURIComponent(id)}`;

/** Rug flags that turned on between two readings of a token (an old token's long-standing state is not news). */
export function flagChanges(prev, cur) {
  return prev ? Object.keys(cur).filter((k) => cur[k] && !prev[k]) : [];
}
const flagsOf = (t) => ({ rugged: !!t.outcome?.rugged, creator_sold: !!t.outcome?.creator_sold, collapsed: !!t.ledger?.collapsed });

async function rugInProgress(since, watched) {
  const now = Date.now();
  const proj = { projection: { symbol: 1, creator: 1, live_ts: 1, outcome: 1, ledger: 1 } };
  const toks = await col('tokens').find({ live_ts: { $gt: now - RECENT_LAUNCH }, $or: [{ 'outcome.rugged': true }, { 'outcome.creator_sold': true }, { 'ledger.collapsed': true }] }, proj).toArray();
  // watched tokens older than that: their flags are recorded on the first pass and only a flag that turns on later is an alert
  // (a two-year-old token far below an old all-time high is "collapsed", but nothing is happening now)
  const old = watched.token.size ? await col('tokens').find({ _id: { $in: [...watched.token] }, live_ts: { $lte: now - RECENT_LAUNCH } }, proj).toArray() : [];
  const seen = new Map((await col('token_flags').find({ _id: { $in: old.map((t) => t._id) } }).toArray()).map((f) => [f._id, f.flags]));
  for (const t of old) {
    const cur = flagsOf(t), on = flagChanges(seen.get(t._id), cur);
    if (on.length) toks.push({ ...t, only: new Set(on), keySuffix: `|${now}` });
    await col('token_flags').replaceOne({ _id: t._id }, { _id: t._id, flags: cur, ts: now }, { upsert: true });
  }
  for (const t of toks) {
    const rel = { tokens: [t._id], creators: [t.creator], wallets: [t.creator] };
    const want = (k) => !t.only || t.only.has(k), sfx = t.keySuffix || '';
    if (t.outcome?.rugged && want('rugged')) await raise(`rug|${t._id}${sfx}`, { type: 'rug', severity: 'high', title: `${sym(t)} rugged`, url: tokUrl(t._id), related: rel,
      text: `${sym(t)} (${t._id}) is now counted as rugged: peak x${(t.outcome.peak_multiple ?? 0).toFixed(1)}, now x${(t.outcome.last_multiple ?? 0).toFixed(2)}.`, data: { peak: t.outcome.peak_multiple, now: t.outcome.last_multiple } });
    const creatorSell = t.outcome?.creator_sold && want('creator_sold') ? await col('trades').findOne({ token: t._id, trader: t.creator, buy: false }, { sort: { ts: -1 }, projection: { hash: 1 } }) : null;
    if (t.outcome?.creator_sold && want('creator_sold')) await raise(`creator_sold|${t._id}${sfx}`, { type: 'creator_sold', severity: 'medium', title: `${sym(t)}: the creator sold`, url: tokUrl(t._id), related: rel,
      text: `The creator ${t.creator} sold ${(t.outcome.creator_sell_near ?? 0).toFixed(1)} NEAR of ${sym(t)}.`, data: { sold_near: t.outcome.creator_sell_near, hash: creatorSell?.hash } });
    if (t.ledger?.collapsed && want('collapsed')) await raise(`collapse|${t._id}${sfx}`, { type: 'collapse', severity: 'high', title: `${sym(t)} collapsed`, url: tokUrl(t._id), related: rel,
      text: `${sym(t)} is ${((t.ledger.drawdown ?? 0) * 100).toFixed(0)}% below its all-time high (x${(t.ledger.ath_multiple ?? 0).toFixed(1)}).`, data: { drawdown: t.ledger.drawdown } });
  }
  // the dev-rug check: a creator emptied its balance while a position was held
  for (const b of await col('blacklist').find({ ts: { $gt: since - HOUR } }).toArray()) {
    await raise(`creator_blacklisted|${b._id}|${b.token || ''}`, { type: 'creator_blacklisted', severity: 'high', title: `${b.symbol || b.token || b._id}: the creator dumped its supply`,
      url: b.token ? tokUrl(b.token) : `/creators/${encodeURIComponent(b._id)}`, related: { tokens: [b.token], creators: [b._id], wallets: [b._id] }, text: `${b._id} is on the dev-rug blacklist: ${b.reason || 'its balance fell while a position was held'}.` });
  }
}

/** New launches by creators that rugged before / are blacklisted (everyone), or that someone watches. */
async function launches(since, watched) {
  const fresh = await col('tokens').find({ created_ts: { $gt: since - 10 * MIN }, creator: { $ne: null } }, { projection: { symbol: 1, creator: 1, launchpad: 1, live_ts: 1, live_tx: 1, 'outcome.rugged': 1 } }).toArray();
  if (!fresh.length) return;
  const idx = await creatorIndex([...new Set(fresh.map((t) => t.creator))]);
  for (const t of fresh) {
    // its record before this launch (the index counts this token too)
    const c = idx.get(t.creator), earlierRugs = Math.max(0, (c?.rugged || 0) - (t.outcome?.rugged ? 1 : 0)), earlierLaunches = Math.max(0, (c?.launches || 1) - 1);
    const rel = { tokens: [t._id], creators: [t.creator], wallets: [t.creator] };
    if (c?.blacklisted || earlierRugs > 0) await raise(`rugger_launch|${t._id}`, { type: 'rugger_launch', severity: 'high', title: `${sym(t)}: launched by a creator that rugged before`, url: tokUrl(t._id), related: rel,
      text: `${t.creator} launched ${sym(t)} on ${t.launchpad}. Before it: ${earlierLaunches} launches, ${earlierRugs} rugged${c?.blacklisted ? ', and it is on the dev-rug blacklist' : ''}.`, data: { hash: t.live_tx } });
    if (watched.creator.has(t.creator) || watched.wallet.has(t.creator)) await raise(`watched_launch|${t._id}`, { type: 'watched_launch', severity: 'info', title: `${t.creator} launched ${sym(t)}`, url: tokUrl(t._id), related: rel,
      text: `A watched creator launched ${sym(t)} (${t._id}) on ${t.launchpad}.`, data: { hash: t.live_tx } });
  }
}

/** Code hash and full-access keys of recent launches, followed NFT collections and anything watched: alert on a change. */
async function contractChanges(watched, limit = 25) {
  const now = Date.now();
  const recent = (await col('tokens').find({ live_ts: { $gt: now - RECENT_LAUNCH } }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
  const nfts = (await col('nft_collections').find({ source: { $in: ['hotcraft', 'cookon', 'manual'] }, last_event_ts: { $gt: now - 7 * DAY } }, { projection: { _id: 1 } }).toArray()).map((c) => c._id);
  const ids = [...new Set([...watched.token, ...watched.collection, ...recent, ...nfts])];
  const states = new Map((await col('contract_state').find({ _id: { $in: ids } }).toArray()).map((s) => [s._id, s]));
  const due = ids.filter((id) => !states.get(id) || now - states.get(id).ts > CONTRACT_EVERY).slice(0, limit);
  for (const id of due) {
    try {
      const [acc, keys] = await Promise.all([viewAccount(id), viewAccessKeyList(id)]);
      const full = (keys?.keys || keys || []).filter((k) => k.access_key?.permission === 'FullAccess').map((k) => k.public_key).sort();
      const cur = { _id: id, code_hash: acc?.code_hash ?? null, full_keys: full, ts: now };
      const prev = states.get(id);
      const isNft = nfts.includes(id) || watched.collection.has(id);
      const rel = isNft ? { collections: [id] } : { tokens: [id] };
      const url = isNft ? `/nfts/${encodeURIComponent(id)}` : tokUrl(id);
      if (prev && prev.code_hash && cur.code_hash && prev.code_hash !== cur.code_hash) await raise(`code_changed|${id}|${cur.code_hash}`, { type: 'code_changed', severity: 'high', title: `${id}: contract code changed`, url, related: rel,
        text: `The contract was redeployed (code hash ${prev.code_hash.slice(0, 8)}… → ${cur.code_hash.slice(0, 8)}…). An upgrade can change fees, freeze transfers or drain holders.`, data: { from: prev.code_hash, to: cur.code_hash } });
      const added = prev ? full.filter((k) => !prev.full_keys.includes(k)) : [];
      if (added.length) await raise(`full_access_key|${id}|${added.join(',')}`, { type: 'full_access_key', severity: 'high', title: `${id}: new full-access key`, url, related: rel,
        text: `${added.length} new full-access key(s) on the contract: whoever holds it can redeploy the code or move the contract's funds.`, data: { added } });
      await col('contract_state').replaceOne({ _id: id }, cur, { upsert: true });
    } catch (e) { await col('contract_state').updateOne({ _id: id }, { $set: { ts: now, error: e.message.slice(0, 120) } }, { upsert: true }); }
  }
}

/** Watched wallets / groups: early buys and sells since the last pass. */
async function watchedActivity(since, watched) {
  if (!watched.wallet.size && !watched.group.size) return;
  const groupMembers = watched.group.size ? await col('wallets').find({ cluster_id: { $in: [...watched.group] } }, { projection: { cluster_id: 1 } }).toArray() : [];
  const groupOf = new Map(groupMembers.map((w) => [w._id, w.cluster_id]));
  const wallets = [...new Set([...watched.wallet, ...groupOf.keys()])];
  const entries = await col('entries').find({ wallet: { $in: wallets }, first_buy_ts: { $gt: since - 10 * MIN } }, { projection: { token: 1, wallet: 1, rank: 1, buy_near: 1, symbol: 1, delay_s: 1, first_buy_hash: 1 } }).toArray();
  for (const e of entries) await raise(`watched_buy|${e.token}|${e.wallet}`, { type: 'watched_buy', severity: 'info', title: `${e.wallet} bought ${e.symbol || e.token} early`, url: tokUrl(e.token),
    related: { tokens: [e.token], wallets: [e.wallet], groups: [groupOf.get(e.wallet)] }, text: `Early buyer #${e.rank}, ${e.delay_s}s after launch, ${(e.buy_near ?? 0).toFixed(1)} NEAR${groupOf.get(e.wallet) ? ` (group ${groupOf.get(e.wallet)})` : ''}.`, data: { hash: e.first_buy_hash } });
  const sells = await col('trades').aggregate([{ $match: { trader: { $in: wallets }, buy: false, ts: { $gt: since - 10 * MIN } } }, { $sort: { ts: 1 } }, { $group: { _id: { t: '$token', w: '$trader' }, near: { $sum: '$near' }, last: { $max: '$ts' }, hash: { $last: '$hash' } } }, { $match: { near: { $gte: 2 } } }]).toArray();
  for (const s of sells) await raise(`watched_sell|${s._id.t}|${s._id.w}|${Math.floor(s.last / HOUR)}`, { type: 'watched_sell', severity: 'info', title: `${s._id.w} sold ${s._id.t}`, url: tokUrl(s._id.t),
    related: { tokens: [s._id.t], wallets: [s._id.w], groups: [groupOf.get(s._id.w)] }, text: `Sold for ${s.near.toFixed(1)} NEAR in the last pass.`, data: { hash: s.hash } });
}

/** Signals in a watched token's recent trades (oldest first). Pure: returns [{ key, type, severity, title, text, data }]. */
export function tokenSignals(t, trades, { bigSellNear = 25, priceDrop = 0.3, now = Date.now() } = {}) {
  const out = [], name = t.symbol || t._id;
  for (const x of trades) {
    if (x.buy || !(x.near > 0)) continue;
    if (t.creator && x.trader === t.creator) out.push({ key: `token_creator_sell|${t._id}|${x._id}`, type: 'token_creator_sell', severity: 'high', title: `${name}: the creator is selling`,
      text: `The creator ${x.trader} sold ${x.near.toFixed(1)} NEAR of ${name}.`, data: { near: x.near, hash: x.hash } });
    else if (x.near >= bigSellNear) out.push({ key: `token_big_sell|${t._id}|${x._id}`, type: 'token_big_sell', severity: 'medium', title: `${name}: ${x.near.toFixed(0)} NEAR sell`,
      text: `${x.trader} sold ${x.near.toFixed(1)} NEAR of ${name}.`, data: { near: x.near, trader: x.trader, hash: x.hash } });
  }
  // fast drop: the last price against the highest of the hour before it
  const s = priceSeries(trades);
  if (s.length >= 2) {
    const last = s[s.length - 1], hi = Math.max(...s.filter((p) => p.ts >= last.ts - HOUR).map((p) => p.price));
    const drop = 1 - last.price / hi;
    if (drop >= priceDrop && now - last.ts < 2 * HOUR) out.push({ key: `token_price_drop|${t._id}|${Math.floor(last.ts / HOUR)}`, type: 'token_price_drop', severity: 'high', title: `${name}: down ${(drop * 100).toFixed(0)}% within an hour`,
      text: `${name} fell ${(drop * 100).toFixed(0)}% from its high of the last hour.`, data: { drop } });
  }
  return out;
}

/**
 * Large wallet-to-wallet moves of a watched token (not sales: venues are left out when transfers are stored), oldest first. Pure.
 * Large = worth at least minNear at the last price, or at least minShare of the supply. The creator moving tokens is high; a move to an
 * exchange is said so (a deposit before selling there).
 */
export function transferSignals(t, transfers, { price = null, supply = null, minNear = 250, minShare = 0.01 } = {}) {
  const out = [], name = t.symbol || t._id, fmt = (x) => Math.round(x).toLocaleString('en-US');
  for (const x of transfers) {
    if (INFRA.test(x.from) || INFRA.test(x.to)) continue; // swaps through a router or app, fees: not a hand-off (older stored rows)
    const near = price != null ? x.tokens * price : null, share = supply ? x.tokens / supply : null;
    if (!((near != null && near >= minNear) || (share != null && share >= minShare))) continue;
    const fromCreator = !!t.creator && x.from === t.creator, ex = builtinLabel(x.to);
    const toEx = ex?.type === 'exchange' ? ` to ${ex.label}` : '';
    const what = [near != null ? `~${fmt(near)} NEAR` : null, share != null ? `${(share * 100).toFixed(share < 0.1 ? 2 : 1)}% of supply` : null].filter(Boolean).join(', ');
    out.push({ key: `token_transfer|${t._id}|${x._id}`, type: 'token_transfer', severity: fromCreator ? 'high' : 'medium',
      title: `${name}: ${fromCreator ? 'the creator moved' : 'large transfer of'} ${fmt(x.tokens)} tokens${toEx}`,
      text: `${x.from} sent ${fmt(x.tokens)} ${name} (${what}) to ${x.to}${ex ? ` (${ex.label})` : ''} without selling: a move to another wallet${toEx ? ' or an exchange deposit' : ''}, often before a sale.`,
      data: { from: x.from, to: x.to, tokens: x.tokens, near, share, hash: x.hash, from_creator: fromCreator || undefined } });
  }
  return out;
}

/** Watched tokens: re-read their trades every few minutes (a few per pass), then raise tokenSignals on the last 6 hours (each event once). */
async function watchedTokens(watched, limit = 4) {
  if (!watched.token.size) return;
  const now = Date.now(), A = config.alerts;
  const toks = await col('tokens').find({ _id: { $in: [...watched.token] } }, { projection: { symbol: 1, creator: 1, status: 1, ledger: 1 } }).toArray();
  // tokens past their first 24 h are only re-read by the ledger every few hours: read the watched ones now (live ones are read by the loop)
  const due = toks.filter((t) => t.status === 'done' && now - (t.ledger?.synced_ts ?? 0) > A.watchSyncMinutes * MIN)
    .sort((a, b) => (a.ledger?.synced_ts ?? 0) - (b.ledger?.synced_ts ?? 0)).slice(0, limit);
  for (const t of due) await followToken(await col('tokens').findOne({ _id: t._id })).catch((e) => warn(`watched token ${t._id}: ${e.message}`));
  for (const t of toks) {
    const trades = await col('trades').find({ token: t._id, ts: { $gt: now - 6 * HOUR } }, { projection: { trader: 1, buy: 1, near: 1, tokens: 1, ts: 1, hash: 1 } }).sort({ ts: 1 }).toArray();
    for (const s of tokenSignals(t, trades, { bigSellNear: A.bigSellNear, priceDrop: A.priceDrop, now }))
      await raise(s.key, { type: s.type, severity: s.severity, title: s.title, text: s.text, data: s.data, url: tokUrl(t._id),
        related: { tokens: [t._id], creators: [t.creator], wallets: s.data.trader ? [s.data.trader] : [] } });
    const moves = await col('transfers').find({ token: t._id, ts: { $gt: now - 6 * HOUR } }, { projection: { from: 1, to: 1, tokens: 1, ts: 1, hash: 1 } }).sort({ ts: 1 }).toArray();
    if (!moves.length) continue;
    const [supply, last] = await Promise.all([tokenSupply(t._id), lastPrice(t._id)]);
    for (const s of transferSignals(t, moves, { price: last?.price ?? null, supply, minNear: A.bigTransferNear, minShare: A.bigTransferShare }))
      await raise(s.key, { type: s.type, severity: s.severity, title: s.title, text: s.text, data: s.data, url: tokUrl(t._id),
        related: { tokens: [t._id], creators: [t.creator], wallets: [s.data.from, s.data.to] } });
  }
}

/** NFT collections with new sales: the team (or wallets it funded) selling, suspected wash trades rising. */
async function nftSignals(since, limit = 5) {
  const active = await col('nft_events').aggregate([{ $match: { kind: 'sale', ts: { $gt: since - 10 * MIN } } }, { $group: { _id: '$collection', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: limit }]).toArray();
  for (const { _id: id } of active) {
    const a = await getNftAnalysis(id, { refresh: true }).catch(() => null); if (!a) continue;
    const name = a.info.name || id, url = `/nfts/${encodeURIComponent(id)}`;
    const team = new Set([...a.team.accounts, ...a.team.minters.map((m) => m.wallet)]);
    const sales = await col('nft_events').find({ collection: id, kind: 'sale', ts: { $gt: since - 10 * MIN } }, { projection: { from: 1, to: 1, price_near: 1, token_ids: 1, hash: 1 } }).toArray();
    for (const s of sales.filter((x) => team.has(x.from))) await raise(`nft_team_sell|${s.hash}|${s.from}`, { type: 'nft_team_sell', severity: 'medium', title: `${name}: the team sold`, url,
      related: { collections: [id], wallets: [s.from] }, text: `${s.from} (team or team-funded) sold #${s.token_ids?.[0] ?? '?'} for ${(s.price_near ?? 0).toFixed(2)} NEAR.`, data: { hash: s.hash, price_near: s.price_near } });
    const c = await col('nft_collections').findOne({ _id: id }, { projection: { alert_wash: 1 } });
    if (a.market.wash.sales > (c?.alert_wash ?? 0)) {
      if ((c?.alert_wash ?? 0) > 0 || a.market.wash.sales >= 2) await raise(`nft_wash|${id}|${a.market.wash.sales}`, { type: 'nft_wash', severity: a.market.wash.share >= 0.2 ? 'high' : 'medium', title: `${name}: ${a.market.wash.sales} suspected wash trades`, url,
        related: { collections: [id] }, text: `${a.market.wash.sales} sales (${((a.market.wash.share || 0) * 100).toFixed(0)}% of the volume) look like wash trades: money-linked buyer and seller, a buyer funded by its seller, or round trips.` });
      await col('nft_collections').updateOne({ _id: id }, { $set: { alert_wash: a.market.wash.sales } });
    }
  }
}

/** One pass of every detector. The first pass ever only records the current state (nothing is sent for the past). */
export async function detectAll() {
  const now = Date.now();
  const since = (await metaGet('alerts:cursor')) || now - 6 * HOUR;
  const watched = await watchedSets();
  for (const [name, fn] of [['rugs', () => rugInProgress(since, watched)], ['tokens', () => watchedTokens(watched)], ['launches', () => launches(since, watched)], ['contracts', () => contractChanges(watched)], ['watched', () => watchedActivity(since, watched)], ['nft', () => nftSignals(since)]]) {
    try { await fn(); } catch (e) { warn(`alert detector ${name} failed: ${e.message}`); }
  }
  if (!(await metaGet('alerts:bootstrapped'))) { await col('alerts').updateMany({ delivered: false }, { $set: { delivered: true, bootstrap: true } }); await metaSet('alerts:bootstrapped', now); }
  await metaSet('alerts:cursor', now);
}
