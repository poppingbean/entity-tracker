// Re-group every profiled early wallet, measure each group, store the result; then let NEAR AI review the groups that need it.
import crypto from 'node:crypto';
import { col, bulkReplace } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { buildGroups } from '../graph/cluster.js';
import { computeMetrics, ruleVerdict, metricsPrint, winTag } from './metrics.js';
import { aiEnabled } from '../ai/nearai.js';
import { reviewCluster } from '../ai/review.js';
import { buildEntities } from './entities.js';
import { creatorIndex, creatorBrief, creatorFlag } from './creators.js';

const evalCfg = () => ({ minutes: config.outcome.minutes, winRoi: config.outcome.winRoi, cobuySeconds: config.graph.cobuySeconds, minTokens: config.evaluate.minTokens, goodScore: config.evaluate.goodScore, badScore: config.evaluate.badScore });
const newId = (member) => `c_${crypto.createHash('sha1').update(member).digest('hex').slice(0, 8)}`;

/** The verdict shown to the user: the AI's when it is confident, otherwise the rule-based one. */
export function finalVerdict(rule, ai) {
  if (ai && ai.verdict !== 'unknown' && ai.confidence >= 0.55) return { verdict: ai.verdict, source: 'ai' };
  return { verdict: rule.verdict, source: 'rules' };
}

/** Rebuild groups, metrics and rule verdicts. Keeps AI reviews of groups that still exist. */
export async function evaluateGroups() {
  const wallets = await col('wallets').find({ is_early: true, profiled: true }).toArray();
  if (!wallets.length) return { groups: 0 };
  const walletMap = new Map(wallets.map((w) => [w._id, w]));
  const entries = await col('entries').find({ wallet: { $in: [...walletMap.keys()] } }).toArray();
  const tokenIds = [...new Set(entries.map((e) => e.token))];
  const tokenDocs = await col('tokens').find({ _id: { $in: tokenIds } }, { projection: { creator: 1, symbol: 1, launchpad: 1, live_ts: 1, outcome: 1 } }).toArray();
  const tokens = new Map(tokenDocs.map((t) => [t._id, t]));

  // profiled "network" wallets (linked, not early buyers themselves) give the deeper links
  const extra = await col('wallets').find({ net: true, profiled: true }, { projection: { funders: 1, chain: 1, flow_out: 1, kind: 1 } }).toArray();
  const { groups, insiderEntries, cobuyPairs, deepLinks } = buildGroups(wallets, entries, tokens, { cobuySeconds: config.graph.cobuySeconds, cobuyMinTokens: config.graph.cobuyMinTokens, deepDepth: config.graph.deepDepth }, extra);
  const old = await col('clusters').find({}, { projection: { members: 1, ai: 1, ai_print: 1, rule: 1, verdict: 1 } }).toArray();
  const oldByWallet = new Map();
  for (const c of old) for (const m of c.members || []) oldByWallet.set(m, c._id);
  const oldById = new Map(old.map((c) => [c._id, c]));

  const cfg = evalCfg(), used = new Set(), docs = [], history = [];
  const creators = await creatorIndex(); // token creators and the dev-rug blacklist
  const entriesByWallet = new Map();
  for (const e of entries) (entriesByWallet.get(e.wallet) || entriesByWallet.set(e.wallet, []).get(e.wallet)).push(e);

  const sorted = groups.map((g) => ({ g, size: g.members.length })).sort((a, b) => b.size - a.size);
  for (const { g } of sorted) {
    const es = g.members.flatMap((m) => entriesByWallet.get(m) || []);
    const { metrics, tokens: tokenRows } = computeMetrics(g.members, es, tokens, walletMap, insiderEntries, cfg);
    if (g.members.length === 1 && metrics.tokens_n < cfg.minTokens) continue; // a lone wallet is only worth a record once it has a track record
    const rule = ruleVerdict(metrics, g.members.length, cfg);
    // id inheritance: keep the id of the previous group these wallets mostly came from
    const votes = new Map();
    for (const m of g.members) { const o = oldByWallet.get(m); if (o && !used.has(o)) votes.set(o, (votes.get(o) || 0) + 1); }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    const id = best ? best[0] : newId(g.members[0]);
    used.add(id);
    const prev = oldById.get(id);
    const print = metricsPrint(metrics, g.members.length);
    const ai = prev?.ai || null;
    const fv = finalVerdict(rule, ai);
    // contract creators inside the group: member wallets or any linked wallet that launched tokens or sits on the dev-rug blacklist
    const memberSet = new Set(g.members);
    const gc = g.nodes.map((a) => creators.get(a)).filter(Boolean).sort((a, b) => (b.blacklisted ? 1 : 0) - (a.blacklisted ? 1 : 0) || b.rugged - a.rugged || b.launches - a.launches);
    const creatorTop = gc.reduce((f, c) => (f === 'blacklisted' || creatorFlag(c) === 'blacklisted' ? 'blacklisted' : f === 'rugger' || creatorFlag(c) === 'rugger' ? 'rugger' : creatorFlag(c) || f), null);
    if (creatorTop === 'blacklisted' || creatorTop === 'rugger') rule.tags = [...rule.tags, 'creator-rug']; else if (gc.length) rule.tags = [...rule.tags, 'token-creator'];
    const net = Object.entries(g.nodeDepth).sort((a, b) => a[1] - b[1]).slice(0, 150).map(([account, depth]) => ({ account, depth }));
    docs.push({
      _id: id, members: g.members, size: g.members.length, nodes: g.nodes.slice(0, 200), links: g.links.slice(0, 200), metrics, tokens: tokenRows.slice(0, 40), rule,
      tag: winTag(metrics.profit_rate, metrics.tokens_n, cfg.minTokens, metrics.roi_weighted), network: net, network_n: Object.keys(g.nodeDepth).length,
      creator_flag: creatorTop, creators_n: gc.length, creators_rugged: gc.filter((c) => c.rugged > 0 || c.blacklisted).length,
      creators: gc.slice(0, 30).map((c) => ({ account: c.account, role: memberSet.has(c.account) ? 'member' : 'linked', depth: g.nodeDepth[c.account] ?? 0, launches: c.launches, rugged: c.rugged, blacklisted: c.blacklisted ? { reason: c.blacklisted.reason, token: c.blacklisted.token, symbol: c.blacklisted.symbol, ts: c.blacklisted.ts } : null, tokens: c.tokens.slice(0, 6) })),
      ai, ai_print: prev?.ai_print || null, print, verdict: fv.verdict, verdict_source: fv.source, score: rule.score, updated_ts: Date.now(),
    });
    if (!prev || prev.verdict !== fv.verdict || prev.rule?.score !== rule.score) history.push({ _id: `${id}|${Date.now()}`, cluster_id: id, ts: Date.now(), verdict: fv.verdict, score: rule.score, tags: rule.tags, tokens_n: metrics.tokens_n, win_rate: metrics.win_rate, rug_share: metrics.rug_share });
  }

  await bulkReplace('clusters', docs);
  if (history.length) await bulkReplace('cluster_history', history);
  const keep = docs.map((d) => d._id);
  const gone = await col('clusters').deleteMany({ _id: { $nin: keep } });

  // per-wallet cluster id + personal track record
  const cmap = new Map();
  for (const d of docs) for (const m of d.members) cmap.set(m, d);
  const ops = wallets.map((w) => {
    const es = entriesByWallet.get(w._id) || [];
    const { metrics } = computeMetrics([w._id], es, tokens, walletMap, insiderEntries, cfg);
    const c = cmap.get(w._id);
    return { updateOne: { filter: { _id: w._id }, update: { $set: { cluster_id: c?._id ?? null, cluster_verdict: c?.verdict ?? null, cluster_tag: c?.tag ?? null, creator: creatorBrief(creators.get(w._id)), tag: winTag(metrics.profit_rate, metrics.tokens_n, cfg.minTokens, metrics.roi_weighted), stats: { tokens_n: metrics.tokens_n, entries_n: metrics.entries_n, win_rate: metrics.win_rate, profit_rate: metrics.profit_rate, roi_weighted: metrics.roi_weighted, pnl_near: metrics.pnl_near, realized_near: metrics.realized_near, unrealized_near: metrics.unrealized_near, rug_share: metrics.rug_share, total_buy_near: metrics.total_buy_near } } } } };
  });
  for (let i = 0; i < ops.length; i += 500) await col('wallets').bulkWrite(ops.slice(i, i + 500), { ordered: false });

  // network wallets remember which group they now belong to; the ones that traded launch tokens themselves are worth a look
  await col('wallets').updateMany({ net: true }, { $set: { net_cluster: null } });
  for (const d of docs) {
    const ids = d.network.map((n) => n.account);
    if (ids.length) await col('wallets').updateMany({ _id: { $in: ids }, net: true }, { $set: { net_cluster: d._id } });
  }
  const by = (t) => docs.filter((d) => d.tag === t).length;
  info(`GROUPS ${docs.length} (win80 ${by('win80')}, win50 ${by('win50')}, win30 ${by('win30')}, sniper ${by('sniper')}, loss ${by('loss')}, unrated ${by('unrated')}); ${cobuyPairs} co-buy links, ${deepLinks} deep links (${config.graph.deepDepth} hops); ${gone.deletedCount} stale removed`);
  await buildEntities();
  return { groups: docs.length };
}

/** NEAR AI review of the groups whose numbers changed (or that were never reviewed). */
export async function reviewPending(limit = 4) {
  if (!aiEnabled()) return 0;
  const minTokens = config.evaluate.minTokens;
  const cands = await col('clusters').find({ 'metrics.tokens_n': { $gte: minTokens } }).sort({ size: -1, 'metrics.tokens_n': -1 }).toArray();
  const due = cands.filter((c) => !c.ai || c.ai_print !== c.print && Date.now() - (c.ai.ts || 0) > config.evaluate.reviewEveryMs || Date.now() - (c.ai.ts || 0) > 7 * 86400e3).slice(0, limit);
  let n = 0;
  for (const c of due) {
    try {
      const walletDocs = await col('wallets').find({ _id: { $in: c.members.slice(0, 40) } }).toArray();
      walletDocs.sort((a, b) => (b.stats?.total_buy_near || 0) - (a.stats?.total_buy_near || 0));
      const ai = await reviewCluster(c, walletDocs, c.tokens || []);
      const fv = finalVerdict(c.rule, ai);
      await col('clusters').updateOne({ _id: c._id }, { $set: { ai, ai_print: c.print, verdict: fv.verdict, verdict_source: fv.source } });
      await col('cluster_history').replaceOne({ _id: `${c._id}|${ai.ts}` }, { _id: `${c._id}|${ai.ts}`, cluster_id: c._id, ts: ai.ts, verdict: fv.verdict, score: c.rule.score, tags: c.rule.tags, ai_verdict: ai.verdict, ai_confidence: ai.confidence, ai_label: ai.label, tokens_n: c.metrics.tokens_n }, { upsert: true });
      info(`AI REVIEW ${c._id} (${c.size} wallets): ${ai.verdict} ${ai.confidence.toFixed(2)} "${ai.label}" → ${fv.verdict}`);
      n++;
    } catch (e) { warn(`AI review of ${c._id} failed: ${e.message}`); }
  }
  return n;
}
