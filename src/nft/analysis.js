// On-chain analysis of one NFT collection, laid out like the hand-made NFT investigations (NEAR Dragons, Cosmic Kats): the mint (who minted,
// what it raised, where the money went, the team's own mints), minters grouped by money links, the secondary market with wash-trade
// checks, holders, and risk notes. Built from nft_events plus the profiled minters / traders. Cached in nft_analyses.
import { col } from '../db.js';
import { config } from '../config.js';
import { buildGroups } from '../graph/cluster.js';
import { serviceSet, isService } from '../graph/services.js';
import { isGenericKind } from '../graph/profile.js';
import { ownersOf } from './decode.js';
import { SOURCES } from './sync.js';
import { looksLikeInjection } from '../ai/untrusted.js';

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
export const CACHE_MS = 15 * MIN;
const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + (f(x) || 0), 0);

/** Accounts on a wallet's money trail that tie it to `targets`: its funders, its funding chain, where it sent NEAR. */
function tiesTo(w, targets) {
  if (!w) return null;
  for (const f of w.funders || []) if (targets.has(f.account)) return { via: 'funded by', account: f.account };
  for (const c of w.chain || []) { if (targets.has(c.account)) return { via: 'funding chain', account: c.account }; if (isGenericKind(c.kind)) break; }
  for (const f of w.flow_out || []) if (targets.has(f.to)) return { via: 'sent NEAR to', account: f.to };
  return null;
}

export async function buildNftAnalysis(id) {
  const c = await col('nft_collections').findOne({ _id: id });
  if (!c) return null;
  const events = await col('nft_events').find({ collection: id }).sort({ ts: 1, _id: 1 }).toArray();
  const mints = events.filter((e) => e.kind === 'mint'), sales = events.filter((e) => e.kind === 'sale');
  const people = [...new Set(events.filter((e) => e.kind !== 'burn').flatMap((e) => [e.to, e.from]).filter((a) => a && a !== id))];
  const [docs, ents] = await Promise.all([
    col('wallets').find({ _id: { $in: people } }, { projection: { funders: 1, chain: 1, flow_out: 1, kind: 1, created_ts: 1, profiled: 1, tag: 1, cluster_id: 1, cluster_tag: 1, creator: 1 } }).toArray(),
    col('entities').find({ type: { $in: ['service', 'exchange', 'bridge', 'fund'] } }, { projection: { type: 1 } }).toArray(),
  ]);
  const wmap = new Map(docs.map((w) => [w._id, w]));
  // the collection itself and every market / minter it trades through pay sellers and refund minters: they are services, never owners
  const services = new Set([...serviceSet(ents), id, ...events.map((e) => e.market).filter(Boolean)]);

  // ---- mint
  const perMinter = new Map();
  for (const e of mints) { const x = perMinter.get(e.to) || { wallet: e.to, count: 0, paid_near: 0, first_ts: e.ts }; x.count += e.count; x.paid_near += e.pay_near || 0; perMinter.set(e.to, x); }
  const minted = sum(mints, (e) => e.count), raised = sum(mints, (e) => e.pay_near);
  const paidMints = mints.filter((e) => e.price_near > 0);
  const proceeds = new Map();
  for (const e of mints) for (const p of e.proceeds || []) proceeds.set(p.to, (proceeds.get(p.to) || 0) + p.near);
  const receivers = [...proceeds].map(([to, near]) => ({ account: to, near: r(near), share: raised ? r(near / raised, 3) : null })).sort((a, b) => b.near - a.near);
  const perWalletMax = Math.max(0, ...[...perMinter.values()].map((x) => x.count));
  const soldOutMin = c.max_supply && minted >= c.max_supply && mints.length ? r((mints.at(-1).ts - mints[0].ts) / MIN, 0) : null;
  const mint = {
    minted, minters: perMinter.size, raised_near: r(raised), price_near: r(median(paidMints.map((e) => e.price_near))), free_tokens: sum(mints.filter((e) => !(e.price_near > 0)), (e) => e.count),
    first_ts: mints[0]?.ts ?? null, last_ts: mints.at(-1)?.ts ?? null, sold_out_min: soldOutMin, max_per_wallet: perWalletMax,
    top_minters: [...perMinter.values()].sort((a, b) => b.count - a.count).slice(0, 15).map((x) => ({ ...x, paid_near: r(x.paid_near), share: minted ? r(x.count / minted, 3) : null })),
    proceeds_to: receivers.slice(0, 6),
  };

  // ---- the team: owner / deployer, and whoever took 20 %+ of the mint money (minus services and the market itself)
  const team = new Set([c.owner, c.deployer, ...receivers.filter((x) => (x.share ?? 0) >= 0.2 && !isService(x.account, services)).map((x) => x.account)].filter(Boolean));
  const teamMinters = [];
  for (const x of perMinter.values()) {
    const tie = team.has(x.wallet) ? { via: 'is the team', account: x.wallet } : tiesTo(wmap.get(x.wallet), team);
    if (tie) teamMinters.push({ wallet: x.wallet, count: x.count, paid_near: r(x.paid_near), ...tie });
  }
  const teamMinted = sum(teamMinters, (x) => x.count);

  // ---- minter groups: money links only (funding, transfers, shared funders), never co-buys
  const profiledMinters = [...perMinter.keys()].map((a) => wmap.get(a)).filter((w) => w?.profiled);
  const gb = buildGroups(profiledMinters, [], new Map(), { cobuySeconds: 0, cobuyMinTokens: 1e9, deepDepth: config.graph.deepDepth, services });
  const groups = gb.groups.filter((g) => g.members.length > 1).map((g) => {
    const count = sum(g.members, (m) => perMinter.get(m)?.count);
    const anchors = g.links.slice(0, 4).map((l) => ({ type: l.type, anchor: l.anchor }));
    return { id: `m${g.members[0].slice(0, 10)}`, wallets: g.members.length, minted: count, share: minted ? r(count / minted, 3) : null, paid_near: r(sum(g.members, (m) => perMinter.get(m)?.paid_near)),
      members: g.members.slice(0, 20), anchors, team: g.members.some((m) => teamMinters.some((t) => t.wallet === m)), over_wallet_max: count > perWalletMax };
  }).sort((a, b) => b.minted - a.minted);
  const groupOf = new Map(); groups.forEach((g, i) => gb.groups.find((x) => x.members.includes(g.members[0]))?.members.forEach((m) => groupOf.set(m, i)));
  const inGroups = sum(groups, (g) => g.minted);
  const minterGroups = { groups: groups.slice(0, 20), groups_n: groups.length, grouped_wallets: sum(groups, (g) => g.wallets), grouped_share: minted ? r(inGroups / minted, 3) : null,
    standalone_wallets: perMinter.size - sum(groups, (g) => g.wallets), profiled: profiledMinters.length, minters: perMinter.size };

  // ---- secondary market and wash trades
  const traders = [...new Set(sales.flatMap((e) => [e.to, e.from]))].map((a) => wmap.get(a)).filter((w) => w?.profiled);
  const tg = buildGroups(traders, [], new Map(), { cobuySeconds: 0, cobuyMinTokens: 1e9, deepDepth: config.graph.deepDepth, services }).walletGroup;
  const lastOwnerBefore = new Map(); // token -> list of { owner, ts } to spot round trips
  const wash = [];
  for (const e of events) {
    for (const id2 of e.token_ids || []) { const h = lastOwnerBefore.get(id2) || []; if (e.kind === 'sale') {
      const reasons = [];
      if (e.from && e.to && tg.has(e.from) && tg.get(e.from) === tg.get(e.to)) reasons.push('same owner (money-linked)');
      const fund = tiesTo(wmap.get(e.to), new Set([e.from])) || tiesTo(wmap.get(e.from), new Set([e.to]));
      if (fund) reasons.push(`${fund.via} the other side`);
      if (h.some((x) => x.owner === e.to && e.ts - x.ts < 30 * DAY)) reasons.push('round trip: the buyer had owned it before');
      if (team.has(e.from) && team.has(e.to)) reasons.push('team on both sides');
      if (reasons.length) wash.push({ ts: e.ts, hash: e.hash, token: id2, from: e.from, to: e.to, price_near: e.price_near, reasons });
    } if (e.to) h.push({ owner: e.to, ts: e.ts }); lastOwnerBefore.set(id2, h.slice(-6)); }
  }
  const byBuyer = new Map(), bySeller = new Map(), byMarket = new Map();
  for (const e of sales) {
    const b = byBuyer.get(e.to) || { wallet: e.to, tokens: 0, near: 0, ts: [] }; b.tokens += e.count; b.near += e.pay_near || 0; b.ts.push(e.ts); byBuyer.set(e.to, b);
    const s = bySeller.get(e.from) || { wallet: e.from, tokens: 0, near: 0 }; s.tokens += e.count; s.near += e.seller_near || 0; bySeller.set(e.from, s);
    byMarket.set(e.market || '?', (byMarket.get(e.market || '?') || 0) + (e.pay_near || 0));
  }
  const sweeps = [...byBuyer.values()].filter((b) => b.tokens >= 3 && b.ts.some((t, i) => b.ts.filter((u) => u >= t && u - t <= HOUR).length >= 3)).map((b) => ({ wallet: b.wallet, tokens: b.tokens, near: r(b.near) }));
  const recent = sales.filter((e) => Date.now() - e.ts < 7 * DAY && e.price_near > 0);
  const volume = sum(sales, (e) => e.pay_near), washVol = sum(wash, (w) => w.price_near);
  const market = {
    sales: sum(sales, (e) => e.count), volume_near: r(volume), median_price: r(median(sales.map((e) => e.price_near).filter((x) => x > 0))), floor_7d: recent.length ? r(Math.min(...recent.map((e) => e.price_near))) : null,
    last_sale: sales.at(-1) ? { ts: sales.at(-1).ts, price_near: sales.at(-1).price_near } : null, below_mint: mint.price_near ? sum(sales.filter((e) => e.price_near > 0 && e.price_near < mint.price_near), (e) => e.count) : null,
    markets: [...byMarket].map(([m, near]) => ({ market: m, near: r(near) })).sort((a, b) => b.near - a.near).slice(0, 5),
    top_buyers: [...byBuyer.values()].sort((a, b) => b.near - a.near).slice(0, 10).map(({ ts, ...x }) => ({ ...x, near: r(x.near), team: team.has(x.wallet) || undefined })),
    top_sellers: [...bySeller.values()].sort((a, b) => b.near - a.near).slice(0, 10).map((x) => ({ ...x, near: r(x.near), team: team.has(x.wallet) || teamMinters.some((t) => t.wallet === x.wallet) || undefined })),
    sweeps, wash: { sales: wash.length, volume_near: r(washVol), share: volume ? r(washVol / volume, 3) : null, rows: wash.slice(-15).reverse() },
  };

  // ---- holders now (from the events; the live supply is checked against them)
  const owners = ownersOf(events);
  const count = new Map(); for (const o of owners.values()) count.set(o, (count.get(o) || 0) + 1);
  const held = owners.size, supply = c.supply ?? held;
  const top = [...count].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([wallet, n]) => ({ wallet, tokens: n, share: supply ? r(n / supply, 4) : null, team: team.has(wallet) || teamMinters.some((t) => t.wallet === wallet) || undefined, group: groupOf.has(wallet) ? groups[groupOf.get(wallet)]?.id : null }));
  const teamHeld = sum([...count].filter(([w]) => team.has(w) || teamMinters.some((t) => t.wallet === w)), ([, n]) => n);
  const holders = { holders: count.size, tracked_tokens: held, supply, complete: c.supply == null || Math.abs(held - c.supply) <= Math.max(2, c.supply * 0.02),
    top10_share: supply ? r(sum(top.slice(0, 10), (x) => x.tokens) / supply, 3) : null, team_share: supply ? r(teamHeld / supply, 3) : null, top };

  // ---- risk notes
  const flags = [];
  if (looksLikeInjection(c.name, c.symbol)) flags.push({ level: 'high', text: 'The collection name or symbol contains instruction-like text aimed at AI reviewers: an attempt to manipulate automated scanners.' });
  const add = (level, text) => flags.push({ level, text });
  if (teamMinted && minted) add(teamMinted / minted >= 0.1 ? 'high' : 'medium', `The team (or wallets it funded) minted ${teamMinted} of ${minted} (${((teamMinted / minted) * 100).toFixed(0)}%)${teamMinters.length > 1 ? ` through ${teamMinters.length} wallets` : ''}.`);
  if (minterGroups.grouped_share >= 0.3) add('medium', `${minterGroups.groups_n} money-linked minter groups minted ${(minterGroups.grouped_share * 100).toFixed(0)}% of the supply.`);
  const bypass = groups.filter((g) => g.over_wallet_max && g.wallets >= 3);
  if (bypass.length) add('medium', `${bypass.length} group(s) minted more than any single wallet did, through several wallets each (largest: ${bypass[0].wallets} wallets, ${bypass[0].minted} NFTs).`);
  if (market.wash.sales) add(market.wash.share >= 0.2 ? 'high' : 'medium', `${market.wash.sales} sale(s) look like wash trades (${((market.wash.share || 0) * 100).toFixed(0)}% of the volume): same owner, money between buyer and seller, or round trips.`);
  if (market.below_mint && market.sales) add('info', `${market.below_mint} of ${market.sales} sales were below the mint price (${mint.price_near} N).`);
  if (holders.top10_share >= 0.5) add('medium', `The 10 largest holders hold ${(holders.top10_share * 100).toFixed(0)}% of the supply.`);
  if (holders.team_share >= 0.1) add('medium', `The team and the wallets it funded still hold ${(holders.team_share * 100).toFixed(0)}% of the supply.`);
  if (receivers[0] && raised > 0) add('info', `Mint proceeds went to ${receivers[0].account} (${receivers[0].near} N, ${((receivers[0].share || 0) * 100).toFixed(0)}%).`);
  if (!holders.complete) add('info', `Holders are rebuilt from ${held} tokens seen in events; the contract reports a supply of ${c.supply}.`);
  if (minterGroups.profiled < perMinter.size) add('info', `${perMinter.size - minterGroups.profiled} minters are not profiled yet: groups and team links may grow.`);
  const order = { high: 0, medium: 1, info: 2 }; flags.sort((a, b) => order[a.level] - order[b.level]);

  return {
    collection: id, built_ts: Date.now(), data_to_ts: events.at(-1)?.ts ?? null,
    info: { name: c.name || null, symbol: c.symbol || null, source: c.source || null, source_label: SOURCES[c.source] || null, owner: c.owner || null, deployer: c.deployer || null, max_supply: c.max_supply ?? null, supply: c.supply ?? null,
      launched_ts: c.launched_ts ?? mints[0]?.ts ?? null, txs_n: c.txs_n ?? null, caught_up: !!c.caught_up, events_n: events.length, nb: c.nb || null },
    team: { accounts: [...team], minters: teamMinters.sort((a, b) => b.count - a.count).slice(0, 20), minted: teamMinted, share: minted ? r(teamMinted / minted, 3) : null },
    mint, minter_groups: minterGroups, market, holders, flags,
  };
}

/** Cached analysis (rebuilt when older than CACHE_MS or when `refresh`). */
export async function getNftAnalysis(id, { refresh = false } = {}) {
  const doc = await col('nft_analyses').findOne({ _id: id }, { projection: { 'ai.snapshot': 0 } });
  const runs = await col('analysis_runs').find({ token: id }, { projection: { snapshot: 0, since: 0 } }).sort({ ts: -1 }).limit(100).toArray();
  const withAi = (data) => ({ ...data, ai: doc?.ai || null, ai_history: runs.filter((x) => x.ts !== doc?.ai?.ts).map(({ _id, ...x }) => ({ id: _id, ...x })) });
  if (doc?.data && !refresh && Date.now() - doc.data.built_ts < CACHE_MS) return withAi(doc.data);
  const data = await buildNftAnalysis(id);
  if (!data) return null;
  await col('nft_analyses').updateOne({ _id: id }, { $set: { data, ts: Date.now() } }, { upsert: true });
  return withAi(data);
}
