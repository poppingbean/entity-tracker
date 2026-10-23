// On-chain analysis of one token, laid out like the hand-written investigations (launch, creator, price and flows, who bought, linked
// groups, repeat actors, who sold, holders, risk notes), built from what the tracker already stores, plus the groups and wallet tags it
// computed. Cached in `analyses`; NEAR AI can add a written assessment on request (see ai.js).
import { col } from '../db.js';
import { view, ftBalance } from '../near/rpc.js';
import { decimals, units } from '../near/quotes.js';
import { getCachedAudit, summarizeAudit } from '../audit/service.js';
import { creatorIndex, creatorNetwork } from '../evaluate/creators.js';
import { priceSeries } from '../collect/analyze.js';
import { tagOf, ruggerGroup, ruggerWallet } from '../evaluate/tags.js';
import { config } from '../config.js';

const MIN = 60e3, DAY = 86400e3;
export const CACHE_MS = 15 * MIN;
const WINDOWS = [15, 60, 1440]; // minutes after launch
const EARLY_ROWS = 30, HOLDERS_VERIFIED = 15, FLOW_TRAILS = 10, FLOW_NODES = 60;
const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
// routers and launchpad services that trade on behalf of users (justhoot in-app buys settle through NEAR Intents): not holders or sellers
export const INFRA = /^(intents|wrap)\.near$|^(aa-[\w-]+|reward-distribute)\.justhoot\.near$|(^|\.)(ref-finance|ref-labs)\.near$/;
// label = the AI's name for the group; rule_tag = the rules' tag (hidden on a public dashboard, so flag texts never use it)
export const groupBrief = (c) => (c ? { id: c._id, size: c.size, tag: tagOf(c.tag), rugger: ruggerGroup(c), label: c.ai?.label || null, rule_tag: c.rule?.tags?.[0] || null } : null);

async function supplyOf(token) {
  try {
    const [raw, dec] = await Promise.all([view(token, 'ft_total_supply'), decimals(token)]);
    return { supply: units(String(raw), dec), dec };
  } catch { return { supply: null, dec: null }; }
}

/** Per trader totals over every stored trade of the token. */
function byTrader(trades) {
  const m = new Map();
  for (const t of trades) {
    const x = m.get(t.trader) || { account: t.trader, buy_near: 0, sell_near: 0, buy_tokens: 0, sell_tokens: 0, buys: 0, sells: 0, first_ts: t.ts, last_ts: t.ts };
    if (t.buy) { x.buy_near += t.near; x.buy_tokens += t.tokens; x.buys++; } else { x.sell_near += t.near; x.sell_tokens += t.tokens; x.sells++; }
    x.last_ts = t.ts; m.set(t.trader, x);
  }
  return m;
}

/** Flows inside the first `min` minutes after launch. */
function windowFlows(trades, live, min, supply) {
  const w = trades.filter((t) => t.ts >= live && t.ts <= live + min * MIN);
  const buys = w.filter((t) => t.buy), sells = w.filter((t) => !t.buy);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const netTokens = sum(buys, (t) => t.tokens) - sum(sells, (t) => t.tokens);
  return { minutes: min, trades: w.length, buys: buys.length, sells: sells.length, buy_near: r(sum(buys, (t) => t.near)), sell_near: r(sum(sells, (t) => t.near)),
    buyers: new Set(buys.map((t) => t.trader)).size, sellers: new Set(sells.map((t) => t.trader)).size, net_supply_share: supply ? r(netTokens / supply, 4) : null };
}

/**
 * Where the tokens went after leaving the creator and the early buyers by plain transfer (not a sale): follow the stored wallet-to-wallet
 * transfers of this token hop by hop, up to `hops`, and say for every account reached whether it sold on the pool, passed the tokens on or
 * kept them, and what it is (exchange, early buyer, group). One trail per source that sent tokens out, largest first.
 */
export async function tokenFlows(id, sources, { hops, traders, supply }) {
  const transfers = await col('transfers').find({ token: id }, { projection: { from: 1, to: 1, tokens: 1, ts: 1 } }).toArray();
  const out = new Map(); // from -> Map(to -> edge)
  for (const x of transfers) {
    if (!x.from || !x.to || x.from === x.to) continue;
    const m = out.get(x.from) || new Map(), e = m.get(x.to) || { tokens: 0, n: 0, first_ts: x.ts };
    e.tokens += x.tokens || 0; e.n++; e.first_ts = Math.min(e.first_ts, x.ts); m.set(x.to, e); out.set(x.from, m);
  }
  const share = (tokens) => (supply ? r(tokens / supply, 4) : null);
  const trails = [];
  for (const src of sources) {
    const first = out.get(src.account); if (!first) continue;
    const seen = new Set([src.account]), reached = [];
    let frontier = [src.account];
    for (let hop = 1; hop <= hops && frontier.length && reached.length < FLOW_NODES; hop++) {
      const next = [];
      for (const from of frontier) for (const [to, e] of [...(out.get(from) || [])].sort((a, b) => b[1].tokens - a[1].tokens)) {
        if (seen.has(to) || reached.length >= FLOW_NODES) continue;
        seen.add(to); next.push(to);
        reached.push({ account: to, hop, from, tokens: r(e.tokens, 0), supply_share: share(e.tokens), transfers: e.n, first_ts: e.first_ts });
      }
      frontier = next;
    }
    const outTokens = [...first.values()].reduce((s, e) => s + e.tokens, 0);
    trails.push({ ...src, out_tokens: r(outTokens, 0), out_share: share(outTokens), reached });
  }
  trails.sort((a, b) => b.out_tokens - a.out_tokens).splice(FLOW_TRAILS);
  // what each account reached is and did
  const ids = [...new Set(trails.flatMap((t) => t.reached.map((x) => x.account)))];
  const [ws, ents] = await Promise.all([
    col('wallets').find({ _id: { $in: ids } }, { projection: { cluster_id: 1, tag: 1, kind: 1 } }).toArray(),
    col('entities').find({ _id: { $in: ids } }, { projection: { label: 1, type: 1 } }).toArray(),
  ]);
  const wm = new Map(ws.map((w) => [w._id, w])), em = new Map(ents.map((x) => [x._id, x]));
  const cs = await col('clusters').find({ _id: { $in: [...new Set(ws.map((w) => w.cluster_id).filter(Boolean))] } }, { projection: { size: 1, tag: 1, 'ai.label': 1, 'rule.tags': 1, creator_flag: 1 } }).toArray();
  const cm = new Map(cs.map((c) => [c._id, c]));
  for (const t of trails) {
    for (const x of t.reached) {
      const w = wm.get(x.account), ent = em.get(x.account), tr = traders.get(x.account);
      const exchange = ent?.type === 'exchange' || w?.kind === 'exchange';
      x.kind = exchange ? 'exchange' : INFRA.test(x.account) ? 'venue' : w?.kind || ent?.type || null;
      x.label = ent?.label || null; x.tag = w ? tagOf(w.tag) : null; x.group = groupBrief(cm.get(w?.cluster_id));
      x.sold_near = tr ? r(tr.sell_near) : 0; x.bought_near = tr ? r(tr.buy_near) : 0;
      x.passed_on = out.has(x.account);
      x.outcome = exchange ? 'exchange' : x.sold_near > 0 ? 'sold' : x.passed_on ? 'passed on' : 'kept';
    }
    const sold = t.reached.filter((x) => x.sold_near > 0);
    t.summary = { accounts: t.reached.length, max_hop: t.reached.reduce((m, x) => Math.max(m, x.hop), 0), sold_accounts: sold.length,
      sold_near: r(sold.reduce((s, x) => s + x.sold_near, 0)), exchanges: t.reached.filter((x) => x.outcome === 'exchange').map((x) => x.label || x.account),
      early_or_group: t.reached.filter((x) => x.group || x.tag).length };
  }
  return { hops, transfers: transfers.length, trails };
}

/** Build the analysis from stored data (and live balances for the largest holders). */
export async function buildAnalysis(id) {
  const t = await col('tokens').findOne({ _id: id });
  if (!t) return null;
  const live = t.live_ts;
  const [trades, entries, auditDoc, { supply, dec }] = await Promise.all([
    col('trades').find({ token: id }, { projection: { ts: 1, trader: 1, buy: 1, near: 1, tokens: 1 } }).sort({ ts: 1 }).toArray(),
    col('entries').find({ token: id }).sort({ rank: 1 }).toArray(),
    getCachedAudit(id), supplyOf(id),
  ]);
  const traders = byTrader(trades);
  const creator = t.creator || null;
  const walletIds = [...new Set([...entries.map((e) => e.wallet), ...traders.keys(), ...(creator ? [creator] : [])])];
  const wallets = await col('wallets').find({ _id: { $in: walletIds } }, { projection: { cluster_id: 1, tag: 1, kind: 1, creator: 1, created_ts: 1, tx_count: 1, funders: { $slice: 3 }, 'chain.account': 1, stats: 1 } }).toArray();
  const wmap = new Map(wallets.map((w) => [w._id, w]));
  const clusters = await col('clusters').find({ _id: { $in: [...new Set(wallets.map((w) => w.cluster_id).filter(Boolean))] } }, { projection: { size: 1, tag: 1, 'ai.label': 1, 'rule.tags': 1, creator_flag: 1, metrics: 1 } }).toArray();
  const cmap = new Map(clusters.map((c) => [c._id, c]));
  const groupOf = (acc) => { const c = cmap.get(wmap.get(acc)?.cluster_id); return c || null; };
  const share = (tokens) => (supply ? r(tokens / supply, 4) : null);

  // ---- launch
  const audit = summarizeAudit(auditDoc);
  const launch = {
    launchpad: t.launchpad, live_ts: live, live_tx: t.live_tx || null, creator, supply, dev_buy_near: t.dev_buy_near ?? null, pool: t.pool ? { dex: t.pool.dex, quote: t.pool.quote } : null,
    lp_locked: t.lp?.locked ?? null, transfer_fee_pct: t.tax?.transferFeePips != null ? t.tax.transferFeePips / 1e4 : null, buy_tax_pct: t.tax?.buyBps != null ? t.tax.buyBps / 100 : null, sell_tax_pct: t.tax?.sellBps != null ? t.tax.sellBps / 100 : null,
    audit: audit.available ? { risk_score: audit.risk_score, risk_level: audit.risk_level, trust_score: audit.trust_score, full_access_keys: audit.full_access_keys, privileged_methods: audit.privileged_methods, confirmed_malicious: audit.confirmed_malicious.map((c) => c.key), audited_ts: audit.audited_ts } : null,
  };

  // ---- creator
  let creatorSec = null;
  if (creator) {
    const w = wmap.get(creator) || await col('wallets').findOne({ _id: creator }, { projection: { cluster_id: 1, tag: 1, created_ts: 1, tx_count: 1, funders: { $slice: 3 }, chain: 1, profiled: 1 } });
    const [idx, net] = await Promise.all([creatorIndex([creator]), creatorNetwork(creator).catch(() => null)]);
    const ci = idx.get(creator), tr = traders.get(creator);
    const bal = await ftBalance(id, creator);
    creatorSec = {
      account: creator, created_ts: w?.created_ts ?? null, age_days_at_launch: w?.created_ts ? r((live - w.created_ts) / DAY, 2) : null, tx_count: w?.tx_count ?? null,
      funders: (w?.funders || []).map((f) => ({ account: f.account, kind: f.kind, near: r(f.near), ts: f.ts })),
      // earlier launches: the index counts this one too
      launches: ci?.launches ?? 0, earlier_launches: Math.max(0, (ci?.launches ?? 1) - 1), earlier_rugged: Math.max(0, (ci?.rugged ?? 0) - (t.outcome?.rugged ? 1 : 0)), rugged: ci?.rugged ?? 0, blacklisted: !!ci?.blacklisted,
      linked_creators: net?.profiled ? (net.siblings || []).slice(0, 6).map((s) => ({ account: s.account, launches: s.launches, rugged: s.rugged })) : [],
      group: groupBrief(groupOf(creator)),
      traded: tr ? { buy_near: r(tr.buy_near), sell_near: r(tr.sell_near), buys: tr.buys, sells: tr.sells, first_sell_min: null } : null,
      dev_buy_near: t.dev_buy_near ?? null, balance: bal != null && dec != null ? r(units(bal.toString(), dec), 0) : null,
    };
    if (creatorSec.balance != null && supply) creatorSec.balance_share = share(creatorSec.balance);
    const firstSell = trades.find((x) => x.trader === creator && !x.buy);
    if (firstSell && creatorSec.traded) creatorSec.traded.first_sell_min = r((firstSell.ts - live) / MIN, 1);
  }

  // ---- price and flows
  const series = priceSeries(trades);
  const first = series[0]?.price ?? null;
  let peak = null; for (const p of series) if (!peak || p.price > peak.price) peak = p;
  const last = series.at(-1) ?? null;
  const flows = {
    first_price: first, peak_multiple: first && peak ? r(peak.price / first) : null, peak_min: peak ? r((peak.ts - live) / MIN, 0) : null,
    now_multiple: first && last ? r(last.price / first) : null, last_trade_ts: last?.ts ?? null, drawdown_from_peak: peak && last ? r(1 - last.price / peak.price, 3) : null,
    windows: WINDOWS.map((m) => windowFlows(trades, live, m, supply)),
    via_intents: (() => { const x = traders.get('intents.near'); return x ? { buy_near: r(x.buy_near), sell_near: r(x.sell_near) } : null; })(),
    total: { trades: trades.length, buy_near: r(trades.filter((x) => x.buy).reduce((s, x) => s + x.near, 0)), sell_near: r(trades.filter((x) => !x.buy).reduce((s, x) => s + x.near, 0)), traders: traders.size },
  };

  // ---- who bought early
  const creatorFunded = (w) => !!creator && !!w && ((w.funders || []).some((f) => f.account === creator) || (w.chain || []).some((c) => c.account === creator));
  const early = entries.slice(0, EARLY_ROWS).map((e) => {
    const w = wmap.get(e.wallet), c = groupOf(e.wallet);
    const age = w?.created_ts ? (e.first_buy_ts - w.created_ts) / DAY : null;
    const notes = [];
    if (e.is_creator) notes.push('creator');
    if (age != null && age < 3) notes.push(`fresh wallet (${r(age, 1)} d old)`);
    if (creatorFunded(w)) notes.push('funded by the creator');
    if ((w?.stats?.tokens_n ?? 0) > 1) notes.push(`early in ${w.stats.tokens_n - 1} other token${w.stats.tokens_n - 1 === 1 ? '' : 's'}`);
    if (ruggerWallet(w, c)) notes.push('rugger link');
    return { wallet: e.wallet, rank: e.rank, delay_s: e.delay_s, buy_near: r(e.buy_near), buy_tokens: r(e.buy_tokens, 0), supply_share: share(e.buy_tokens), roi_now: r(e.roi_now, 3), sold_share_now: r(e.sold_share_now, 3),
      realized_now: r(e.realized_now), unrealized_now: r(e.unrealized_now), wallet_age_days: age != null ? r(age, 1) : null, funder: w?.funders?.[0] ? { account: w.funders[0].account, kind: w.funders[0].kind } : null,
      tag: w ? tagOf(w.tag) : null, group: groupBrief(c), notes };
  });
  const earlyNear = entries.reduce((s, e) => s + e.buy_near, 0);

  // ---- linked groups among the early buyers (the tracker's clusters: funding chains, money flow, co-buys)
  const gm = new Map();
  for (const e of entries) {
    const c = groupOf(e.wallet); if (!c) continue;
    const g = gm.get(c._id) || { ...groupBrief(c), members: [], near_in: 0, tokens: 0, realized_now: 0, unrealized_now: 0, lifetime: c.metrics ? { tokens_n: c.metrics.tokens_n, profit_rate: r(c.metrics.profit_rate, 3), pnl_near: r(c.metrics.pnl_near), rug_share: r(c.metrics.rug_share, 3) } : null };
    g.members.push(e.wallet); g.near_in += e.buy_near; g.tokens += e.buy_tokens || 0; g.realized_now += e.realized_now || 0; g.unrealized_now += e.unrealized_now || 0;
    gm.set(c._id, g);
  }
  const groups = [...gm.values()].map((g) => ({ ...g, near_in: r(g.near_in), early_near_share: earlyNear ? r(g.near_in / earlyNear, 3) : null, supply_share: share(g.tokens), tokens: r(g.tokens, 0), realized_now: r(g.realized_now), unrealized_now: r(g.unrealized_now) }))
    .sort((a, b) => b.near_in - a.near_in);

  // ---- shared funders: early buyers whose first funder is the same account (a link the clusters may not have made)
  const fm = new Map();
  for (const e of entries) {
    const f = wmap.get(e.wallet)?.funders?.[0]; if (!f?.account || f.account === creator) continue;
    const x = fm.get(f.account) || { funder: f.account, kind: f.kind, tx_count: f.tx_count ?? null, wallets: [] };
    x.wallets.push(e.wallet); fm.set(f.account, x);
  }
  const sharedFunders = [...fm.values()].filter((x) => x.wallets.length >= 2).map((x) => {
    const cs = new Set(x.wallets.map((w) => wmap.get(w)?.cluster_id).filter(Boolean));
    return { ...x, strength: x.kind === 'wallet' && (x.tx_count ?? 0) < 10000 ? 'strong' : 'weak', same_group: cs.size === 1 && x.wallets.every((w) => wmap.get(w)?.cluster_id) };
  }).sort((a, b) => b.wallets.length - a.wallets.length).slice(0, 12);

  // ---- repeat actors: early buyers seen early in other launches, with their record
  const repeat = entries.map((e) => ({ e, w: wmap.get(e.wallet) })).filter(({ w }) => (w?.stats?.tokens_n ?? 0) > 1)
    .map(({ e, w }) => ({ wallet: e.wallet, rank: e.rank, tag: tagOf(w.tag), other_tokens: w.stats.tokens_n - 1, profit_rate: r(w.stats.profit_rate, 3), pnl_near: r(w.stats.pnl_near), rugger: ruggerWallet(w, groupOf(e.wallet)), group: groupBrief(groupOf(e.wallet)) }))
    .sort((a, b) => b.other_tokens - a.other_tokens || (b.pnl_near ?? 0) - (a.pnl_near ?? 0)).slice(0, 15);

  // ---- who sold: largest NEAR taken out (sells minus buys) across all stored trades
  const rankOf = new Map(entries.map((e) => [e.wallet, e.rank]));
  const sellers = [...traders.values()].filter((x) => x.sell_near > 0 && !INFRA.test(x.account)).map((x) => ({ account: x.account, buy_near: r(x.buy_near), sell_near: r(x.sell_near), net_near: r(x.sell_near - x.buy_near), sells: x.sells,
    early_rank: rankOf.get(x.account) ?? null, known: wmap.has(x.account), tag: wmap.get(x.account) ? tagOf(wmap.get(x.account).tag) : null, group: groupBrief(groupOf(x.account)), is_creator: x.account === creator }))
    .sort((a, b) => b.net_near - a.net_near).slice(0, 12);

  // ---- holders: net tokens from trades (misses transfers), the largest checked live with ft_balance_of
  const est = [...traders.values()].filter((x) => !INFRA.test(x.account) && x.account !== id).map((x) => ({ account: x.account, est_tokens: x.buy_tokens - x.sell_tokens })).filter((x) => x.est_tokens > 1).sort((a, b) => b.est_tokens - a.est_tokens);
  const check = est.slice(0, HOLDERS_VERIFIED);
  // the dev buy does not go through the pool, so the creator is always checked
  if (creator && !check.some((x) => x.account === creator)) check.push({ account: creator, est_tokens: est.find((x) => x.account === creator)?.est_tokens ?? 0 });
  const balances = dec != null ? await Promise.all(check.map((x) => ftBalance(id, x.account))) : [];
  const holders = check.map((x, i) => {
    const b = balances[i], tokens = b != null && dec != null ? units(b.toString(), dec) : null;
    return { account: x.account, est_tokens: r(x.est_tokens, 0), tokens: tokens != null ? r(tokens, 0) : null, verified: tokens != null, supply_share: share(tokens ?? x.est_tokens),
      early_rank: rankOf.get(x.account) ?? null, known: wmap.has(x.account), tag: wmap.get(x.account) ? tagOf(wmap.get(x.account).tag) : null, group: groupBrief(groupOf(x.account)), is_creator: x.account === creator };
  }).sort((a, b) => (b.tokens ?? b.est_tokens) - (a.tokens ?? a.est_tokens));
  const top10 = holders.slice(0, 10).reduce((s, h) => s + (h.supply_share || 0), 0);
  const holdersSec = { holders_est: est.length, top10_share: supply ? r(top10, 4) : null, rows: holders };

  // ---- where the tokens went: transfers out of the creator and the early buyers, followed up to ANALYSIS_FLOW_HOPS hops
  const flowSources = [...(creator ? [{ account: creator, role: 'creator', rank: null }] : []),
    ...entries.filter((e) => e.wallet !== creator).map((e) => ({ account: e.wallet, role: 'early buyer', rank: e.rank }))];
  const tokenFlowsSec = await tokenFlows(id, flowSources, { hops: config.analysis.flowHops, traders, supply });

  // ---- risk notes: facts worth flagging, high first
  const flags = [];
  const add = (level, text) => flags.push({ level, text });
  if (t.outcome?.rugged) add('high', 'The tracker counts this token as rugged.');
  if (launch.audit?.confirmed_malicious?.length) add('high', `Contract audit confirmed malicious behaviour: ${launch.audit.confirmed_malicious.join(', ')}.`);
  if (launch.audit?.full_access_keys > 0) add('medium', `The token contract has ${launch.audit.full_access_keys} full-access key(s): its code can be replaced.`);
  if (launch.audit?.privileged_methods?.length) add('info', `Owner / upgrade methods exposed: ${launch.audit.privileged_methods.slice(0, 5).join(', ')}.`);
  if (creatorSec?.blacklisted) add('high', 'The creator is on the dev-rug blacklist.');
  if (creatorSec?.earlier_rugged > 0) add('high', `The creator rugged ${creatorSec.earlier_rugged} of ${creatorSec.earlier_launches} earlier launch(es).`);
  if (creatorSec?.traded?.sell_near > 0) add('medium', `The creator sold ${creatorSec.traded.sell_near} NEAR of this token${creatorSec.traded.first_sell_min != null ? `, first sale ${creatorSec.traded.first_sell_min} min after launch` : ''}.`);
  else if (creatorSec?.balance_share != null && creatorSec.balance_share < 0.001 && (t.dev_buy_near ?? 0) >= 1) add('high', 'The creator has not sold on the pool but holds almost none of the token now: the dev buy was moved out by transfer.');
  else if (creatorSec?.balance === 0 && !t.dev_buy_near) add('info', 'The creator made no dev buy and holds none of the token.');
  else if (creatorSec && creatorSec.balance != null) add('info', `The creator has not sold on the pool and holds ${creatorSec.balance_share != null ? (creatorSec.balance_share * 100).toFixed(1) + '% of supply' : creatorSec.balance + ' tokens'}.`);
  const fundedByCreator = early.filter((e) => e.notes.includes('funded by the creator'));
  if (fundedByCreator.length) add('high', `${fundedByCreator.length} early buyer(s) were funded by the creator.`);
  const topGroup = groups.find((g) => g.members.length >= 2);
  if (topGroup?.early_near_share >= 0.2) add('medium', `One linked group (${topGroup.label || topGroup.id}, ${topGroup.members.length} wallets) put in ${(topGroup.early_near_share * 100).toFixed(0)}% of the early NEAR.`);
  const ruggerGroups = groups.filter((g) => g.rugger);
  if (ruggerGroups.length) add('high', `${ruggerGroups.length} group(s) linked to rugs bought early (${ruggerGroups.map((g) => g.label || g.id).slice(0, 3).join(', ')}).`);
  const lossNear = groups.filter((g) => g.tag === 'loss').reduce((s, g) => s + g.near_in, 0);
  if (earlyNear && lossNear / earlyNear >= 0.25) add('medium', `Loss-tagged groups put in ${((lossNear / earlyNear) * 100).toFixed(0)}% of the early NEAR.`);
  const winners = groups.filter((g) => ['win80', 'win50'].includes(g.tag) && !g.rugger);
  if (winners.length) add('info', `Winning groups among the early buyers: ${winners.map((g) => `${g.label || g.id} (${g.tag})`).slice(0, 4).join(', ')}.`);
  const fresh = early.filter((e) => e.wallet_age_days != null && e.wallet_age_days < 3);
  if (early.length && fresh.length / early.length >= 0.3) add('medium', `${fresh.length} of the first ${early.length} buyers used wallets less than 3 days old.`);
  const strongShared = sharedFunders.filter((x) => x.strength === 'strong' && !x.same_group);
  if (strongShared.length) add('medium', `${strongShared.length} funder(s) paid several early buyers that the groups do not link yet.`);
  if (holdersSec.top10_share != null && holdersSec.top10_share >= 0.5) add('medium', `The 10 largest holders checked hold ${(holdersSec.top10_share * 100).toFixed(0)}% of supply.`);
  if (launch.transfer_fee_pct) add('info', `Transfer fee ${launch.transfer_fee_pct}%.`);
  const devTrail = tokenFlowsSec.trails.find((x) => x.role === 'creator');
  if (devTrail?.summary.sold_near > 0) add('high', `Tokens the creator moved out by transfer reached ${devTrail.summary.accounts} account(s) within ${devTrail.summary.max_hop} hop(s); ${devTrail.summary.sold_accounts} of them sold ${devTrail.summary.sold_near} NEAR on the pool.`);
  else if (devTrail) add('medium', `The creator moved ${devTrail.out_share != null ? (devTrail.out_share * 100).toFixed(1) + '% of supply' : devTrail.out_tokens + ' tokens'} out by transfer to ${devTrail.summary.accounts} account(s) (up to ${devTrail.summary.max_hop} hop(s)).`);
  const earlyTrails = tokenFlowsSec.trails.filter((x) => x.role === 'early buyer'), earlySold = earlyTrails.reduce((s, x) => s + x.summary.sold_near, 0);
  if (earlySold > 0) add('medium', `${earlyTrails.length} early buyer(s) moved tokens out by transfer; the accounts that received them (up to ${config.analysis.flowHops} hops) sold ${r(earlySold)} NEAR on the pool.`);
  const order = { high: 0, medium: 1, info: 2 };
  flags.sort((a, b) => order[a.level] - order[b.level]);

  return { token: id, symbol: t.symbol || null, name: t.name || null, built_ts: Date.now(), age_min: Math.round((Date.now() - live) / MIN), data_to_ts: t.ledger?.synced_to_ts ?? trades.at(-1)?.ts ?? null,
    launch, creator: creatorSec, flows, early: { wallets: entries.length, near_in: r(earlyNear), rows: early }, groups, shared_funders: sharedFunders, repeat, sellers, holders: holdersSec, token_flows: tokenFlowsSec, flags };
}

/** Cached analysis (rebuilt when older than CACHE_MS or when `refresh`). */
export async function getAnalysis(id, { refresh = false } = {}) {
  const doc = await col('analyses').findOne({ _id: id }, { projection: { 'ai.snapshot': 0 } }); // the AI's evidence snapshot stays server-side
  const runs = await col('analysis_runs').find({ token: id }, { projection: { snapshot: 0, since: 0 } }).sort({ ts: -1 }).limit(100).toArray();
  // the history: every earlier run (the latest is `ai`)
  const withAi = (data) => ({ ...data, ai: doc?.ai || null, ai_history: runs.filter((x) => x.ts !== doc?.ai?.ts).map(({ _id, ...x }) => ({ id: _id, ...x })) });
  if (doc?.data && !refresh && Date.now() - doc.data.built_ts < CACHE_MS) return withAi(doc.data);
  const data = await buildAnalysis(id);
  if (!data) return null;
  await col('analyses').updateOne({ _id: id }, { $set: { data, ts: Date.now() } }, { upsert: true });
  return withAi(data);
}
