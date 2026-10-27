// NFT collections: discovery (HOT Craft, near.cooking, every collection NearBlocks lists, or added by hand) and syncing each collection's
// history into nft_events. The worker runs nftTick() beside its main loop.
import { col, metaGet, metaSet } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { accountRows, fetchTxs } from '../near/indexer.js';
import { view } from '../near/rpc.js';
import { nftEventsOf, isSpamCollection } from './decode.js';

const MIN = 60e3, HOUR = 3600e3;
const ROWS_PER_SYNC = 400;          // transactions read per collection per pass
const STUB_MAX_TOKENS = 20000;      // collections bigger than this are not mined for wallets to profile
export const SOURCES = { hotcraft: 'HOT Craft', cookon: 'near.cooking', nearblocks: 'NearBlocks', manual: 'added by hand', market: 'traded on a followed market' };
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
      const contracts = new Set([...t.events.filter((e) => e.standard === 'nep171').map((e) => e.executor), ...t.calls.map((c) => c.args?.nft_contract_id).filter(Boolean)]);
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
export const ingestable = (c) => ['hotcraft', 'cookon', 'manual', 'market'].includes(c.source) || (!c.spam && (c.nb?.transfers_day ?? 0) > 0 && (c.nb?.tokens ?? 0) <= STUB_MAX_TOKENS);

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
  const rank = (c) => ({ manual: 0, hotcraft: 1, cookon: 1, market: 2 }[c.source] ?? 3);
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
