// NFT collections: discovery and syncing each collection's history into nft_events. The worker runs nftTick() beside its main loop.
// Discovery, fastest first: the deploy watcher (every block): a contract deployed by HOT Craft (nfts.tg) or near.cooking (nft.cookon.near,
// dnft.cookon.near) is listed in the block it appears, and any other contract the automated audit classes as an NFT when its audit is saved;
// then the platforms' own histories (names, owners, max supply), every collection NearBlocks lists, and collections added by hand.
import { col, metaGet, metaSet } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { accountRows, fetchTxs } from '../near/indexer.js';
import { view } from '../near/rpc.js';
import { nftEventsOf, isSpamCollection } from './decode.js';

const MIN = 60e3, HOUR = 3600e3;
const ROWS_PER_SYNC = 400;          // transactions read per collection per pass
const STUB_MAX_TOKENS = 20000;      // collections bigger than this are not mined for wallets to profile
export const SOURCES = { hotcraft: 'HOT Craft', cookon: 'near.cooking', deploy: 'deployed on NEAR (an NFT contract the audit found)', nearblocks: 'NearBlocks', manual: 'added by hand', market: 'traded on a followed market' };
// the platforms' factories: a contract they deploy is one of their collections
const PLATFORM_OF = { 'nfts.tg': 'hotcraft', 'nft.cookon.near': 'cookon', 'dnft.cookon.near': 'cookon' };
const COOKON = /\.(d?nft)\.cookon\.near$/;

/** Register a collection (never downgrades a richer source). */
export async function registerCollection(id, fields = {}) {
  if (!/^[a-z0-9._-]{2,64}$/.test(id)) return false;
  const r = await col('nft_collections').updateOne({ _id: id }, {
    $setOnInsert: { _id: id, created_ts: Date.now(), sync_height: null, events_n: 0, next_sync_ts: 0 },
    $set: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
  }, { upsert: true });
  if (r.upsertedCount) info(`NFT collection ${id} (${fields.source || '?'})`);
  return !!r.upsertedCount;
}

/**
 * The platform a deploy belongs to: HOT Craft (<prefix>.nfts.tg, deployed by nfts.tg) or near.cooking (<name>.nft.cookon.near /
 * <name>.dnft.cookon.near, created by those accounts' own keys with no method call: invisible to a history poller that looks for calls or
 * NFT events). Pure. Returns 'hotcraft' | 'cookon' | null.
 */
export function platformOfDeploy(d) {
  const acc = String(d?.account || ''), by = String(d?.by || d?.signer || '');
  if (PLATFORM_OF[by] && acc !== by && acc.endsWith(`.${by}`)) return PLATFORM_OF[by];
  if (/\.nfts\.tg$/.test(acc)) return 'hotcraft';
  if (COOKON.test(acc)) return 'cookon';
  return null;
}

/** Fields of a new collection from its deploy (the platform's own history or the sync fills in name, owner, max supply). */
const deployFields = (d) => ({ deployer: d.signer || d.by || null, launched_ts: d.ts || null, launch_height: d.height || null });

/**
 * The deploy watcher's deploys of one batch of blocks: the platforms' collections are listed at once (with their source). Returns how many
 * were new. Never downgrades a source a richer path already set.
 */
export async function registerPlatformDeploys(deploys) {
  if (!config.nft.enabled) return 0;
  let n = 0;
  for (const d of deploys || []) {
    const src = platformOfDeploy(d);
    if (!src) continue;
    if (await registerCollection(d.account, deployFields(d))) n++;
    await col('nft_collections').updateOne({ _id: d.account, source: { $in: [null, 'nearblocks', 'deploy', 'market'] } }, { $set: { source: src } });
  }
  return n;
}

/**
 * A contract the automated audit has just classed as an NFT collection (any factory, any deployer): listed with source 'deploy' unless a
 * platform or a person already listed it. Called when an audit is saved (audit/auto.js).
 */
export async function registerAuditedNft(account, role, deploy = null) {
  if (!config.nft.enabled || !['nft'].includes(role)) return false;
  // the audit keeps { deployer, signer } without a time: the deploy watcher's record has it
  const rec = await col('contract_deploys').find({ account }).sort({ ts: 1 }).limit(1).next().catch(() => null);
  deploy = { ...(rec || {}), ...(deploy || {}), by: deploy?.by || deploy?.deployer || rec?.by || null };
  const isNew = await registerCollection(account, deployFields(deploy));
  await col('nft_collections').updateOne({ _id: account, source: { $exists: false } }, { $set: { source: platformOfDeploy({ account, ...(deploy || {}) }) || 'deploy' } });
  return isNew;
}

/** Backfill: every NFT collection the deploy watcher saw in the last `days` (the platforms' deploys, and contracts the audit classed as NFT). */
export async function backfillNftDeploys(days = 30, { dry = false } = {}) {
  const since = Date.now() - days * 86400e3;
  const deps = await col('contract_deploys').aggregate([{ $match: { ts: { $gte: since } } }, { $sort: { ts: 1 } }, { $group: { _id: '$account', d: { $first: '$$ROOT' } } }]).toArray();
  const nftRole = new Set((await col('audits').find({ _id: { $in: deps.map((x) => x._id) }, 'auto.role': 'nft' }, { projection: { _id: 1 } }).toArray()).map((a) => a._id));
  const listed = new Set((await col('nft_collections').find({ _id: { $in: deps.map((x) => x._id) } }, { projection: { _id: 1 } }).toArray()).map((c) => c._id));
  const out = [];
  for (const { d } of deps) {
    const src = platformOfDeploy(d) || (nftRole.has(d.account) ? 'deploy' : null);
    if (!src) continue;
    out.push({ account: d.account, source: src, new: !listed.has(d.account) });
    if (dry) continue;
    if (src === 'deploy') await registerAuditedNft(d.account, 'nft', d); else await registerPlatformDeploys([d]);
  }
  return out;
}

// ---------------------------------------------------------------- discovery
/** HOT Craft: every collection is deployed by nfts.tg (deploy_contract with prefix, name, owner, max supply). */
export async function followHotCraft(maxRows = 200) {
  const cur = (await metaGet('nft:cursor:nfts.tg')) || null;
  const { rows } = await accountRows('nfts.tg', { desc: false, fromHeight: cur ? cur + 1 : undefined, maxRows });
  if (!rows.length) return 0;
  let n = 0;
  for (const t of await fetchTxs(rows.map((r) => r.hash))) for (const c of t.calls) {
    if (c.method !== 'deploy_contract' || !c.args?.prefix) continue;
    const a = c.args;
    if (await registerCollection(`${a.prefix}.nfts.tg`, { source: 'hotcraft', name: a.name, symbol: a.symbol, owner: a.owner_id, deployer: t.signer, max_supply: a.max_supply ?? null, icon: a.icon || null, launched_ts: t.ts, launch_tx: t.hash })) n++;
  }
  await metaSet('nft:cursor:nfts.tg', rows.at(-1).height);
  return n;
}

/** near.cooking: collections live under nft.cookon.near / dnft.cookon.near; its market also trades other collections. */
export async function followCookon(maxRows = 120) {
  let n = 0;
  for (const acc of ['nft.cookon.near', 'dnft.cookon.near', 'nftmarket.cookon.near']) {
    const key = `nft:cursor:${acc}`, cur = (await metaGet(key)) || null;
    const { rows } = await accountRows(acc, { desc: false, fromHeight: cur ? cur + 1 : undefined, maxRows });
    if (!rows.length) continue;
    for (const t of await fetchTxs(rows.map((r) => r.hash))) {
      // only accounts that emit NFT events or that a market call names as the NFT contract (not fee / royalty accounts it pays)
      // the creation itself has no call and no event: its receiver is the new collection
      const contracts = new Set([...t.events.filter((e) => e.standard === 'nep171').map((e) => e.executor), ...t.calls.map((c) => c.args?.nft_contract_id).filter(Boolean), t.receiver]);
      for (const x of contracts) {
        if (!x) continue;
        if (COOKON.test(x)) { if (await registerCollection(x, { source: 'cookon' })) n++; }
        else if (acc === 'nftmarket.cookon.near' && x !== acc && t.events.some((e) => e.executor === x && e.standard === 'nep171')) { if (await registerCollection(x, { source_market: 'cookon' })) { await col('nft_collections').updateOne({ _id: x, source: { $exists: false } }, { $set: { source: 'market' } }); n++; } }
      }
    }
    await metaSet(key, rows.at(-1).height);
  }
  return n;
}

/** Every NEP-171 collection: one page of NearBlocks' list per call, most active first; stats are refreshed on every pass. */
export async function discoverNearblocks(perPage = 50) {
  const page = ((await metaGet('nft:nearblocks:page')) || 0) + 1;
  const url = `${config.nft.nearblocksUrl}/v1/nfts?page=${page}&per_page=${perPage}&sort=txns_day&order=desc`;
  const res = await fetch(url, { headers: config.nft.nearblocksKey ? { authorization: `Bearer ${config.nft.nearblocksKey}` } : {}, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`NearBlocks ${res.status}`);
  const list = (await res.json()).tokens || [];
  let n = 0;
  for (const t of list) {
    const stats = { name: t.name || null, symbol: t.symbol || null, icon: t.icon && t.icon.length < 400 ? t.icon : null, nb: { tokens: Number(t.tokens) || 0, holders: Number(t.holders) || 0, transfers_day: Number(t.transfers_day) || 0, ts: Date.now() } };
    const spam = isSpamCollection({ ...stats, holders: stats.nb.holders });
    if (await registerCollection(t.contract, { ...stats, spam })) { await col('nft_collections').updateOne({ _id: t.contract, source: { $exists: false } }, { $set: { source: 'nearblocks' } }); n++; }
  }
  await metaSet('nft:nearblocks:page', list.length < perPage ? 0 : page); // wrap around at the end of the list
  return n;
}

// ---------------------------------------------------------------- sync
/** Which collections are mined in full (events + wallets): followed sources and hand-added ones always; discovered ones when active, not spam, not huge. */
export const ingestable = (c) => ['hotcraft', 'cookon', 'manual', 'market'].includes(c.source) || (c.source === 'deploy' && !c.spam) || (!c.spam && (c.nb?.transfers_day ?? 0) > 0 && (c.nb?.tokens ?? 0) <= STUB_MAX_TOKENS);

/** Read a collection's next transactions and store its NFT events. Returns { added, caughtUp }. */
export async function syncCollection(c, { maxRows = ROWS_PER_SYNC } = {}) {
  const { rows, count } = await accountRows(c._id, { desc: false, fromHeight: c.sync_height || undefined, maxRows });
  const txs = rows.length ? await fetchTxs(rows.map((r) => r.hash)) : [];
  const docs = [];
  for (const t of txs) for (const e of nftEventsOf(t, c._id)) docs.push({ _id: `${t.hash}|${c._id}|${e.idx}`, collection: c._id, ts: t.ts, height: t.height, hash: t.hash, ...e });
  if (docs.length) await col('nft_events').bulkWrite(docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
  // minters and traders become wallets to profile, so minter groups and wash trades can be read from their money links
  const people = new Set();
  for (const d of docs) if (d.kind === 'mint' || d.kind === 'sale') for (const a of [d.to, d.from, d.signer]) if (a && a !== c._id) people.add(a);
  if (people.size && (c.nb?.tokens ?? 0) <= STUB_MAX_TOKENS) {
    await col('wallets').bulkWrite([...people].map((a) => ({ updateOne: { filter: { _id: a }, update: { $set: { nft_participant: true }, $setOnInsert: { _id: a, profiled: false, first_seen_ts: Date.now(), cluster_id: null } }, upsert: true } })), { ordered: false });
  }
  const caughtUp = rows.length < maxRows;
  const last = rows.at(-1);
  const recent = docs.length && Date.now() - docs.at(-1).ts < 24 * HOUR;
  await col('nft_collections').updateOne({ _id: c._id }, { $set: { sync_height: last ? last.height : c.sync_height, sync_ts: Date.now(), txs_n: count ?? c.txs_n ?? null, caught_up: caughtUp,
    next_sync_ts: caughtUp ? Date.now() + (recent ? 10 * MIN : 2 * HOUR) : 0, last_event_ts: docs.at(-1)?.ts ?? c.last_event_ts ?? null }, $inc: { events_n: docs.length } });
  if (!c.supply_ts || Date.now() - c.supply_ts > 6 * HOUR) {
    const [supply, meta] = await Promise.all([view(c._id, 'nft_total_supply').catch(() => null), c.name ? null : view(c._id, 'nft_metadata').catch(() => null)]);
    await col('nft_collections').updateOne({ _id: c._id }, { $set: { supply: supply != null ? Number(supply) : null, supply_ts: Date.now(), ...(meta ? { name: meta.name || null, symbol: meta.symbol || null } : {}) } });
  }
  return { added: docs.length, caughtUp };
}

/** Collections due for a sync, followed sources first. */
async function syncDue(limit) {
  const due = await col('nft_collections').find({ next_sync_ts: { $lte: Date.now() }, spam: { $ne: true } }).sort({ next_sync_ts: 1 }).limit(200).toArray();
  const rank = (c) => ({ manual: 0, hotcraft: 1, cookon: 1, market: 2, deploy: 2 }[c.source] ?? 3);
  const todo = due.filter(ingestable).sort((a, b) => rank(a) - rank(b)).slice(0, limit);
  let n = 0;
  for (const c of todo) { try { await syncCollection(c); n++; } catch (e) { warn(`NFT sync ${c._id} failed: ${e.message}`); await col('nft_collections').updateOne({ _id: c._id }, { $set: { next_sync_ts: Date.now() + 15 * MIN, sync_error: e.message.slice(0, 200) } }); } }
  return n;
}

const last = { hotcraft: 0, cookon: 0, nearblocks: 0 };
/** One NFT pass: discovery on its own cadence, then a few collection syncs. */
export async function nftTick() {
  if (!config.nft.enabled) return { found: 0, synced: 0 };
  const now = Date.now();
  let found = 0;
  const step = async (k, every, fn) => { if (now - last[k] < every) return; last[k] = now; try { found += await fn(); } catch (e) { warn(`NFT discovery ${k} failed: ${e.message}`); } };
  await step('hotcraft', 2 * MIN, followHotCraft);
  await step('cookon', 2 * MIN, followCookon);
  await step('nearblocks', config.nft.nearblocksEveryMs, discoverNearblocks);
  const synced = await syncDue(config.nft.syncPerTick);
  return { found, synced };
}
