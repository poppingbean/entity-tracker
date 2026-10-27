// Alert detectors, run by the worker beside its loop (alertsTick). Each raises alerts with a key unique to the event, so re-running is safe.
//   rug in progress   a token flagged rugged, its creator selling, its creator dumping its supply (dev-rug blacklist), a price collapse
//   contract changes  code hash or full-access keys of recent launches, NFT collections and anything watched
//   watched activity  a watched wallet / group buying early or selling, a watched creator launching, a rugger launching again
//   NFT               the team (or wallets it funded) selling, suspected wash trades rising
import { col, metaGet, metaSet } from '../db.js';
import { warn } from '../log.js';
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

async function rugInProgress(since) {
  const now = Date.now();
  const toks = await col('tokens').find({ live_ts: { $gt: now - RECENT_LAUNCH }, $or: [{ 'outcome.rugged': true }, { 'outcome.creator_sold': true }, { 'ledger.collapsed': true }] },
    { projection: { symbol: 1, creator: 1, live_ts: 1, outcome: 1, ledger: 1 } }).toArray();
  for (const t of toks) {
    const rel = { tokens: [t._id], creators: [t.creator], wallets: [t.creator] };
    if (t.outcome?.rugged) await raise(`rug|${t._id}`, { type: 'rug', severity: 'high', title: `${sym(t)} rugged`, url: tokUrl(t._id), related: rel,
      text: `${sym(t)} (${t._id}) is now counted as rugged: peak x${(t.outcome.peak_multiple ?? 0).toFixed(1)}, now x${(t.outcome.last_multiple ?? 0).toFixed(2)}.`, data: { peak: t.outcome.peak_multiple, now: t.outcome.last_multiple } });
    if (t.outcome?.creator_sold) await raise(`creator_sold|${t._id}`, { type: 'creator_sold', severity: 'medium', title: `${sym(t)}: the creator sold`, url: tokUrl(t._id), related: rel,
      text: `The creator ${t.creator} sold ${(t.outcome.creator_sell_near ?? 0).toFixed(1)} NEAR of ${sym(t)}.`, data: { sold_near: t.outcome.creator_sell_near } });
    if (t.ledger?.collapsed) await raise(`collapse|${t._id}`, { type: 'collapse', severity: 'high', title: `${sym(t)} collapsed`, url: tokUrl(t._id), related: rel,
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
  const fresh = await col('tokens').find({ created_ts: { $gt: since - 10 * MIN }, creator: { $ne: null } }, { projection: { symbol: 1, creator: 1, launchpad: 1, live_ts: 1, 'outcome.rugged': 1 } }).toArray();
  if (!fresh.length) return;
  const idx = await creatorIndex([...new Set(fresh.map((t) => t.creator))]);
  for (const t of fresh) {
    // its record before this launch (the index counts this token too)
    const c = idx.get(t.creator), earlierRugs = Math.max(0, (c?.rugged || 0) - (t.outcome?.rugged ? 1 : 0)), earlierLaunches = Math.max(0, (c?.launches || 1) - 1);
    const rel = { tokens: [t._id], creators: [t.creator], wallets: [t.creator] };
    if (c?.blacklisted || earlierRugs > 0) await raise(`rugger_launch|${t._id}`, { type: 'rugger_launch', severity: 'high', title: `${sym(t)}: launched by a creator that rugged before`, url: tokUrl(t._id), related: rel,
      text: `${t.creator} launched ${sym(t)} on ${t.launchpad}. Before it: ${earlierLaunches} launches, ${earlierRugs} rugged${c?.blacklisted ? ', and it is on the dev-rug blacklist' : ''}.` });
    if (watched.creator.has(t.creator) || watched.wallet.has(t.creator)) await raise(`watched_launch|${t._id}`, { type: 'watched_launch', severity: 'info', title: `${t.creator} launched ${sym(t)}`, url: tokUrl(t._id), related: rel,
      text: `A watched creator launched ${sym(t)} (${t._id}) on ${t.launchpad}.` });
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
  const entries = await col('entries').find({ wallet: { $in: wallets }, first_buy_ts: { $gt: since - 10 * MIN } }, { projection: { token: 1, wallet: 1, rank: 1, buy_near: 1, symbol: 1, delay_s: 1 } }).toArray();
  for (const e of entries) await raise(`watched_buy|${e.token}|${e.wallet}`, { type: 'watched_buy', severity: 'info', title: `${e.wallet} bought ${e.symbol || e.token} early`, url: tokUrl(e.token),
    related: { tokens: [e.token], wallets: [e.wallet], groups: [groupOf.get(e.wallet)] }, text: `Early buyer #${e.rank}, ${e.delay_s}s after launch, ${(e.buy_near ?? 0).toFixed(1)} NEAR${groupOf.get(e.wallet) ? ` (group ${groupOf.get(e.wallet)})` : ''}.` });
  const sells = await col('trades').aggregate([{ $match: { trader: { $in: wallets }, buy: false, ts: { $gt: since - 10 * MIN } } }, { $group: { _id: { t: '$token', w: '$trader' }, near: { $sum: '$near' }, last: { $max: '$ts' } } }, { $match: { near: { $gte: 2 } } }]).toArray();
  for (const s of sells) await raise(`watched_sell|${s._id.t}|${s._id.w}|${Math.floor(s.last / HOUR)}`, { type: 'watched_sell', severity: 'info', title: `${s._id.w} sold ${s._id.t}`, url: tokUrl(s._id.t),
    related: { tokens: [s._id.t], wallets: [s._id.w], groups: [groupOf.get(s._id.w)] }, text: `Sold for ${s.near.toFixed(1)} NEAR in the last pass.` });
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
      related: { collections: [id], wallets: [s.from] }, text: `${s.from} (team or team-funded) sold #${s.token_ids?.[0] ?? '?'} for ${(s.price_near ?? 0).toFixed(2)} NEAR.` });
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
  for (const [name, fn] of [['rugs', () => rugInProgress(since)], ['launches', () => launches(since, watched)], ['contracts', () => contractChanges(watched)], ['watched', () => watchedActivity(since, watched)], ['nft', () => nftSignals(since)]]) {
    try { await fn(); } catch (e) { warn(`alert detector ${name} failed: ${e.message}`); }
  }
  if (!(await metaGet('alerts:bootstrapped'))) { await col('alerts').updateMany({ delivered: false }, { $set: { delivered: true, bootstrap: true } }); await metaSet('alerts:bootstrapped', now); }
  await metaSet('alerts:cursor', now);
}
