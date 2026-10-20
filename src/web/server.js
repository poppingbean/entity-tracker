// Web UI + JSON API (GET only, no write endpoints). Read-only on-chain, read-only here: nothing in this process can move funds.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { col, metaGet } from '../db.js';
import { config } from '../config.js';
import { recentLogs, info } from '../log.js';
import { aiEnabled, aiStatus } from '../ai/nearai.js';

const page = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const clamp = (v, d, max) => Math.min(max, Math.max(1, Number(v) || d));
const rx = (s) => ({ $regex: String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' });
const strip = ({ _id, ...r }) => ({ id: _id, ...r });

/** For each recent token: who among its early buyers belongs to groups judged good / bad. */
async function buildSignals(hours = 72, limit = 60) {
  const since = Date.now() - hours * 3600e3;
  const tokens = await col('tokens').find({ live_ts: { $gt: since }, entries_n: { $gt: 0 } }).sort({ live_ts: -1 }).limit(limit).toArray();
  if (!tokens.length) return [];
  const entries = await col('entries').find({ token: { $in: tokens.map((t) => t._id) } }).toArray();
  const wallets = await col('wallets').find({ _id: { $in: [...new Set(entries.map((e) => e.wallet))] } }, { projection: { cluster_id: 1, cluster_verdict: 1 } }).toArray();
  const wmap = new Map(wallets.map((w) => [w._id, w]));
  const cids = [...new Set(wallets.map((w) => w.cluster_id).filter(Boolean))];
  const clusters = await col('clusters').find({ _id: { $in: cids } }, { projection: { verdict: 1, size: 1, 'ai.label': 1, 'ai.archetype': 1, 'rule.tags': 1, score: 1 } }).toArray();
  const cmap = new Map(clusters.map((c) => [c._id, c]));
  const out = [];
  for (const t of tokens) {
    const es = entries.filter((e) => e.token === t._id);
    const total = es.reduce((s, e) => s + e.buy_near, 0) || 1;
    const agg = { good: { w: 0, near: 0 }, bad: { w: 0, near: 0 }, other: { w: 0, near: 0 } };
    const groups = new Map();
    for (const e of es) {
      const w = wmap.get(e.wallet), c = w?.cluster_id ? cmap.get(w.cluster_id) : null;
      const v = c?.verdict === 'good' ? 'good' : c?.verdict === 'bad' ? 'bad' : 'other';
      agg[v].w++; agg[v].near += e.buy_near;
      if (c && v !== 'other') { const g = groups.get(c._id) || { id: c._id, verdict: c.verdict, label: c.ai?.label || c.rule?.tags?.[0] || null, wallets: 0, near: 0 }; g.wallets++; g.near += e.buy_near; groups.set(c._id, g); }
    }
    const badShare = agg.bad.near / total, goodShare = agg.good.near / total;
    const assessment = badShare >= 0.25 ? 'warning' : agg.good.w >= 2 && badShare < 0.1 ? 'bullish' : agg.good.w + agg.bad.w ? 'mixed' : 'no-known-groups';
    if (assessment === 'no-known-groups') continue;
    out.push({ token: t._id, symbol: t.symbol, launchpad: t.launchpad, live_ts: t.live_ts, status: t.status, early_wallets: es.length, total_near: total, good: agg.good, bad: agg.bad, good_share: goodShare, bad_share: badShare, assessment,
      groups: [...groups.values()].sort((a, b) => b.near - a.near), outcome: t.outcome ? { rugged: t.outcome.rugged, peak_multiple: t.outcome.peak_multiple, last_multiple: t.outcome.last_multiple, age_min: t.outcome.age_min } : null });
  }
  return out;
}

const routes = {
  '/api/overview': async () => {
    const [tokStatus, clusterVerdict, wallets, profiled, entries, worker, latest, topGood, topBad, tokens] = await Promise.all([
      col('tokens').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
      col('clusters').aggregate([{ $group: { _id: '$verdict', n: { $sum: 1 }, wallets: { $sum: '$size' } } }]).toArray(),
      col('wallets').countDocuments({ is_early: true }), col('wallets').countDocuments({ is_early: true, profiled: true }), col('entries').estimatedDocumentCount(),
      metaGet('worker'), col('tokens').find({}, { projection: { symbol: 1, launchpad: 1, live_ts: 1, status: 1, entries_n: 1, 'outcome.rugged': 1, 'outcome.peak_multiple': 1 } }).sort({ live_ts: -1 }).limit(10).toArray(),
      col('clusters').find({ verdict: 'good' }, { projection: { size: 1, score: 1, 'metrics.tokens_n': 1, 'metrics.win_rate': 1, 'metrics.pnl_near': 1, 'ai.label': 1 } }).sort({ score: -1 }).limit(5).toArray(),
      col('clusters').find({ verdict: 'bad' }, { projection: { size: 1, score: 1, 'metrics.tokens_n': 1, 'metrics.rug_share': 1, 'rule.tags': 1, 'ai.label': 1 } }).sort({ size: -1 }).limit(5).toArray(),
      col('tokens').estimatedDocumentCount(),
    ]);
    return {
      now: Date.now(), tokens, tokenStatus: tokStatus.map((r) => ({ status: r._id, n: r.n })), clusterVerdict: clusterVerdict.map((r) => ({ verdict: r._id, n: r.n, wallets: r.wallets })),
      wallets, profiled, entries, worker, latest: latest.map(strip), topGood: topGood.map(strip), topBad: topBad.map(strip),
      ai: { enabled: aiEnabled(), model: config.ai.model, ...(worker?.ai || {}) }, db: config.mongo.dbName,
    };
  },

  '/api/clusters': async (u) => {
    const f = {};
    const v = u.searchParams.get('verdict'); if (v) f.verdict = v;
    const q = (u.searchParams.get('q') || '').trim(); if (q) f.$or = [{ members: q }, { _id: rx(q) }, { 'ai.label': rx(q) }];
    const minSize = Number(u.searchParams.get('minSize')); if (minSize) f.size = { $gte: minSize };
    const sort = { score: { score: -1 }, size: { size: -1 }, pnl: { 'metrics.pnl_near': -1 }, recent: { 'metrics.last_entry_ts': -1 } }[u.searchParams.get('sort')] || { size: -1 };
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows] = await Promise.all([col('clusters').countDocuments(f),
      col('clusters').find(f, { projection: { nodes: 0, links: 0, tokens: 0, members: 0, 'ai.reasons': 0, 'ai.red_flags': 0, 'ai.usage': 0 } }).sort(sort).skip(offset).limit(limit).toArray()]);
    return { total, rows: rows.map(strip) };
  },

  '/api/cluster': async (u) => {
    const c = await col('clusters').findOne({ _id: u.searchParams.get('id') });
    if (!c) return { error: 'not found' };
    const wallets = await col('wallets').find({ _id: { $in: c.members } }).toArray();
    wallets.sort((a, b) => (b.stats?.total_buy_near || 0) - (a.stats?.total_buy_near || 0));
    const history = await col('cluster_history').find({ cluster_id: c._id }).sort({ ts: -1 }).limit(30).toArray();
    const { _id, ...rest } = c;
    return { id: _id, ...rest, wallets: wallets.map((w) => ({ id: w._id, kind: w.kind, tx_count: w.tx_count, created_ts: w.created_ts, funder: w.funder, funder_kind: w.funder_kind, funding_near: w.funding_near, chain: w.chain, stats: w.stats, flow_out_total: w.flow_out_total })), history: history.map(({ _id: x, ...h }) => h) };
  },

  /** Nodes and edges for the funding / flow picture of one group. */
  '/api/graph': async (u) => {
    const c = await col('clusters').findOne({ _id: u.searchParams.get('id') }, { projection: { members: 1, nodes: 1 } });
    if (!c) return { error: 'not found' };
    const members = new Set(c.members), nodeList = c.nodes?.length ? c.nodes : c.members;
    const edges = await col('edges').find({ $or: [{ type: 'fund', to: { $in: nodeList } }, { type: 'flow', from: { $in: c.members } }] }).limit(3000).toArray();
    // flows only matter when they reach another member or a destination that more than one member pays
    const payers = new Map();
    for (const e of edges) if (e.type === 'flow') (payers.get(e.to) || payers.set(e.to, new Set()).get(e.to)).add(e.from);
    const keep = edges.filter((e) => e.type === 'fund' || members.has(e.to) || (payers.get(e.to)?.size || 0) >= 2).slice(0, 500);
    const used = new Set(c.members);
    for (const e of keep) { used.add(e.from); used.add(e.to); }
    const ids = [...used].slice(0, 250);
    const infos = await col('wallets').find({ _id: { $in: ids } }, { projection: { kind: 1, tx_count: 1, 'stats.tokens_n': 1 } }).toArray();
    const imap = new Map(infos.map((w) => [w._id, w]));
    return {
      nodes: ids.map((id) => ({ id, member: members.has(id), kind: imap.get(id)?.kind || null, tx_count: imap.get(id)?.tx_count ?? null, tokens_n: imap.get(id)?.stats?.tokens_n ?? null })),
      edges: keep.filter((e) => used.has(e.from) && used.has(e.to)).map((e) => ({ from: e.from, to: e.to, type: e.type, near: e.near, n: e.n ?? null })),
    };
  },

  '/api/entities': async (u) => {
    const f = {};
    const t = u.searchParams.get('type'); if (t) f.type = t;
    const k = u.searchParams.get('kind'); if (k) f.kind = k;
    const role = u.searchParams.get('role'); if (role) f.roles = role;
    const q = (u.searchParams.get('q') || '').trim(); if (q) f.$or = [{ _id: rx(q) }, { label: rx(q) }];
    const sort = { funded: { funded_n: -1 }, near: { funded_near: -1 }, sink: { sink_near: -1 }, tokens: { tokens_n: -1 }, pnl: { funded_pnl_near: -1 } }[u.searchParams.get('sort')] || { funded_n: -1 };
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows, types] = await Promise.all([col('entities').countDocuments(f),
      col('entities').find(f, { projection: { funded_wallets: 0, sink_wallets: 0 } }).sort(sort).skip(offset).limit(limit).toArray(),
      col('entities').aggregate([{ $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()]);
    return { total, rows: rows.map(strip), types: types.map((x) => ({ type: x._id, n: x.n })) };
  },

  '/api/entity': async (u) => {
    const e = await col('entities').findOne({ _id: u.searchParams.get('id') });
    if (!e) return { error: 'not found' };
    const { _id, ...rest } = e;
    return { id: _id, ...rest };
  },

  '/api/wallets': async (u) => {
    const f = { is_early: true };
    const q = (u.searchParams.get('q') || '').trim(); if (q) f._id = rx(q);
    const v = u.searchParams.get('verdict'); if (v) f.cluster_verdict = v;
    const sort = { pnl: { 'stats.pnl_near': -1 }, tokens: { 'stats.tokens_n': -1 }, roi: { 'stats.roi_weighted': -1 }, recent: { first_seen_ts: -1 } }[u.searchParams.get('sort')] || { 'stats.tokens_n': -1 };
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows] = await Promise.all([col('wallets').countDocuments(f), col('wallets').find(f, { projection: { chain: 0, flow_out: 0 } }).sort(sort).skip(offset).limit(limit).toArray()]);
    return { total, rows: rows.map(strip) };
  },

  '/api/wallet': async (u) => {
    const id = u.searchParams.get('id');
    const w = await col('wallets').findOne({ _id: id });
    if (!w) return { error: 'not found' };
    const entries = await col('entries').find({ wallet: id }).sort({ first_buy_ts: -1 }).limit(100).toArray();
    const toks = await col('tokens').find({ _id: { $in: entries.map((e) => e.token) } }, { projection: { symbol: 1, launchpad: 1, 'outcome.rugged': 1, 'outcome.peak_multiple': 1, creator: 1 } }).toArray();
    const tmap = new Map(toks.map((t) => [t._id, t]));
    const cluster = w.cluster_id ? await col('clusters').findOne({ _id: w.cluster_id }, { projection: { size: 1, verdict: 1, score: 1, 'ai.label': 1, 'rule.tags': 1 } }) : null;
    const { _id, ...rest } = w;
    return { id: _id, ...rest, cluster: cluster ? strip(cluster) : null,
      entries: entries.map((e) => ({ token: e.token, symbol: tmap.get(e.token)?.symbol || null, launchpad: e.launchpad, rank: e.rank, delay_s: e.delay_s, buy_near: e.buy_near, roi: e.roi, roi_now: e.roi_now, first_buy_ts: e.first_buy_ts, rugged: !!tmap.get(e.token)?.outcome?.rugged, peak_multiple: tmap.get(e.token)?.outcome?.peak_multiple ?? null, is_creator: e.is_creator })) };
  },

  '/api/tokens': async (u) => {
    const f = {};
    const q = (u.searchParams.get('q') || '').trim(); if (q) f.$or = [{ symbol: rx(q) }, { _id: rx(q) }, { creator: rx(q) }];
    const s = u.searchParams.get('status'); if (s) f.status = s;
    const lp = u.searchParams.get('launchpad'); if (lp) f.launchpad = lp;
    if (u.searchParams.get('rugged') === '1') f['outcome.rugged'] = true;
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows] = await Promise.all([col('tokens').countDocuments(f), col('tokens').find(f, { projection: { pool: 0 } }).sort({ live_ts: -1 }).skip(offset).limit(limit).toArray()]);
    return { total, rows: rows.map(strip) };
  },

  '/api/token': async (u) => {
    const id = u.searchParams.get('id');
    const t = await col('tokens').findOne({ _id: id });
    if (!t) return { error: 'not found' };
    const entries = await col('entries').find({ token: id }).sort({ rank: 1 }).toArray();
    const wallets = await col('wallets').find({ _id: { $in: entries.map((e) => e.wallet) } }, { projection: { cluster_id: 1, cluster_verdict: 1, kind: 1, funder_kind: 1, created_ts: 1, 'stats.tokens_n': 1, 'stats.win_rate': 1 } }).toArray();
    const wmap = new Map(wallets.map((w) => [w._id, w]));
    const cids = [...new Set(wallets.map((w) => w.cluster_id).filter(Boolean))];
    const clusters = await col('clusters').find({ _id: { $in: cids } }, { projection: { size: 1, verdict: 1, 'ai.label': 1, 'rule.tags': 1 } }).toArray();
    const cmap = new Map(clusters.map((c) => [c._id, c]));
    const { _id, ...rest } = t;
    return { id: _id, ...rest, entries: entries.map((e) => { const w = wmap.get(e.wallet), c = w?.cluster_id ? cmap.get(w.cluster_id) : null;
      return { wallet: e.wallet, rank: e.rank, delay_s: e.delay_s, buy_near: e.buy_near, roi: e.roi, roi_now: e.roi_now, sold_share: e.sold_share, is_creator: e.is_creator, kind: w?.kind || null, funder_kind: w?.funder_kind || null,
        wallet_age_days: w?.created_ts ? Math.round((e.first_buy_ts - w.created_ts) / 86400e3) : null, cluster: c ? { id: c._id, size: c.size, verdict: c.verdict, label: c.ai?.label || c.rule?.tags?.[0] || null } : null }; }) };
  },

  '/api/signals': async (u) => ({ rows: await buildSignals(clamp(u.searchParams.get('hours'), 72, 720), 60) }),

  '/api/logs': async (u) => {
    const f = {}; const lv = u.searchParams.get('level'); if (lv) f.level = lv;
    const rows = await col('events').find(f, { projection: { _id: 0, at: 0 } }).sort({ ts: -1 }).limit(clamp(u.searchParams.get('limit'), 200, 1000)).toArray();
    return { rows };
  },

  '/api/health': async () => ({ ok: true, now: Date.now(), ai: { enabled: aiEnabled(), ok: aiStatus.ok }, recent: recentLogs.length }),
};

const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const exposed = () => !['127.0.0.1', 'localhost', '::1'].includes(config.web.host);
function authorized(req) {
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  return !!m && safeEq(Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':'), config.web.password);
}

export function startWeb() {
  const server = http.createServer(async (req, res) => {
    try {
      if (exposed() && !authorized(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="entity tracker"' }).end('authentication required'); return; }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page); return; }
      const route = routes[u.pathname];
      if (!route) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(await route(u)));
    } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message })); }
  });
  server.listen(config.web.port, config.web.host, () => info(`web UI: http://${exposed() ? config.web.host : 'localhost'}:${config.web.port}${exposed() ? ' (password protected)' : ''}`));
  return server;
}
