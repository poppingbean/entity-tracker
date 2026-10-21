// Everything the gates and the AI analyst need to know about a launch a couple of minutes after its pool opened.
// Built from the tracker's own data (stored trades, wallet funding profiles, groups / entities) plus live pool quotes.
import { col } from '../db.js';
import { creatorNetwork } from '../evaluate/creators.js';
import { config } from '../config.js';
import { view, viewAccount, fastnearGet } from '../near/rpc.js';
import { decimals, units, quoteNearPrice, quoteSymbol, isKnownQuote, nearUsdPrice, quoteToNear } from '../near/quotes.js';
import { priceSeries } from '../collect/analyze.js';
import { INFRA } from '../collect/trades.js';
import { profileWallet, isGenericKind } from '../graph/profile.js';
import { poolSnapshot } from './pool.js';
import { auditNearContract, summarizeAudit } from '../audit/service.js';

// Token code each launchpad deploys (observed on-chain). A code that a launchpad has deployed for >= 3 different tokens is learned too.
const KNOWN_CODE = {
  nearlytrade: ['HS4R2isPS7hnnY8k2QbxnLHUx9Z9v9mNZnLsrGqwhChh', '8GXVnFTxx1d6tYnoqNiQ5YzzQpj1uyxG7u28LeCGmsER', '54GH1DmZgArERRH2ed8zJBXT7UxdeumaZe8Du8dtYJrt'],
  justhoot: ['6YL5fBS6ymwmnCbf2Rq9XD3MhC95pSBptqLXzGrnr41L'],
  memecooking: ['7cs332A22JGVpG9urbTyd7A23kDDGB3juEAuLPxuKfRo'],
};

async function codeHashCheck(t) {
  try {
    const a = await viewAccount(t._id);
    const codeHash = a.global_contract_hash || a.global_contract_account_id || a.code_hash;
    if (t.code_hash !== codeHash) { // count each token once
      await col('templates').updateOne({ _id: t.launchpad }, { $inc: { [`counts.${codeHash}`]: 1 } }, { upsert: true });
      await col('tokens').updateOne({ _id: t._id }, { $set: { code_hash: codeHash } });
    }
    const tpl = (await col('templates').findOne({ _id: t.launchpad }))?.counts || {};
    const accepted = new Set([...(KNOWN_CODE[t.launchpad] || []), ...Object.entries(tpl).filter(([, n]) => n >= 3).map(([h]) => h)]);
    return { codeHash, global: !!a.global_contract_hash, matchesTemplate: accepted.has(codeHash) };
  } catch { return { codeHash: null, global: null, matchesTemplate: null }; }
}

async function ensureProfiles(accounts) {
  const ids = [...new Set(accounts.filter(Boolean))];
  const have = await col('wallets').find({ _id: { $in: ids }, profiled: true }).toArray();
  const done = new Set(have.map((w) => w._id));
  const todo = ids.filter((a) => !done.has(a));
  let i = 0;
  const worker = async () => { while (i < todo.length) { const a = todo[i++]; try { await profileWallet(a); } catch {} } };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
  return new Map((await col('wallets').find({ _id: { $in: ids } }).toArray()).map((w) => [w._id, w]));
}

/**
 * What the early buyers' track record says: how much of the buying comes from groups judged good / bad.
 * "bad" here means DANGEROUS money (insiders, rug farmers, sybil snipers): that is what the gate reacts to. Bots and consistent
 * losers are also verdict "bad" in the tracker but buy every launch, so they are counted apart as "bots_losers".
 */
async function intelFor(buyers, creator, tokenId) {
  const ws = await col('wallets').find({ _id: { $in: buyers.map((b) => b[0]) } }, { projection: { cluster_id: 1, cluster_verdict: 1 } }).toArray();
  const wmap = new Map(ws.map((w) => [w._id, w]));
  const cids = [...new Set(ws.map((w) => w.cluster_id).filter(Boolean))];
  const clusters = await col('clusters').find({ _id: { $in: cids } }, { projection: { 'rule.tags': 1, 'ai.archetype': 1 } }).toArray();
  const DANGER = new Set(['insider', 'rug-farmer', 'sybil-sniper']);
  const dangerous = new Set(clusters.filter((c) => (c.rule?.tags || []).some((t) => DANGER.has(t)) || DANGER.has(c.ai?.archetype)).map((c) => c._id));
  const agg = { good: { wallets: 0, near: 0 }, bad: { wallets: 0, near: 0 }, bots_losers: { wallets: 0, near: 0 }, neutral: { wallets: 0, near: 0 }, unknown: { wallets: 0, near: 0 } };
  let total = 0;
  for (const [wallet, near] of buyers) {
    const w = wmap.get(wallet);
    const k = w?.cluster_verdict === 'good' ? 'good' : w?.cluster_verdict === 'bad' ? (dangerous.has(w.cluster_id) ? 'bad' : 'bots_losers') : w?.cluster_verdict === 'neutral' ? 'neutral' : 'unknown';
    agg[k].wallets++; agg[k].near += near; total += near;
  }
  const prior = creator ? await col('tokens').find({ creator, _id: { $ne: tokenId } }, { projection: { symbol: 1, 'outcome.rugged': 1, 'outcome.creator_sold': 1, 'outcome.peak_multiple': 1 } }).limit(30).toArray() : [];
  const rugs = prior.filter((p) => p.outcome?.rugged || p.outcome?.creator_sold);
  const black = creator ? await col('blacklist').findOne({ _id: creator }) : null; // dumped a token while the simulated wallet held it
  if (black) rugs.push({ symbol: black.symbol || black.token });
  // the creator's network: other creators tied to it by funding or payments, and what they launched
  const net = creator ? await creatorNetwork(creator).catch(() => null) : null;
  const creatorNet = net?.profiled ? {
    traced: true, funder: (({ account, kind, label, type, hop }) => ({ account, kind, label, type, hop }))(net.funders.find((f) => f.link) || net.funders[0] || {}),
    funder_creators_funded: (net.funders.find((f) => f.link) || {}).creators_funded_n ?? null, funder_creators_rugged: (net.funders.find((f) => f.link) || {}).creators_rugged_n ?? null,
    other_creators: net.network.creators - 1, other_launches: net.network.others_launches, other_rugged_tokens: net.network.others_rugged,
    rugger_creators: net.siblings.filter((s) => s.rugged > 0 || s.blacklisted).length,
    ruggers: net.siblings.filter((s) => s.rugged > 0 || s.blacklisted).slice(0, 5).map((s) => ({ account: s.account, rugged: s.rugged, launches: s.launches, blacklisted: s.blacklisted, how: s.relations.map((r) => r.type) })),
  } : { traced: false };
  return {
    creator_network: creatorNet,
    early_buyer_groups: Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, { wallets: v.wallets, near: +v.near.toFixed(1), share: total ? +(v.near / total).toFixed(3) : 0 }])),
    tracked_wallets: ws.length, creator_prior_launches: prior.length, creator_prior_rugs_or_dumps: rugs.length, creator_prior_rug_symbols: rugs.slice(0, 5).map((p) => p.symbol),
  };
}

export async function collectFeatures(t, buyNear, now = Date.now()) {
  const q = t.pool.quote;
  const devBuyNear = t.dev_buy_near ?? (t.dev_buy_quote_raw ? await quoteToNear(q, t.dev_buy_quote_raw).catch(() => null) : 0);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('audit timed out')), ms))]);
  const auditP = config.audit.enabled ? withTimeout(auditNearContract(t._id), config.audit.timeoutSeconds * 1000).then(summarizeAudit).catch((e) => ({ available: false, reason: e.message })) : Promise.resolve({ available: false, reason: 'audit disabled' });
  const [pool, spot, tradesAll, code, top, nearUsd, audit] = await Promise.all([
    poolSnapshot(t, buyNear), poolSnapshot(t, 0.1).catch(() => null), col('trades').find({ token: t._id }).sort({ ts: 1 }).toArray(),
    codeHashCheck(t), fastnearGet(`/v1/ft/${t._id}/top`), nearUsdPrice(), auditP,
  ]);
  const trades = tradesAll.filter((x) => x.ts >= t.live_ts && x.ts <= now);
  const ext = trades.filter((x) => x.trader !== t.creator);
  const buys = ext.filter((x) => x.buy), sells = ext.filter((x) => !x.buy);
  const byBuyer = {}; for (const b of buys) byBuyer[b.trader] = (byBuyer[b.trader] || 0) + b.near;
  const buyNearTotal = buys.reduce((s, x) => s + x.near, 0);
  const topBuyers = Object.entries(byBuyer).sort((a, b) => b[1] - a[1]);

  // wallets buying within 2 s of each other with similar sizes
  let syncClusters = 0;
  for (let i = 0; i < buys.length; i++) {
    const g = buys.filter((x) => Math.abs(x.ts - buys[i].ts) <= 2000);
    if (new Set(g.map((x) => x.trader)).size >= 3) { const n = g.map((x) => x.near); if (Math.min(...n) / Math.max(...n) > 0.75) { syncClusters++; i += g.length - 1; } }
  }

  // funding links between the creator and the biggest buyers
  const watch = [t.creator, ...topBuyers.slice(0, 8).map(([a]) => a)].filter(Boolean);
  const profiles = await ensureProfiles(watch);
  const nonGenericFunders = (w) => (w?.funders || []).filter((f) => !isGenericKind(f.kind) && !f.creator_only).map((f) => f.account);
  const byFunder = new Map();
  for (const a of watch) for (const f of nonGenericFunders(profiles.get(a))) (byFunder.get(f) || byFunder.set(f, new Set()).get(f)).add(a);
  const linked = new Set();
  for (const ws of byFunder.values()) if (ws.size >= 2) ws.forEach((w) => linked.add(w));
  const creatorFunded = [];
  for (const [a] of topBuyers.slice(0, 8)) if (t.creator && (nonGenericFunders(profiles.get(a)).includes(t.creator) || (profiles.get(a)?.funders || []).some((f) => f.account === t.creator))) { linked.add(a); creatorFunded.push(a); }
  const linkedBuyNear = topBuyers.filter(([a]) => linked.has(a)).reduce((s, [, v]) => s + v, 0);

  const prices = priceSeries(trades);
  const holders = (top?.accounts || []).map((h) => ({ account: h.account_id, raw: h.balance })).filter((h) => !INFRA.test(h.account) && h.account !== t._id);
  const supplyRaw = BigInt(await view(t._id, 'ft_total_supply').catch(() => '0'));
  const share = (raw) => (supplyRaw > 0n ? Number((BigInt(raw) * 10000n) / supplyRaw) / 10000 : 0);
  const tokDec = await decimals(t._id);
  const priceNear = spot?.quoteOut > 0 ? 0.1 / spot.quoteOut : null;
  const supply = units(supplyRaw.toString(), tokDec);
  const mcapNear = priceNear != null ? priceNear * supply : null;
  const cp = profiles.get(t.creator);
  const intel = await intelFor(topBuyers, t.creator, t._id);

  return {
    token: t._id, launchpad: t.launchpad, name: t.name, symbol: t.symbol, ageSeconds: Math.round((now - t.live_ts) / 1000),
    pool: {
      dex: t.pool.dex, quote: q, quoteSymbol: quoteSymbol(q), quoteAccepted: isKnownQuote(q), quoteNearPrice: await quoteNearPrice(q).catch(() => 0), route: pool.route?.kind || null,
      nearReserve: +pool.nearReserve.toFixed(2), lpLocked: t.lp?.locked ?? null, quoteForBuy: { near: buyNear, tokensOut: pool.quoteOut },
    },
    launch: { devBuyNear: devBuyNear == null ? null : +devBuyNear.toFixed(2), tax: t.tax || null, creator: t.creator },
    contract: code,
    audit,
    market: { priceNear, totalSupply: supply, mcapNear: mcapNear != null ? +mcapNear.toFixed(1) : null, nearUsd, mcapUsd: mcapNear != null && nearUsd ? Math.round(mcapNear * nearUsd) : null },
    trading: {
      firstTradeDelaySeconds: trades[0] ? Math.round((trades[0].ts - t.live_ts) / 1000) : null,
      uniqueBuyers: Object.keys(byBuyer).length, uniqueSellers: new Set(sells.map((x) => x.trader)).size,
      buyNear: +buyNearTotal.toFixed(2), sellNear: +sells.reduce((s, x) => s + x.near, 0).toFixed(2),
      creatorBuyNear: +trades.filter((x) => x.trader === t.creator && x.buy).reduce((s, x) => s + x.near, 0).toFixed(2), creatorSold: trades.some((x) => x.trader === t.creator && !x.buy),
      topBuyerShare: buyNearTotal ? +(topBuyers[0][1] / buyNearTotal).toFixed(3) : 0, top3BuyerShare: buyNearTotal ? +(topBuyers.slice(0, 3).reduce((s, [, v]) => s + v, 0) / buyNearTotal).toFixed(3) : 0,
      syncBuyClusters: syncClusters, priceMultipleSinceFirstTrade: prices.length > 1 ? +(prices.at(-1).price / prices[0].price).toFixed(2) : 1,
    },
    wallets: {
      creator: cp ? { fresh: cp.created_ts ? now - cp.created_ts < 3 * 86400e3 : null, txCount: cp.tx_count ?? null, funder: cp.funder ?? null, funderLooksGeneric: !cp.funders?.length || isGenericKind(cp.funders[0].kind) } : null,
      topBuyers: topBuyers.slice(0, 8).map(([a, v]) => { const p = profiles.get(a); return { account: a, near: +v.toFixed(2), fresh: p?.created_ts ? now - p.created_ts < 3 * 86400e3 : null, funder: p?.funder ?? null, funderKind: p?.funder_kind ?? null, linked: linked.has(a), group: p?.cluster_verdict ?? null }; }),
      linkedBuyerShare: buyNearTotal ? +(linkedBuyNear / buyNearTotal).toFixed(3) : 0, creatorFundedBuyers: creatorFunded,
    },
    holders: { top10ShareExPool: +holders.slice(0, 10).reduce((s, h) => s + share(h.raw), 0).toFixed(3), creatorShare: share(holders.find((h) => h.account === t.creator)?.raw || '0'), count: holders.length },
    intel,
  };
}
