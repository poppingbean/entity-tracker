// Web UI + JSON API. Read-only on-chain and read-only toward any wallet: nothing in this process can move funds.
// The only write is the SIMULATED sell button (POST /api/sim/sell), which changes paper positions in MongoDB, guarded by Basic auth
// (when exposed), a same-origin check and a custom header.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { col, metaGet, getDb } from '../db.js';
import { config } from '../config.js';
import { recentLogs, info, error } from '../log.js';
import { aiEnabled, aiStatus } from '../ai/tools/nearai.js';
import { simSell, ensureAccount, positionPnl } from '../sim/portfolio.js';
import { startFetch, jobStatus, catchUp } from '../collect/ondemand.js';
import { recomputeToken } from '../collect/rugs.js';
import { redact } from './redact.js';
import { creatorIndex, creatorBrief, creatorFlag, creatorNetwork } from '../evaluate/creators.js';
import { auditNearContract, getCachedAudit, validNearAddress, summarizeAudit, syncedScores } from '../audit/service.js';
import { TAGS, tagOf, ruggerGroup, ruggerWallet, BEHAVIOURS, TAG_GROUPS } from '../evaluate/tags.js';
import { getAnalysis } from '../analysis/token.js';
import { getNftAnalysis } from '../nft/analysis.js';
import { assessNftWithAi } from '../nft/ai.js';
import { registerCollection, syncCollection, SOURCES } from '../nft/sync.js';
import { view } from '../near/rpc.js';
import { nearUsdPrice } from '../near/quotes.js';
import { tokenSupply, lastPrice } from '../collect/supply.js';
import { TYPES, SEVERITIES } from '../alerts/store.js';
import { newKey, validKey, resolveTarget, findWatched, setWatch, getWatchlist, alertsFor, KINDS } from '../alerts/watch.js';
import { alertPayload, checkWebhookUrl } from '../alerts/deliver.js';
import { assessWithAi, getRun } from '../analysis/ai.js';
import { addFeedback, FEEDBACK_KINDS } from '../accuracy/feedback.js';
import { checkRequest, accountReputation, FIREWALL_VERSION } from '../firewall/service.js';
import { AUTO_AUDIT_V } from '../audit/auto.js';
import { contractReport, startAutoAudit, auditJob } from '../audit/report.js';
import { inspect } from '../firewall/inspect.js';
import { parseInvestigation, startInvestigation, investigationJob, confirmIncident, unconfirmIncident, clearIncident } from '../incident/service.js';
import { report } from '../incident/signals.js';
import { walletView } from '../near/walletview.js';

// the UI: a small shell page (public/index.html) and its assets (public/assets: app.css, js/core.js, js/pages/*.js, js/app.js).
// Asset links carry the server's start time (?v=) so a deploy is picked up at once while the files themselves are cached long.
const PUBLIC = new URL('./public/', import.meta.url);
const page = fs.readFileSync(new URL('index.html', PUBLIC), 'utf8').replaceAll('__V__', Date.now().toString(36));
const ASSET_TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const assetCache = new Map();
/** A file under public/assets, or null (only plain names, no "..", only known types). */
function asset(pathname) {
  const rel = pathname.replace(/^\/assets\//, '');
  if (!/^[a-z0-9_/-]+\.[a-z]+$/i.test(rel) || rel.includes('..')) return null;
  const type = ASSET_TYPES[rel.slice(rel.lastIndexOf('.'))];
  if (!type) return null;
  if (!assetCache.has(rel)) { try { assetCache.set(rel, fs.readFileSync(new URL(`assets/${rel}`, PUBLIC))); } catch { assetCache.set(rel, null); } }
  const body = assetCache.get(rel);
  return body ? { body, type } : null;
}
// Google Search Console ownership file for app.safe-near.org, served as is at /<name>.html (before the password check, so Google can read it).
const SITE_VERIFY = { '/google65675d2fcb9ab898.html': fs.readFileSync(new URL('./google65675d2fcb9ab898.html', import.meta.url), 'utf8') };
// pages of the single-page UI; each is served the same HTML and the browser routes with the History API (no # in URLs)
const UI_VIEWS = new Set(['incidents', 'firewall', 'accuracy', 'alerts', 'nfts', 'taggroups', 'analysis', 'creators', 'explore', 'audit', 'monitor', 'sim', 'scans', 'overview', 'signals', 'groups', 'entities', 'wallets', 'tokens', 'logs', 'config']);
const HIDDEN_PUBLIC = new Set(['/api/logs', '/api/config']);
const auditHits = new Map(); // ip -> [timestamps]
const analysisHits = new Map(), aiHits = new Map();
const aiRunning = new Map(); // token -> { started, error }
const watchHits = new Map(), keyHits = new Map(), feedbackHits = new Map();
/** Watchlist changes over POST (JSON body): create a key, add / remove an item, set an API key's webhook. */
const reportHits = new Map();
// these change what the Safety Check warns about: never open on a public deployment without DASHBOARD_PASSWORD
const OPERATOR_POSTS = new Set(['/api/incident/confirm', '/api/incident/unconfirm', '/api/incident/clear']);
const POSTS = {
  /** Report a hack, a drainer or stolen funds: it is investigated from the chain (never flagged on the report alone). */
  '/api/report': async (b, ip) => {
    if (limited(reportHits, ip, 10)) return { error: 'too many reports from this address, try again later' };
    return report(String(b.q || ''), { via: 'web', note: String(b.note || '') });
  },
  '/api/watch/key': async (b, ip) => {
    if (limited(keyHits, ip, 5)) return { error: 'too many keys from this address, try again later' };
    const kind = b.kind === 'api' ? 'api' : 'web', key = newKey(kind);
    await col('watchlists').insertOne({ _id: key, kind, items: [], created_ts: Date.now(), last_seen_ts: Date.now() });
    return { key };
  },
  '/api/watch': async (b, ip) => {
    if (!validKey(b.key) || b.key.startsWith('tg_')) return { error: 'a web_ or api_ key is required (POST /api/watch/key)' };
    if (limited(watchHits, ip, 60)) return { error: 'too many changes, try again in a few minutes' };
    const hint = KINDS.includes(b.kind) ? b.kind : null;
    const t = (b.remove && await findWatched(b.key, b.id, hint)) || await resolveTarget(b.id, hint);
    if (!t) return { error: 'not in the system: pick a token, group, wallet, creator or NFT collection from the list (only tokens the tracker follows can be watched)' };
    const r = await setWatch(b.key, t, !b.remove);
    return r.ok ? { ok: true, target: t, items: r.items } : { error: r.error };
  },
  '/api/watch/webhook': async (b, ip) => {
    if (!validKey(b.key) || !b.key.startsWith('api_')) return { error: 'webhooks need an api_ key' };
    if (limited(watchHits, ip, 60)) return { error: 'too many changes, try again in a few minutes' };
    if (!b.url) { await col('watchlists').updateOne({ _id: b.key }, { $unset: { webhook: '' } }); return { ok: true, webhook: null }; }
    const chk = await checkWebhookUrl(String(b.url));
    if (!chk.ok) return { error: chk.error };
    await col('watchlists').updateOne({ _id: b.key }, { $set: { webhook: String(b.url), kind: 'api' }, $setOnInsert: { items: [], created_ts: Date.now() } }, { upsert: true });
    return { ok: true, webhook: String(b.url) };
  },
  /** "This verdict is wrong": queued for review; an accepted report becomes ground truth for the accuracy numbers. */
  '/api/feedback': async (b, ip) => {
    if (limited(feedbackHits, ip, 10)) return { error: 'too many reports, try again later' };
    try { const f = await addFeedback({ kind: b.kind, id: b.id, verdict: b.verdict, note: b.note, from: b.from }); return { ok: true, id: String(f._id) }; }
    catch (e) { return { error: e.message }; }
  },
  /** Manual confirm a hack by an operator / human reviewer. */
  '/api/incident/confirm': async (b) => {
    try {
      const doc = await confirmIncident(String(b.account || '').toLowerCase().trim(), {
        source: b.source || null,
        reason: b.reason || 'Confirmed manually by operator',
        by: 'operator',
        kind: b.kind || null,
        target: b.target || null,
        loss_usd: b.loss_usd ? Number(b.loss_usd) : null,
        accounts: b.accounts || [],
      });
      return { ok: true, incident: doc };
    } catch (e) { return { error: e.message }; }
  },
  /** Revoke hack confirmation, reverting to suspected. */
  '/api/incident/unconfirm': async (b) => {
    try {
      const doc = await unconfirmIncident(String(b.account || '').toLowerCase().trim(), {
        reason: b.reason || 'Unconfirmed manually by operator',
        by: 'operator',
      });
      return { ok: true, incident: doc };
    } catch (e) { return { error: e.message }; }
  },
  /** Mark as normal fund movement (cleared), removing all flags and alerts. */
  '/api/incident/clear': async (b) => {
    try {
      const doc = await clearIncident(String(b.account || '').toLowerCase().trim(), {
        reason: b.reason || 'Normal moved funds / solver activity (cleared)',
        by: 'operator',
      });
      return { ok: true, incident: doc };
    } catch (e) { return { error: e.message }; }
  },
};
/** Market cap now of some tokens: the last trade's price x total supply (from the first check, else read once and kept on the token) x NEAR in USD.
 *  Returns Map(id -> { near, usd, last_ts }). */
/** The AI is shown as NEAR AI: which model runs behind it stays on the server. */
// JSON.stringify replacer for every API response: no model names, and no rescore_before (undo data of `rescore-gates`, it holds the old gate reasons)
const noModel = (k, v) => (k === 'model' || k === 'models' || k === 'rescore_before' ? undefined : v);
async function marketCapNow(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const usd = await nearUsdPrice().catch(() => null);
  await Promise.all(ids.map(async (id) => {
    const [sup, p] = await Promise.all([tokenSupply(id), lastPrice(id)]);
    if (!p || !(sup > 0)) return;
    const near = p.price * sup;
    out.set(id, { near: Math.round(near), usd: usd ? Math.round(near * usd) : null, last_ts: p.ts });
  }));
  return out;
}
const nftJobs = new Map();   // collection -> { started, passes, events, done, error }
/** Read a hand-added collection's whole history in the background (a pass at a time, up to 40 passes per request). */
function startNftSync(id) {
  const job = { started: Date.now(), passes: 0, events: 0, done: false, error: null };
  nftJobs.set(id, job);
  (async () => {
    for (; job.passes < 40; job.passes++) {
      const c = await col('nft_collections').findOne({ _id: id });
      const r = await syncCollection(c); job.events += r.added;
      if (r.caughtUp) { job.done = true; break; }
    }
  })().catch((e) => { job.error = e.message; }).finally(() => { job.done = true; setTimeout(() => { if (nftJobs.get(id) === job) nftJobs.delete(id); }, 30 * 60e3); });
  return job;
}
/** At most `max` calls per IP in 10 minutes. */
// ------------------------------------------------------------ transaction firewall: a public, cross-origin API for wallets and dApps
const fwHits = new Map();
/** The caller's IP: behind a proxy (Railway) every request comes from the proxy, the client is the first x-forwarded-for entry. */
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'ip';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-api-key', 'access-control-max-age': '86400' };
const FW_DOC = { name: 'Safe Near transaction firewall', version: FIREWALL_VERSION, docs: 'https://github.com/poppingbean/entity-tracker/blob/main/docs/tx-firewall.md',
  endpoints: { 'POST /api/v1/tx/check': 'check transactions before they are signed', 'GET /api/v1/account?id=<account>': 'reputation of one account', 'GET /api/v1/contract?id=<account>': 'the automated audit of a contract', 'GET /api/v1/inspect?q=<wallet | contract | tx hash | link>': 'is it safe? one answer for whatever is pasted', 'GET /api/v1/incidents': 'traced hacks and scams', 'GET /api/v1/flags?since=<ms>&min=high': 'the blocklist: every flagged account (sync with since)', 'GET /api/v1/flags/check?ids=a,b': 'are these accounts flagged?', 'GET /api/v1/incident?id=<id>': 'one incident: attacker accounts, target, losses, victims, money trail' } };
async function firewallApi(req, res, u) {
  const send = (code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }).end(JSON.stringify(body, noModel));
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }
  const keyed = config.firewall.apiKeys.includes(String(req.headers['x-api-key'] || ''));
  if (!keyed && limited(fwHits, clientIp(req), config.firewall.perIp10Min)) { send(429, { error: `rate limit: ${config.firewall.perIp10Min} requests per 10 minutes per IP (ask for an API key for more)` }); return; }
  if (u.pathname === '/api/v1' || u.pathname === '/api/v1/') { send(200, FW_DOC); return; }
  if (u.pathname === '/api/v1/inspect' && req.method === 'GET') {
    const q = String(u.searchParams.get('q') || '').trim().slice(0, 300);
    if (!q) { send(400, { error: 'q: a wallet, a contract or a transaction hash' }); return; }
    try { send(200, await inspect(q)); } catch (e) { send(400, { error: e.message }); }
    return;
  }
  // the blocklist feed: every flagged account (incident accounts, reported drainers), for swap services, bridges, exchanges and wallets
  if (u.pathname === '/api/v1/flags' && req.method === 'GET') {
    const since = Number(u.searchParams.get('since')) || 0, min = ['critical', 'high', 'medium'].indexOf(u.searchParams.get('min') || 'medium');
    const sev = ['critical', 'high', 'medium'].slice(0, (min < 0 ? 2 : min) + 1);
    const rows = await col('firewall_flags').find({ ts: { $gt: since }, severity: { $in: sev } }, { projection: { severity: 1, reason: 1, incident: 1, source: 1, ts: 1 } }).sort({ ts: 1 }).limit(10000).toArray();
    const updated = rows.length ? rows[rows.length - 1].ts : since;
    res.setHeader('etag', `"flags-${updated}-${rows.length}"`);
    if (req.headers['if-none-match'] === `"flags-${updated}-${rows.length}"`) { res.writeHead(304, CORS).end(); return; }
    send(200, { updated_ts: updated, count: rows.length, next: `/api/v1/flags?since=${updated}`, flags: rows.map((f) => ({ account: f._id, severity: f.severity, reason: f.reason, incident: f.incident || null, source: f.source || 'reported', ts: f.ts })) });
    return;
  }
  if (u.pathname === '/api/v1/flags/check' && req.method === 'GET') {
    const ids = String(u.searchParams.get('ids') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 100);
    if (!ids.length) { send(400, { error: 'ids: up to 100 accounts, comma separated' }); return; }
    const rows = await col('firewall_flags').find({ _id: { $in: ids } }, { projection: { severity: 1, reason: 1, incident: 1, ts: 1 } }).toArray();
    send(200, { checked: ids.length, flagged: Object.fromEntries(rows.map((f) => [f._id, { severity: f.severity, reason: f.reason, incident: f.incident || null, ts: f.ts }])) });
    return;
  }
  if (u.pathname === '/api/v1/incidents' && req.method === 'GET') {
    const rows = await col('incidents').find({ status: 'confirmed' }, { projection: { status: 1, kind: 1, 'attacker.account': 1, 'target.account': 1, stolen_usd: 1, held_usd: 1, started_ts: 1, 'ai.headline': 1, 'trail.exit_usd': 1 } }).sort({ started_ts: -1 }).limit(100).toArray();
    send(200, { incidents: rows }); return;
  }
  if (u.pathname === '/api/v1/incident' && req.method === 'GET') {
    const doc = await col('incidents').findOne({ _id: String(u.searchParams.get('id') || '') }, { projection: { trail: { moves: 0 } } });
    send(doc ? 200 : 404, doc || { error: 'no such incident' }); return;
  }
  if (u.pathname === '/api/v1/contract' && req.method === 'GET') {
    const id = String(u.searchParams.get('id') || '').trim().toLowerCase();
    if (!validNearAddress(id)) { send(400, { error: 'id must be a NEAR account' }); return; }
    send(200, await contractReport(id)); return;
  }
  if (u.pathname === '/api/v1/account' && req.method === 'GET') {
    const id = String(u.searchParams.get('id') || '').trim().toLowerCase();
    if (!validNearAddress(id)) { send(400, { error: 'id must be a NEAR account' }); return; }
    send(200, await accountReputation(id)); return;
  }
  if (u.pathname === '/api/v1/tx/check' && req.method === 'POST') {
    const chunks = []; let size = 0;
    for await (const d of req) { size += d.length; if (size > config.firewall.maxBodyBytes) { send(413, { error: `body over ${config.firewall.maxBodyBytes} bytes` }); return; } chunks.push(d); }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { send(400, { error: 'invalid JSON' }); return; }
    try { send(200, await checkRequest(body)); } catch (e) { send(400, { error: e.message }); }
    return;
  }
  send(404, { error: 'not found', ...FW_DOC });
}

// ------------------------------------------------------------ Agent Guard: the checks as MCP tools for AI agents (src/agent/mcp.js)
// Stateless Streamable HTTP: every POST gets its own server and transport, so it works behind a proxy with any number of instances. It
// shares the firewall API's rate limit and API keys.
const MCP_CORS = { ...CORS, 'access-control-allow-headers': 'content-type, x-api-key, mcp-session-id, mcp-protocol-version, last-event-id', 'access-control-expose-headers': 'mcp-session-id' };
let agentApi = null;
async function mcpEndpoint(req, res) {
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...MCP_CORS }).end(JSON.stringify(body));
  if (req.method === 'OPTIONS') { res.writeHead(204, MCP_CORS).end(); return; }
  if (req.method !== 'POST') {
    json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Safe Near Agent Guard: MCP over Streamable HTTP, POST only (stateless). Add it to your agent: https://github.com/poppingbean/entity-tracker/blob/main/docs/agent-guard.md' }, id: null });
    return;
  }
  const keyed = config.firewall.apiKeys.includes(String(req.headers['x-api-key'] || ''));
  if (!keyed && limited(fwHits, clientIp(req), config.firewall.perIp10Min)) { json(429, { jsonrpc: '2.0', error: { code: -32000, message: `rate limit: ${config.firewall.perIp10Min} requests per 10 minutes per IP` }, id: null }); return; }
  const chunks = []; let size = 0;
  for await (const d of req) { size += d.length; if (size > config.firewall.maxBodyBytes) { json(413, { jsonrpc: '2.0', error: { code: -32000, message: 'body too large' }, id: null }); return; } chunks.push(d); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json(400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }); return; }
  const [{ createAgentGuard }, { localApi }, { StreamableHTTPServerTransport }] = await Promise.all([
    import('../agent/mcp.js'), import('../agent/api.js'), import('@modelcontextprotocol/sdk/server/streamableHttp.js')]);
  agentApi ||= await localApi();
  const server = createAgentGuard(agentApi);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  for (const [k, v] of Object.entries(MCP_CORS)) res.setHeader(k, v);
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function limited(map, ip, max) {
  const now = Date.now(), list = (map.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  if (list.length >= max) { map.set(ip, list); return true; }
  list.push(now); map.set(ip, list); return false;
}
const reanalyseHits = new Map(); // ip -> [timestamps]: a re-analysis reads only stored trades, but is still a DB-heavy write
const fetchHits = new Map();
function fetchAllowed(ip) {
  const now = Date.now(), list = (fetchHits.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  if (list.length >= 10) { fetchHits.set(ip, list); return false; }
  list.push(now); fetchHits.set(ip, list); return true;
}
function auditAllowed(ip) {
  const now = Date.now(), list = (auditHits.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  if (list.length >= 30) { auditHits.set(ip, list); return false; }
  list.push(now); auditHits.set(ip, list); return true;
}
const clamp = (v, d, max) => Math.min(max, Math.max(1, Number(v) || d));
const rx = (s) => ({ $regex: String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' });
const strip = ({ _id, ...r }) => ({ id: _id, ...r });

/** For each token: how its early NEAR splits across win-rate tags (a wallet counts with its group's tag, or its own when it has no group), plus the groups involved. */
async function earlyMix(tokenIds) {
  const out = new Map();
  if (!tokenIds.length) return out;
  const entries = await col('entries').find({ token: { $in: tokenIds } }, { projection: { token: 1, wallet: 1, buy_near: 1 } }).toArray();
  const wallets = await col('wallets').find({ _id: { $in: [...new Set(entries.map((e) => e.wallet))] } }, { projection: { cluster_id: 1, tag: 1, creator: 1 } }).toArray();
  const wmap = new Map(wallets.map((w) => [w._id, w]));
  const cids = [...new Set(wallets.map((w) => w.cluster_id).filter(Boolean))];
  const clusters = await col('clusters').find({ _id: { $in: cids } }, { projection: { tag: 1, size: 1, 'ai.label': 1, 'rule.tags': 1, creator_flag: 1 } }).toArray();
  const cmap = new Map(clusters.map((c) => [c._id, c]));
  for (const t of tokenIds) out.set(t, { wallets: 0, total_near: 0, ...Object.fromEntries(TAGS.map((v) => [v, { w: 0, near: 0 }])), rugger: { w: 0, near: 0 }, groups: new Map() });
  for (const e of entries) {
    const m = out.get(e.token), w = wmap.get(e.wallet), c = w?.cluster_id ? cmap.get(w.cluster_id) : null;
    const v = tagOf(c ? c.tag : w?.tag);
    m.wallets++; m.total_near += e.buy_near; m[v].w++; m[v].near += e.buy_near;
    if (ruggerWallet(w, c)) { m.rugger.w++; m.rugger.near += e.buy_near; }
    if (c) { const g = m.groups.get(c._id) || { id: c._id, tag: tagOf(c.tag), label: c.ai?.label || c.rule?.tags?.[0] || null, size: c.size, rugger: ruggerGroup(c), wallets: 0, near: 0 }; g.wallets++; g.near += e.buy_near; m.groups.set(c._id, g); }
  }
  for (const m of out.values()) m.groups = [...m.groups.values()].sort((a, b) => b.near - a.near);
  return out;
}

/** For each recent token: how much of its early money comes from winners (win80 / win50 / sniper) and from loss wallets. */
async function buildSignals(hours = 72, limit = 60) {
  const since = Date.now() - hours * 3600e3;
  const tokens = await col('tokens').find({ live_ts: { $gt: since }, entries_n: { $gt: 0 } }).sort({ live_ts: -1 }).limit(limit).toArray();
  const mix = await earlyMix(tokens.map((t) => t._id));
  const out = [];
  for (const t of tokens) {
    const m = mix.get(t._id), total = m.total_near || 1;
    const win = { w: m.win80.w + m.win50.w + m.sniper.w, near: m.win80.near + m.win50.near + m.sniper.near }, loss = m.loss; // money makers: high hit rate or snipers
    const lossShare = loss.near / total, winShare = win.near / total;
    // rug wallets among the early buyers come first: they matter more than who wins
    const assessment = m.rugger.w ? 'rugger' : lossShare >= 0.25 ? 'warning' : win.w >= 2 && lossShare < 0.1 ? 'bullish' : win.w + loss.w + m.win30.w ? 'mixed' : 'no-known-groups';
    if (assessment === 'no-known-groups') continue;
    out.push({ token: t._id, symbol: t.symbol, launchpad: t.launchpad, live_ts: t.live_ts, status: t.status, early_wallets: m.wallets, total_near: total, win, loss, win_share: winShare, loss_share: lossShare, assessment,
      rugger: m.rugger, rugger_share: m.rugger.near / total,
      mix: Object.fromEntries(TAGS.map((v) => [v, m[v]])), groups: m.groups.filter((g) => g.tag !== 'unrated' || g.rugger).sort((a, b) => (b.rugger ? 1 : 0) - (a.rugger ? 1 : 0) || b.near - a.near),
      outcome: t.outcome ? { rugged: t.outcome.rugged, rug_kinds: t.outcome.rug_kinds || [], peak_multiple: t.outcome.peak_multiple, last_multiple: t.outcome.last_multiple, age_min: t.outcome.age_min, now_multiple: t.ledger?.last_multiple ?? null, done: t.status === 'done' } : null });
  }
  return out;
}

/** The part of a creator's network a token page shows: its first real funder and what the creators tied to it did. */
const netBrief = (x) => (x?.profiled ? { profiled: true, funder: x.funders.find((f) => f.link) || x.funders[0] || null, network: x.network, siblings: x.siblings.slice(0, 8).map((s) => ({ account: s.account, launches: s.launches, rugged: s.rugged, blacklisted: s.blacklisted, relations: s.relations.slice(0, 2) })) } : x ? { profiled: false } : null);

/** Trading volume over the last 24 h per token (NEAR bought + sold, trades, distinct traders), largest first, from the stored trades. */
async function volume24(tokenIds = null, limit = 0) {
  return col('trades').aggregate([
    { $match: { ts: { $gt: Date.now() - 24 * 3600e3 }, ...(tokenIds ? { token: { $in: tokenIds } } : {}) } },
    { $group: { _id: '$token', near: { $sum: '$near' }, buy_near: { $sum: { $cond: ['$buy', '$near', 0] } }, sell_near: { $sum: { $cond: ['$buy', 0, '$near'] } }, trades: { $sum: 1 }, traders: { $addToSet: '$trader' } } },
    { $project: { near: 1, buy_near: 1, sell_near: 1, trades: 1, traders: { $size: '$traders' } } },
    { $sort: { near: -1 } }, ...(limit ? [{ $limit: limit }] : []),
  ]).toArray();
}
const volBrief = (v) => (v ? { near: v.near, buy_near: v.buy_near, sell_near: v.sell_near, trades: v.trades, traders: v.traders } : null);

const routes = {
  '/api/overview': async () => {
    const [tokStatus, clusterTag, wallets, profiled, entries, worker, latest, topWin, topLoss, tokens, rugged, netWallets, blacklisted, groupsWithCreators, vol] = await Promise.all([
      col('tokens').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
      col('clusters').aggregate([{ $group: { _id: '$tag', n: { $sum: 1 }, wallets: { $sum: '$size' } } }]).toArray(),
      col('wallets').countDocuments({ is_early: true }), col('wallets').countDocuments({ is_early: true, profiled: true }), col('entries').estimatedDocumentCount(),
      metaGet('worker'), col('tokens').find({}, { projection: { symbol: 1, launchpad: 1, live_ts: 1, status: 1, entries_n: 1, 'outcome.rugged': 1, 'outcome.peak_multiple': 1, 'scan.score': 1, 'scan.pass': 1 } }).sort({ live_ts: -1 }).limit(10).toArray(),
      col('clusters').find({ tag: { $in: ['win80', 'win50', 'sniper'] } }, { projection: { tag: 1, size: 1, score: 1, 'metrics.tokens_n': 1, 'metrics.profit_rate': 1, 'metrics.pnl_near': 1, 'ai.label': 1 } }).sort({ 'metrics.profit_rate': -1, 'metrics.pnl_near': -1 }).limit(5).toArray(),
      col('clusters').find({ tag: 'loss' }, { projection: { tag: 1, size: 1, score: 1, 'metrics.tokens_n': 1, 'metrics.profit_rate': 1, 'metrics.pnl_near': 1, 'metrics.rug_share': 1, 'rule.tags': 1, 'ai.label': 1 } }).sort({ size: -1, 'metrics.pnl_near': 1 }).limit(5).toArray(),
      col('tokens').estimatedDocumentCount(), col('tokens').countDocuments({ 'outcome.rugged': true }), col('wallets').countDocuments({ net: true, profiled: true }),
      col('blacklist').estimatedDocumentCount(), col('clusters').countDocuments({ creator_flag: { $in: ['blacklisted', 'rugger'] } }),
      volume24(null, 10),
    ]);
    const volToks = new Map((await col('tokens').find({ _id: { $in: vol.map((v) => v._id) } }, { projection: { symbol: 1, launchpad: 1, live_ts: 1, 'outcome.rugged': 1, 'outcome.last_multiple': 1, 'ledger.last_multiple': 1, 'scan.score': 1, 'scan.pass': 1 } }).toArray()).map((t) => [t._id, t]));
    const topVolume = vol.filter((v) => volToks.has(v._id)).map((v) => { const t = volToks.get(v._id); return { id: v._id, symbol: t.symbol, launchpad: t.launchpad, live_ts: t.live_ts, rugged: !!t.outcome?.rugged, scan: t.scan ? { score: t.scan.score, pass: t.scan.pass } : null, now_multiple: t.ledger?.last_multiple ?? t.outcome?.last_multiple ?? null, vol24: volBrief(v) }; });
    return {
      now: Date.now(), tokens, tokenStatus: tokStatus.map((r) => ({ status: r._id, n: r.n })), clusterTag: clusterTag.map((r) => ({ tag: tagOf(r._id), n: r.n, wallets: r.wallets })), rugged, netWallets, blacklisted, groupsWithCreators,
      wallets, profiled, entries, worker, latest: latest.map(strip), topWin: topWin.map(strip), topLoss: topLoss.map(strip), topVolume,
      ai: { enabled: aiEnabled(), ...(worker?.ai || {}) }, db: config.mongo.dbName,
    };
  },

  '/api/clusters': async (u) => {
    const f = {};
    const v = u.searchParams.get('tag'); if (v) f.tag = v === 'unrated' ? { $nin: ['win80', 'win50', 'win30', 'sniper', 'loss'] } : v;
    const q = (u.searchParams.get('q') || '').trim(); if (q) f.$or = [{ members: q }, { 'network.account': q }, { _id: rx(q) }, { 'ai.label': rx(q) }];
    const minSize = Number(u.searchParams.get('minSize')); if (minSize) f.size = { $gte: minSize };
    const sort = { score: { score: -1 }, size: { size: -1 }, pnl: { 'metrics.pnl_near': -1 }, winrate: { 'metrics.profit_rate': -1, 'metrics.tokens_n': -1 }, recent: { 'metrics.last_entry_ts': -1 } }[u.searchParams.get('sort')] || { size: -1 };
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows] = await Promise.all([col('clusters').countDocuments(f),
      col('clusters').find(f, { projection: { nodes: 0, links: 0, tokens: 0, members: 0, network: 0, 'ai.reasons': 0, 'ai.red_flags': 0, 'ai.usage': 0 } }).sort(sort).skip(offset).limit(limit).toArray()]);
    return { total, rows: rows.map(strip) };
  },

  // ------------------------------------------------------------ tag groups: early wallets by what they do (win-rate tag, behaviours)
  '/api/tag-groups': async () => {
    const base = { is_early: true, profiled: true };
    const facet = (match) => [{ $match: match }, { $group: { _id: null, wallets: { $sum: 1 }, linked: { $sum: { $cond: [{ $ifNull: ['$cluster_id', false] }, 1, 0] } },
      near: { $sum: { $ifNull: ['$stats.total_buy_near', 0] } }, pnl: { $sum: { $ifNull: ['$stats.pnl_near', 0] } }, profit: { $avg: '$stats.profit_rate' } } }];
    const tagFilter = (t) => (t === 'unrated' ? { tag: { $nin: TAGS.filter((x) => x !== 'unrated') } } : { tag: t });
    const res = await Promise.all(TAG_GROUPS.map((id) => col('wallets').aggregate(facet({ ...base, ...(BEHAVIOURS[id] ? { behaviours: id } : tagFilter(id)) })).toArray()));
    return { rows: TAG_GROUPS.map((id, i) => { const r = res[i][0] || {}; return { id, kind: BEHAVIOURS[id] ? 'behaviour' : 'tag', about: BEHAVIOURS[id] || null, wallets: r.wallets || 0, linked: r.linked || 0, standalone: (r.wallets || 0) - (r.linked || 0), near: r.near || 0, pnl_near: r.pnl || 0, profit_rate: r.profit ?? null }; }) };
  },
  '/api/tag-group': async (u) => {
    const id = u.searchParams.get('id');
    if (!TAG_GROUPS.includes(id)) return { error: 'not found' };
    const f = { is_early: true, profiled: true, ...(BEHAVIOURS[id] ? { behaviours: id } : id === 'unrated' ? { tag: { $nin: TAGS.filter((x) => x !== 'unrated') } } : { tag: id }) };
    const only = u.searchParams.get('only'); if (only === 'standalone') f.cluster_id = null; else if (only === 'linked') f.cluster_id = { $ne: null };
    const sort = { pnl: { 'stats.pnl_near': -1 }, near: { 'stats.total_buy_near': -1 }, tokens: { 'stats.tokens_n': -1 }, profit: { 'stats.profit_rate': -1, 'stats.tokens_n': -1 } }[u.searchParams.get('sort')] || { 'stats.pnl_near': -1 };
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows] = await Promise.all([col('wallets').countDocuments(f), col('wallets').find(f, { projection: { tag: 1, behaviours: 1, cluster_id: 1, cluster_tag: 1, stats: 1, cobuy_partners: 1, created_ts: 1 } }).sort(sort).skip(offset).limit(limit).toArray()]);
    return { id, kind: BEHAVIOURS[id] ? 'behaviour' : 'tag', about: BEHAVIOURS[id] || null, total,
      rows: rows.map((w) => ({ id: w._id, tag: tagOf(w.tag), behaviours: w.behaviours || [], cluster_id: w.cluster_id || null, cluster_tag: w.cluster_id ? tagOf(w.cluster_tag) : null, cobuy_n: (w.cobuy_partners || []).length, stats: w.stats || {} })) };
  },

  '/api/cluster': async (u) => {
    const c = await col('clusters').findOne({ _id: u.searchParams.get('id') });
    if (!c) return { error: 'not found' };
    const wallets = await col('wallets').find({ _id: { $in: c.members } }).toArray();
    wallets.sort((a, b) => (b.stats?.total_buy_near || 0) - (a.stats?.total_buy_near || 0));
    const history = await col('cluster_history').find({ cluster_id: c._id }).sort({ ts: -1 }).limit(30).toArray();
    const { _id, ...rest } = c;
    // the linked wallets around the group (up to 3 hops): which kind they are and whether they trade launch tokens themselves
    const netIds = (c.network || []).map((x) => x.account);
    const [netDocs, netTrades] = netIds.length ? await Promise.all([
      col('wallets').find({ _id: { $in: netIds } }, { projection: { kind: 1, profiled: 1, is_early: 1, tx_count: 1 } }).toArray(),
      col('trades').aggregate([{ $match: { trader: { $in: netIds } } }, { $group: { _id: '$trader', tokens: { $addToSet: '$token' }, near: { $sum: '$near' } } }]).toArray(),
    ]) : [[], []];
    const nd = new Map(netDocs.map((x) => [x._id, x])), nt = new Map(netTrades.map((x) => [x._id, x]));
    const network = (c.network || []).map((x) => ({ ...x, kind: nd.get(x.account)?.kind || null, profiled: !!nd.get(x.account)?.profiled, tx_count: nd.get(x.account)?.tx_count ?? null, tokens_traded: nt.get(x.account)?.tokens.length || 0, traded_near: nt.get(x.account)?.near || 0 }));
    return { id: _id, ...rest, network, wallets: wallets.map((w) => ({ id: w._id, kind: w.kind, tx_count: w.tx_count, created_ts: w.created_ts, funder: w.funder, funder_kind: w.funder_kind, funding_near: w.funding_near, chain: w.chain, stats: w.stats, flow_out_total: w.flow_out_total })), history: history.map(({ _id: x, ...h }) => h) };
  },

  /** Nodes and edges for the funding / flow picture of one group. */
  '/api/graph': async (u) => {
    const c = await col('clusters').findOne({ _id: u.searchParams.get('id') }, { projection: { members: 1, nodes: 1 } });
    if (!c) return { error: 'not found' };
    const members = new Set(c.members), nodeList = c.nodes?.length ? c.nodes : c.members;
    const edges = await col('edges').find({ $or: [{ type: 'fund', to: { $in: nodeList } }, { type: 'flow', from: { $in: nodeList } }] }).limit(3000).toArray();
    // flows only matter when they reach another member or a destination that more than one member pays
    const payers = new Map();
    for (const e of edges) if (e.type === 'flow') (payers.get(e.to) || payers.set(e.to, new Set()).get(e.to)).add(e.from);
    const nodeSet = new Set(nodeList);
    const keep = edges.filter((e) => e.type === 'fund' || members.has(e.to) || nodeSet.has(e.to) || (payers.get(e.to)?.size || 0) >= 2).slice(0, 500);
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
    const sort = { funded: { funded_n: -1 }, near: { funded_near: -1 }, sink: { sink_near: -1 }, tokens: { tokens_n: -1 }, pnl: { funded_pnl_near: -1 }, creators: { creators_funded_n: -1 }, rugcreators: { creators_rugged_n: -1, creators_funded_n: -1 } }[u.searchParams.get('sort')] || { funded_n: -1 };
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows, types] = await Promise.all([col('entities').countDocuments(f),
      col('entities').find(f, { projection: { funded_wallets: 0, sink_wallets: 0, creators_funded: 0, creator_sinks: 0 } }).sort(sort).skip(offset).limit(limit).toArray(),
      col('entities').aggregate([{ $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()]);
    return { total, rows: rows.map(strip), types: types.map((x) => ({ type: x._id, n: x.n })) };
  },

  '/api/entity': async (u) => {
    const e = await col('entities').findOne({ _id: u.searchParams.get('id') });
    if (!e) return { error: 'not found' };
    const { _id, ...rest } = e;
    return { id: _id, ...rest };
  },

  // ------------------------------------------------------------ scanner monitor + simulated investing
  '/api/monitor': async () => {
    const now = Date.now(), day = now - 24 * 3600e3;
    const [recent, c24, scanned, passed, bought, polls, newTokens, ruggedTotal, tokensTotal] = await Promise.all([
      col('tokens').find({}, { projection: { symbol: 1, launchpad: 1, live_ts: 1, status: 1, scan: 1, scan_done: 1, entries_n: 1, 'outcome.rugged': 1, 'outcome.peak_multiple': 1, 'outcome.last_multiple': 1, 'ledger.last_multiple': 1, creator: 1 } }).sort({ live_ts: -1 }).limit(40).toArray(),
      col('tokens').countDocuments({ live_ts: { $gt: day } }), col('tokens').countDocuments({ live_ts: { $gt: day }, scan_done: true, 'scan.score': { $exists: true } }),
      col('tokens').countDocuments({ live_ts: { $gt: day }, 'scan.pass': true }), col('sim_positions').countDocuments({ opened_ts: { $gt: day } }),
      Promise.all(config.launchpads.map(async (p) => ({ launchpad: p, ...(await metaGet(`poll:${p}`)) }))), col('tokens').countDocuments({ live_ts: { $gt: now - 3 * 3600e3 } }),
      col('tokens').countDocuments({ 'outcome.rugged': true }), col('tokens').estimatedDocumentCount(),
    ]);
    const worker = await metaGet('worker');
    return { now, scan: config.scan, window24h: { launches: c24, scanned, passed, bought }, launchesLast3h: newTokens, ruggedTotal, tokensTotal, polls, worker, ai: { enabled: aiEnabled(), ...(worker?.ai || {}) },
      rows: recent.map((t) => ({ id: t._id, symbol: t.symbol, launchpad: t.launchpad, live_ts: t.live_ts, status: t.status, scan: t.scan || null, scan_done: !!t.scan_done, entries_n: t.entries_n ?? null, rugged: !!t.outcome?.rugged, peak_multiple: t.outcome?.peak_multiple ?? null, last_multiple: t.outcome?.last_multiple ?? null, now_multiple: t.ledger?.last_multiple ?? null })) };
  },

  '/api/sim/overview': async () => {
    const a = await ensureAccount();
    const [open, closed, equity, today] = await Promise.all([
      col('sim_positions').find({ status: 'open' }, { projection: { value_near: 1, cost_near: 1, realized_near: 1, held_tokens: 1, entry_price: 1, status: 1 } }).toArray(), col('sim_positions').find({ status: 'closed' }, { projection: { cost_near: 1, realized_near: 1, status: 1 } }).toArray(),
      col('sim_equity').find().sort({ ts: -1 }).limit(600).toArray(), col('sim_positions').countDocuments({ opened_ts: { $gt: Date.now() - 86400e3 } }),
    ]);
    const openValue = open.reduce((s, p) => s + (p.value_near || 0), 0), openCost = open.reduce((s, p) => s + Math.max(0, p.cost_near - (p.realized_near || 0)), 0);
    const equityNow = a.cash_near + openValue;
    const pn = [...open, ...closed].map(positionPnl), realizedPnl = pn.reduce((s, x) => s + x.realized_pnl, 0), unrealizedPnl = pn.reduce((s, x) => s + x.unrealized_pnl, 0);
    return { realized_pnl: realizedPnl, unrealized_pnl: unrealizedPnl, account: { start_near: a.start_near, cash_near: a.cash_near, realized_near: a.realized_near, created_ts: a.created_ts }, open_n: open.length, closed_n: closed.length, open_value: openValue, open_cost: openCost,
      equity: equityNow, pnl_near: equityNow - a.start_near, pnl_pct: (equityNow - a.start_near) / a.start_near, buys_today: today, equity_series: equity.reverse().map((e) => ({ ts: e.ts, equity: e.equity })),
      limits: { buyNear: config.sim.buyNear, highRiskBuyNear: config.sim.highRiskBuyNear, maxOpenCostNear: config.sim.maxOpenCostNear, maxBuysPerDay: config.sim.maxBuysPerDay, minReserveNear: config.sim.minReserveNear } };
  },

  '/api/sim/positions': async (u) => {
    const st = u.searchParams.get('status') || 'open';
    const rows = await col('sim_positions').find(st === 'all' ? {} : { status: st }).sort(st === 'closed' ? { 'exit.ts': -1 } : { opened_ts: -1 }).limit(300).toArray();
    return { rows: rows.map((p) => ({ ...strip(p), ...positionPnl(p) })) };
  },

  '/api/sim/position': async (u) => {
    const id = u.searchParams.get('id');
    const p = await col('sim_positions').findOne({ _id: id });
    if (!p) return { error: 'not found' };
    const fills = await col('sim_fills').find({ position_id: id }).sort({ ts: 1 }).toArray();
    const scans = await col('scans').find({ token: p.token }, { projection: { features: 0 } }).sort({ ts: 1 }).toArray();
    const { _id, ...rest } = p;
    return { id: _id, ...rest, ...positionPnl(p), fills: fills.map(({ _id: x, position_id, ...f }) => f), scans: scans.map(strip) };
  },

  '/api/scans': async (u) => {
    const f = {};
    const kind = u.searchParams.get('kind'); if (kind) f.kind = kind;
    const pass = u.searchParams.get('pass'); if (pass === '1' || pass === '0') f.pass = pass === '1';
    if (u.searchParams.get('bought') === '1') f['trade.status'] = 'bought';
    const q = (u.searchParams.get('q') || '').trim(); if (q) f.$or = [{ symbol: rx(q) }, { token: rx(q) }];
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows] = await Promise.all([col('scans').countDocuments(f), col('scans').find(f, { projection: { features: 0, ai: 0 } }).sort({ ts: -1 }).skip(offset).limit(limit).toArray()]);
    return { total, rows: rows.map(strip) };
  },

  '/api/scan': async (u) => {
    const s = await col('scans').findOne({ _id: u.searchParams.get('id') });
    if (!s) return { error: 'not found' };
    const { _id, ...rest } = s;
    return { id: _id, ...rest };
  },

  '/api/config': async () => ({ scan: config.scan, rules: config.rules, analyst: config.analyst, sim: config.sim, followUp: config.followUp, entry: config.entry, outcome: config.outcome, launchpads: config.launchpads, ai: { enabled: aiEnabled(), provider: 'NEAR AI' }, db: config.mongo.dbName }),

  // ------------------------------------------------------------ contract audit
  '/api/audit': async (u, req) => {
    const address = (u.searchParams.get('address') || '').trim().toLowerCase();
    if (!validNearAddress(address)) return { error: 'invalid NEAR account id' };
    const force = u.searchParams.get('force') === '1';
    const cached = await getCachedAudit(address);
    const fresh = cached && Date.now() - cached.fetchedAt < 3600e3;
    if (!(fresh && !force) && !auditAllowed(req.socket.remoteAddress || 'ip')) return { error: 'too many audits, try again in a few minutes' };
    const doc = await auditNearContract(address, { force });
    const { _id, ...rest } = doc;
    const full = doc.auto ? doc : { ...doc, auto: (await getCachedAudit(address))?.auto }; // the automated audit lives on the same record
    return { id: _id, ...rest, summary: summarizeAudit(full), synced: syncedScores(full), cached: !!(fresh && !force) };
  },

  /** Fetch a token the tracker has not seen: find its launch, read trades and early buyers, audit and analyse it (background job). */
  /** Re-apply the latest rug rules to one token from its stored trades (no chain reads): outcome, rug verdict, early buyers' ROI. */
  '/api/reanalyse': async (u, req) => {
    const id = (u.searchParams.get('id') || '').trim().toLowerCase();
    if (!validNearAddress(id)) return { error: 'invalid NEAR account id' };
    const t = await col('tokens').findOne({ _id: id });
    if (!t) return { error: 'not found' };
    if (limited(reanalyseHits, req.socket.remoteAddress || 'ip', 20)) return { error: 'too many re-analyses, try again in a few minutes' };
    const n = await recomputeToken(t);
    if (n == null) return { error: 'no trades stored yet: use Sync now first' };
    const o = (await col('tokens').findOne({ _id: id }, { projection: { outcome: 1 } }))?.outcome || {};
    return { ok: true, rugged: !!o.rugged, rug_kinds: o.rug_kinds || [], trades: o.rug_basis?.trades ?? null, was_rugged: !!t.outcome?.rugged };
  },

  '/api/fetch-token': async (u, req) => {
    const id = (u.searchParams.get('id') || '').trim().toLowerCase();
    if (!validNearAddress(id)) return { error: 'invalid NEAR account id' };
    const cur = jobStatus(id);
    if (!cur || cur.state !== 'running') {
      if (!fetchAllowed(req.socket.remoteAddress || 'ip')) return { error: 'too many fetches, try again in a few minutes' };
      return { id, ...startFetch(id) };
    }
    return { id, ...cur };
  },
  '/api/fetch-status': async (u) => {
    const id = (u.searchParams.get('id') || '').trim().toLowerCase();
    const job = jobStatus(id);
    const exists = !!(await col('tokens').findOne({ _id: id }, { projection: { _id: 1 } }));
    return { id, exists, ...(job || { state: 'none' }) };
  },

  /** The automated audit for the audit page: the stored one, or start one in this process (the web-only server has no queue). */
  '/api/audit-auto': async (u, req) => {
    const id = (u.searchParams.get('address') || '').trim().toLowerCase();
    if (!validNearAddress(id)) return { error: 'invalid NEAR account id' };
    const doc = await col('audits').findOne({ _id: id }, { projection: { auto: 1 } });
    const job = auditJob(id);
    const want = u.searchParams.get('run') === '1' && (!doc?.auto || doc.auto.v !== AUTO_AUDIT_V || u.searchParams.get('force') === '1');
    if (want && !job?.running) {
      if (!auditAllowed(req.socket.remoteAddress || 'ip')) return { error: 'too many audits, try again in a few minutes' };
      startAutoAudit(id, { force: u.searchParams.get('force') === '1' });
    }
    const cur = auditJob(id);
    return { id, auto: doc?.auto || null, current: doc?.auto?.v === AUTO_AUDIT_V, job: cur ? { running: cur.running, started: cur.started, error: cur.error } : null };
  },
  /** The live security feed: where the chain watch is, new contracts as they are audited, drains caught live and traced hacks. */
  '/api/security/live': async (u) => {
    const only = u.searchParams.get('only'); // '' | hacks | contracts | risky
    const day = Date.now() - 86400e3;
    const minLiveUsd = config.incidents.liveMinUsd || 100000;
    // moves are shown only for cases still confirmed: a case cleared later (a false alarm) takes its moves with it
    const proven = await col('incidents').distinct('_id', { status: 'confirmed' }).catch(() => []);
    const [moves, news, reports] = only === 'contracts' || only === 'risky' ? [[], [], []] : await Promise.all([
      col('incident_moves').find({ incident: { $in: proven }, usd: { $gte: minLiveUsd } }).sort({ ts: -1 }).limit(20).toArray().catch(() => []),
      col('security_news').find({}).sort({ ts: -1 }).limit(10).toArray().catch(() => []),
      col('reports').find({}).sort({ last_ts: -1 }).limit(10).toArray().catch(() => []),
    ]);
    const [watchMeta, cursor, deploys, detections, incidents, counts] = await Promise.all([
      metaGet('security:watch'), col('meta').findOne({ _id: 'audit:deploy_cursor' }),
      only === 'hacks' ? [] : col('contract_deploys').find({}, { projection: { account: 1, kind: 1, by: 1, signer: 1, ts: 1 } }).sort({ ts: -1 }).limit(only === 'risky' ? 400 : 60).toArray(),
      only === 'contracts' || only === 'risky' ? [] : col('incident_detections').find({ usd: { $gte: minLiveUsd } }).sort({ ts: -1 }).limit(20).toArray(),
      only === 'contracts' || only === 'risky' ? [] : col('incidents').find({ status: 'confirmed', stolen_usd: { $gte: minLiveUsd } }, { projection: { status: 1, kind: 1, 'attacker.account': 1, 'target.account': 1, drain: 1, stolen_usd: 1, held_usd: 1, started_ts: 1, first_seen_ts: 1, 'ai.headline': 1, 'ai.attack_type': 1, 'trail.exit_usd': 1, detected: 1 } }).sort({ first_seen_ts: -1 }).limit(20).toArray(),
      Promise.all([col('contract_deploys').countDocuments({ ts: { $gt: day } }), col('audits').countDocuments({ 'auto.ts': { $gt: day } }), col('audits').countDocuments({ 'auto.ts': { $gt: day }, 'auto.level': { $in: ['high', 'critical'] } }),
        col('incident_detections').countDocuments({ ts: { $gt: day }, usd: { $gte: minLiveUsd } }), col('incidents').countDocuments({ status: 'confirmed', stolen_usd: { $gte: minLiveUsd }, $or: [{ started_ts: { $gt: day } }, { started_ts: null, first_seen_ts: { $gt: day } }] }) /* hacks >= $100k that happened in the last 24 h */, col('incident_moves').countDocuments({ ts: { $gt: day }, incident: { $in: proven }, usd: { $gte: minLiveUsd } }), col('firewall_flags').estimatedDocumentCount()]),
    ]);
    // a worker from before the live feed only moves the deploy cursor: that is enough to tell the watch is running
    const watch = watchMeta || (cursor ? { height: cursor.value, tick_ts: cursor.ts, behind: null } : null);
    const latest = new Map(); for (const d of deploys) if (!latest.has(d.account)) latest.set(d.account, d);
    const audits = new Map((await col('audits').find({ _id: { $in: [...latest.keys()] } }, { projection: { 'auto.label': 1, 'auto.level': 1, 'auto.control.summary': 1, 'auto.summary.headline': 1, 'auto.family_n': 1, 'auto.findings': { $slice: 3 } } }).toArray()).map((a) => [a._id, a.auto]));
    let contracts = [...latest.values()].map((d) => { const a = audits.get(d.account); return { type: 'contract', ts: d.ts, account: d.account, by: d.signer || d.by, how: /Global/.test(d.kind) ? 'shared code' : 'own code',
      label: a?.label || null, level: a?.level || null, control: a?.control?.summary || null, family_n: a?.family_n || null, headline: a?.summary?.headline || (a?.findings || []).find((f) => f.severity !== 'info')?.title || null, audited: !!a }; });
    if (only === 'risky') contracts = contracts.filter((c) => ['high', 'critical'].includes(c.level));
    const items = [
      ...contracts.slice(0, 40),
      ...detections.map((d) => ({ type: 'drain', ts: d.event_ts || d.ts, receiver: d.receiver, protocol: d.protocol, verdict: d.verdict || null, own: d.own?.explanation || null, tags: (d.tags || []).map((t) => t.tag), why: d.review?.why || null, incident: d.review?.incident || null, exchange: d.exchange || null, kind: d.kind || 'protocol', usd: d.usd, reasons: d.reasons, txs: d.txs })),
      ...moves.map((m) => ({ type: 'moved', ts: m.ts, incident: m.incident, from: m.from, to: m.to, symbol: m.symbol, amount: m.amount, usd: m.usd, idle_h: m.idle_h, swap: m.swap ? { chain: m.swap.chain, asset: m.swap.asset, recipient: m.swap.recipient } : null, tx: m.tx })),
      ...news.map((n) => ({ type: 'news', ts: n.ts, title: n.title, link: n.link, source: n.source, accounts: n.accounts, exchange: n.exchange })),
      ...reports.map((r) => ({ type: 'report', ts: r.last_ts, input: r.input, count: r.count })),
      ...incidents.map((i) => ({ type: 'hack', ts: i.started_ts || i.first_seen_ts, found_ts: i.first_seen_ts || null, late_days: config.incidents.alertMaxAgeDays, id: i._id, status: i.status, kind: i.kind, attacker: i.attacker?.account, target: i.drain?.exchange || i.target?.account || null, stolen_usd: i.stolen_usd, held_usd: i.held_usd, headline: i.ai?.headline || null, attack_type: { exchange_drain: 'Exchange hot-wallet drain', protocol_exploit: 'Protocol exploit', wallet_drainer: 'Wallet drainer' }[i.kind] || i.ai?.attack_type || null, exits: i.trail?.exit_usd || {}, caught_live: !!i.detected })),
    ].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
    const [deploys24, audited24, risky24, drains24, hacks24, moves24, flagged] = counts;
    return { now: Date.now(), watch, live: !!watch && Date.now() - watch.tick_ts < 120e3, last24h: { deploys: deploys24, audited: audited24, risky: risky24, drains: drains24, hacks: hacks24, moves: moves24 }, flagged, review_delay_min: config.incidents.reviewDelayMinutes, items };
  },
  /** Hacks and scams: traced incidents (newest first) and what the live detector raised. */
  '/api/incidents': async (u) => {
    const f = {}, kind = u.searchParams.get('kind'); if (kind) f.kind = kind;
    const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [rows, total, detections, queue] = await Promise.all([
      col('incidents').find({ ...f, status: 'confirmed' }, { projection: { status: 1, kind: 1, 'attacker.account': 1, 'target.account': 1, stolen_usd: 1, held_usd: 1, started_ts: 1, first_seen_ts: 1, updated_ts: 1, 'ai.headline': 1, 'ai.attack_type': 1, 'trail.exit_usd': 1, victims: { $slice: 3 }, signals: 1, detected: 1 } })
        .sort({ started_ts: -1, first_seen_ts: -1 }).skip(offset).limit(50).toArray(),
      col('incidents').countDocuments({ ...f, status: 'confirmed' }),
      col('incident_detections').find({}).sort({ ts: -1 }).limit(20).toArray(),
      col('incident_queue').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    ]);
    return { rows, total, detections, queue: Object.fromEntries(queue.map((q) => [q._id, q.n])) };
  },
  '/api/incident': async (u) => {
    const id = String(u.searchParams.get('id') || '');
    let doc = await col('incidents').findOne({ _id: id });
    // an investigation of a wallet that turned out to be part of a bigger one (re-rooted at the wallet that received the money first)
    if (!doc || doc.status === 'nothing_found') {
      const acc = id.replace(/^inc:/, '');
      const bigger = await col('incidents').findOne({ 'accounts.account': acc, status: { $in: ['confirmed', 'suspected'] } }, { sort: { stolen_usd: -1 } });
      if (bigger) return { incident: bigger, moved_from: acc, live_moves: await col('incident_moves').find({ incident: bigger._id }).sort({ ts: -1 }).limit(100).toArray() };
    }
    return doc ? { incident: doc, live_moves: await col('incident_moves').find({ incident: doc._id }).sort({ ts: -1 }).limit(100).toArray() } : { error: 'no such incident' };
  },
  /** Investigate an account, a tx hash or target:<contract>: the saved incident if there is one, else (run=1) start a trace here. */
  '/api/incident/investigate': async (u, req) => {
    let input; try { input = parseInvestigation(u.searchParams.get('q')); } catch (e) { return { error: e.message }; }
    const existing = input.account ? await col('incidents').findOne({ $or: [{ _id: `inc:${input.account}` }, { 'accounts.account': input.account }] }, { projection: { _id: 1, status: 1, updated_ts: 1 } })
      : input.tx ? await col('incidents').findOne({ 'attack_txs.tx': input.tx }, { projection: { _id: 1, status: 1, updated_ts: 1 } })
      : await col('incidents').findOne({ 'target.account': input.target }, { projection: { _id: 1, status: 1, updated_ts: 1 }, sort: { started_ts: -1 } });
    const fresh = existing && Date.now() - existing.updated_ts < 3600e3;
    let job = investigationJob(input);
    if (u.searchParams.get('run') === '1' && !job?.running && (!fresh || u.searchParams.get('force') === '1')) {
      if (!auditAllowed(req.socket.remoteAddress || 'ip')) return { error: 'too many investigations, try again in a few minutes' };
      job = startInvestigation(input, { full: u.searchParams.get('full') === '1' });
    }
    return { input, existing: existing?._id || null, job: job ? { running: job.running, started: job.started, error: job.error, id: job.id, step: job.step } : null };
  },
  /** Contracts the deploy watcher found, newest first, with their automated audit. */
  '/api/contracts-new': async (u) => {
    const f = {};
    const role = u.searchParams.get('role'), level = u.searchParams.get('level');
    const deploys = await col('contract_deploys').find(f, { projection: { account: 1, kind: 1, by: 1, signer: 1, ts: 1, global: 1 } }).sort({ ts: -1 }).limit(400).toArray();
    const latest = new Map(); for (const d of deploys) if (!latest.has(d.account)) latest.set(d.account, d);
    const audits = new Map((await col('audits').find({ _id: { $in: [...latest.keys()] } }, { projection: { 'auto.role': 1, 'auto.label': 1, 'auto.level': 1, 'auto.control.summary': 1, 'auto.family_n': 1, 'auto.summary.headline': 1, 'auto.findings': { $slice: 3 } } }).toArray()).map((a) => [a._id, a.auto]));
    let rows = [...latest.values()].map((d) => ({ ...d, audit: audits.get(d.account) || null }));
    if (role) rows = rows.filter((r) => r.audit?.role === role);
    if (level) rows = rows.filter((r) => r.audit?.level === level);
    const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0), limit = clamp(u.searchParams.get('limit'), 50, 100);
    const queue = Object.fromEntries((await col('audit_queue').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray()).map((x) => [x._id, x.n]));
    return { total: rows.length, rows: rows.slice(offset, offset + limit), queue, cursor: await metaGet('audit:deploy_cursor') };
  },
  '/api/audits': async (u) => {
    const rows = await col('audits').find({}, { projection: { raw: 0, 'risk.factors': 0, 'trust.factors': 0 } }).sort({ fetchedAt: -1 }).limit(clamp(u.searchParams.get('limit'), 30, 100)).toArray();
    return { rows: rows.map((r) => ({ ...strip(r), synced: syncedScores(r), auto: undefined, auto_level: r.auto?.level || null })) };
  },

  '/api/wallets': async (u) => {
    const f = { is_early: true };
    const q = (u.searchParams.get('q') || '').trim(); if (q) f._id = rx(q);
    const v = u.searchParams.get('tag'); if (v) f.tag = v === 'unrated' ? { $nin: ['win80', 'win50', 'win30', 'sniper', 'loss'] } : v;
    const sort = { pnl: { 'stats.pnl_near': -1 }, winrate: { 'stats.profit_rate': -1, 'stats.tokens_n': -1 }, tokens: { 'stats.tokens_n': -1 }, roi: { 'stats.roi_weighted': -1 }, recent: { first_seen_ts: -1 } }[u.searchParams.get('sort')] || { 'stats.tokens_n': -1 };
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows] = await Promise.all([col('wallets').countDocuments(f), col('wallets').find(f, { projection: { chain: 0, flow_out: 0 } }).sort(sort).skip(offset).limit(limit).toArray()]);
    return { total, rows: rows.map(strip) };
  },

  '/api/wallet': async (u) => {
    const id = u.searchParams.get('id');
    const w = await col('wallets').findOne({ _id: id });
    // not an early launch buyer, so not profiled: the wallet as the chain shows it
    if (!w) { const v = validNearAddress(String(id || '').toLowerCase()) ? await walletView(String(id).toLowerCase()).catch(() => null) : null; return v ? { id: v.id, onchain: v } : { error: 'No NEAR account with this name.' }; }
    const entries = await col('entries').find({ wallet: id }).sort({ first_buy_ts: -1 }).limit(100).toArray();
    const toks = await col('tokens').find({ _id: { $in: entries.map((e) => e.token) } }, { projection: { symbol: 1, launchpad: 1, status: 1, 'outcome.rugged': 1, 'outcome.peak_multiple': 1, 'ledger.synced_to_ts': 1, creator: 1 } }).toArray();
    const tmap = new Map(toks.map((t) => [t._id, t]));
    const cluster = w.cluster_id ? await col('clusters').findOne({ _id: w.cluster_id }, { projection: { size: 1, tag: 1, verdict: 1, score: 1, 'ai.label': 1, 'rule.tags': 1, weak_members: 1, weak_only: 1 } }) : null;
    const fundEdges = await col('edges').find({ type: 'fund', to: id }, { projection: { from: 1, hash: 1 } }).toArray();
    const hashOf = new Map(fundEdges.map((x) => [x.from, x.hash]));
    for (const f of w.funders || []) f.hash = f.hash || hashOf.get(f.account) || null;
    const { _id, ...rest } = w;
    return { id: _id, ...rest, cluster: cluster ? strip(cluster) : null,
      entries: entries.map((e) => ({ token: e.token, first_buy_hash: e.first_buy_hash || null, symbol: tmap.get(e.token)?.symbol || null, launchpad: e.launchpad, rank: e.rank, delay_s: e.delay_s, buy_near: e.buy_near, roi: e.roi, roi_now: e.roi_now, now_ts: tmap.get(e.token)?.ledger?.synced_to_ts ?? null, token_done: tmap.get(e.token)?.status === 'done', realized_now: e.realized_now ?? null, unrealized_now: e.unrealized_now ?? null, first_buy_ts: e.first_buy_ts, rugged: !!tmap.get(e.token)?.outcome?.rugged, peak_multiple: tmap.get(e.token)?.outcome?.peak_multiple ?? null, is_creator: e.is_creator })) };
  },

  '/api/tokens': async (u) => {
    const f = {};
    const q = (u.searchParams.get('q') || '').trim(); if (q) f.$or = [{ symbol: rx(q) }, { _id: rx(q) }, { creator: rx(q) }];
    const s = u.searchParams.get('status'); if (s) f.status = s;
    const lp = u.searchParams.get('launchpad'); if (lp) f.launchpad = lp;
    if (u.searchParams.get('rugged') === '1') f['outcome.rugged'] = true;
    // tabs of the merged tokens + scanner page
    const tab = u.searchParams.get('tab');
    if (tab === 'new') f.live_ts = { $gt: Date.now() - 24 * 3600e3 };
    else if (tab === 'checked') f['scan.score'] = { $exists: true };
    else if (tab === 'passed') f['scan.pass'] = true;
    else if (tab === 'bought') f['scan.bought'] = true;
    else if (tab === 'rugged') f['outcome.rugged'] = true;
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    let total, rows, vmap;
    if (tab === 'volume') {
      // highest trading volume over the last 24 h: rank by volume, then apply the other filters
      const vol = await volume24();
      vmap = new Map(vol.map((v) => [v._id, v]));
      const order = new Map(vol.map((v, i) => [v._id, i]));
      const all = await col('tokens').find({ ...f, _id: { $in: vol.map((v) => v._id) } }, { projection: { _id: 1 } }).toArray();
      const ids = all.map((t) => t._id).sort((a, b) => order.get(a) - order.get(b));
      total = ids.length;
      const page = ids.slice(offset, offset + limit);
      const docs = new Map((await col('tokens').find({ _id: { $in: page } }, { projection: { pool: 0 } }).toArray()).map((t) => [t._id, t]));
      rows = page.map((id) => docs.get(id)).filter(Boolean);
    } else {
      [total, rows] = await Promise.all([col('tokens').countDocuments(f), col('tokens').find(f, { projection: { pool: 0 } }).sort({ live_ts: -1 }).skip(offset).limit(limit).toArray()]);
      vmap = new Map((await volume24(rows.map((t) => t._id))).map((v) => [v._id, v]));
    }
    const mix = await earlyMix(rows.map((t) => t._id));
    const cr = await creatorIndex(rows.map((t) => t.creator).filter(Boolean));
    return { total, rows: rows.map((t) => { const m = mix.get(t._id); return { ...strip(t), vol24: volBrief(vmap.get(t._id)), creator_risk: creatorBrief(cr.get(t.creator)), mix: Object.fromEntries(TAGS.map((v) => [v, m[v]])), rugger: m.rugger, groups: m.groups.filter((g) => g.tag !== 'unrated').slice(0, 3) }; }) };
  },

  '/api/token': async (u) => {
    const id = u.searchParams.get('id');
    const t = await col('tokens').findOne({ _id: id });
    if (!t) return { error: 'not found' };
    const entries = await col('entries').find({ token: id }).sort({ rank: 1 }).toArray();
    const wallets = await col('wallets').find({ _id: { $in: entries.map((e) => e.wallet) } }, { projection: { cluster_id: 1, tag: 1, kind: 1, funder_kind: 1, created_ts: 1, creator: 1, 'stats.tokens_n': 1, 'stats.win_rate': 1, 'stats.profit_rate': 1 } }).toArray();
    const wmap = new Map(wallets.map((w) => [w._id, w]));
    const cids = [...new Set(wallets.map((w) => w.cluster_id).filter(Boolean))];
    const clusters = await col('clusters').find({ _id: { $in: cids } }, { projection: { size: 1, tag: 1, 'ai.label': 1, 'rule.tags': 1, creator_flag: 1 } }).toArray();
    const cmap = new Map(clusters.map((c) => [c._id, c]));
    const { _id, ...rest } = t;
    const audit = summarizeAudit(await getCachedAudit(id));
    const creatorInfo = t.creator ? (await creatorIndex([t.creator])).get(t.creator) || null : null;
    const creatorWallet = t.creator ? await col('wallets').findOne({ _id: t.creator }, { projection: { cluster_id: 1, cluster_tag: 1, tag: 1, is_early: 1 } }) : null;
    const creatorNet = t.creator ? await creatorNetwork(t.creator).catch(() => null) : null;
    return { id: _id, ...rest, audit, creator_info: creatorInfo, creator_network: netBrief(creatorNet), creator_wallet: creatorWallet ? { cluster_id: creatorWallet.cluster_id ?? null, cluster_tag: creatorWallet.cluster_tag ?? null, tag: creatorWallet.tag ?? null } : null, entries: entries.map((e) => { const w = wmap.get(e.wallet), c = w?.cluster_id ? cmap.get(w.cluster_id) : null;
      return { wallet: e.wallet, first_buy_hash: e.first_buy_hash || null, rank: e.rank, delay_s: e.delay_s, buy_near: e.buy_near, roi: e.roi, roi_now: e.roi_now, sold_share: e.sold_share, is_creator: e.is_creator, kind: w?.kind || null, funder_kind: w?.funder_kind || null,
        wallet_age_days: w?.created_ts ? Math.round((e.first_buy_ts - w.created_ts) / 86400e3) : null, rugger: ruggerWallet(w, c), wallet_tag: tagOf(w?.tag), wallet_profit_rate: w?.stats?.profit_rate ?? null, tag: tagOf(c ? c.tag : w?.tag), cluster: c ? { id: c._id, size: c.size, tag: tagOf(c.tag), rugger: ruggerGroup(c), label: c.ai?.label || c.rule?.tags?.[0] || null } : null }; }) };
  },

  /** One box for everything: tokens by symbol / account, wallets by account, groups by id / AI label. */
  '/api/search': async (u) => {
    const q = (u.searchParams.get('q') || '').trim().slice(0, 80);
    if (q.length < 2) return { tokens: [], wallets: [], groups: [] };
    const [tokens, wallets, groups] = await Promise.all([
      col('tokens').find({ $or: [{ symbol: rx(q) }, { _id: rx(q) }] }, { projection: { symbol: 1, launchpad: 1, live_ts: 1, 'outcome.rugged': 1 } }).sort({ live_ts: -1 }).limit(6).toArray(),
      col('wallets').find({ _id: rx(q), is_early: true }, { projection: { cluster_id: 1, tag: 1, 'stats.tokens_n': 1 } }).limit(6).toArray(),
      col('clusters').find({ $or: [{ _id: rx(q) }, { 'ai.label': rx(q) }, { members: q }] }, { projection: { tag: 1, size: 1, 'ai.label': 1 } }).sort({ size: -1 }).limit(6).toArray(),
    ]);
    return { tokens: tokens.map(strip), wallets: wallets.map(strip), groups: groups.map(strip) };
  },

  /** Token creators: launches, rugged launches, dev-rug blacklist, and the group they belong to. */
  '/api/creators': async (u) => {
    const idx = await creatorIndex();
    let rows = [...idx.values()];
    const q = (u.searchParams.get('q') || '').trim().toLowerCase(); if (q) rows = rows.filter((c) => c.account.toLowerCase().includes(q) || c.tokens.some((t) => (t.symbol || '').toLowerCase().includes(q)));
    const f = u.searchParams.get('filter');
    if (f === 'blacklisted') rows = rows.filter((c) => c.blacklisted); else if (f === 'rugger') rows = rows.filter((c) => c.rugged > 0); else if (f === 'clean') rows = rows.filter((c) => !c.blacklisted && c.rugged === 0 && c.launches > 0);
    const sort = u.searchParams.get('sort');
    rows.sort(sort === 'launches' ? (a, b) => b.launches - a.launches : sort === 'recent' ? (a, b) => (b.tokens[0]?.live_ts || b.blacklisted?.ts || 0) - (a.tokens[0]?.live_ts || a.blacklisted?.ts || 0) : (a, b) => (b.blacklisted ? 1 : 0) - (a.blacklisted ? 1 : 0) || b.rugged - a.rugged || b.launches - a.launches);
    const total = rows.length, limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const page = rows.slice(offset, offset + limit);
    const ws = await col('wallets').find({ _id: { $in: page.map((c) => c.account) } }, { projection: { cluster_id: 1, cluster_tag: 1, tag: 1 } }).toArray();
    const wmap = new Map(ws.map((w) => [w._id, w]));
    const all = [...idx.values()];
    return { total, summary: { creators: all.filter((c) => c.launches).length, ruggers: all.filter((c) => c.rugged > 0).length, blacklisted: all.filter((c) => c.blacklisted).length, rugged_tokens: all.reduce((s, c) => s + c.rugged, 0) },
      rows: page.map((c) => ({ account: c.account, launches: c.launches, rugged: c.rugged, rug_rate: c.rug_rate, flag: creatorFlag(c), blacklisted: c.blacklisted, tokens: c.tokens.slice(0, 5), group: wmap.get(c.account)?.cluster_id ? { id: wmap.get(c.account).cluster_id, tag: wmap.get(c.account).cluster_tag } : null, tag: wmap.get(c.account)?.tag ?? null })) };
  },

  '/api/creator': async (u) => {
    const id = u.searchParams.get('id');
    const c = (await creatorIndex([id])).get(id);
    if (!c) return { error: 'not found' };
    const [w, groups] = await Promise.all([col('wallets').findOne({ _id: id }, { projection: { cluster_id: 1, cluster_tag: 1, tag: 1, stats: 1, is_early: 1 } }),
      col('clusters').find({ 'creators.account': id }, { projection: { tag: 1, size: 1, 'ai.label': 1, 'rule.tags': 1, creators: { $elemMatch: { account: id } } } }).toArray()]);
    const toks = await col('tokens').find({ creator: id }, { projection: { symbol: 1, launchpad: 1, live_ts: 1, status: 1, 'outcome.rugged': 1, 'outcome.rug_kinds': 1, 'outcome.peak_multiple': 1, 'outcome.last_multiple': 1, 'ledger.last_multiple': 1, 'outcome.creator_sold': 1, 'outcome.creator_sell_near': 1, 'outcome.rug_basis': 1, 'rug.reason': 1 } }).sort({ live_ts: -1 }).limit(100).toArray();
    return { id, launches: c.launches, rugged: c.rugged, rug_rate: c.rug_rate, blacklisted: c.blacklisted, flag: creatorFlag(c), wallet: w ? { cluster_id: w.cluster_id ?? null, cluster_tag: w.cluster_tag ?? null, tag: w.tag ?? null, stats: w.stats || null, is_early: !!w.is_early } : null,
      groups: groups.map((g) => ({ id: g._id, tag: g.tag, size: g.size, label: g.ai?.label || g.rule?.tags?.[0] || null, role: g.creators?.[0]?.role || null, depth: g.creators?.[0]?.depth ?? null })), tokens: toks.map(strip), network: await creatorNetwork(id).catch(() => null) };
  },

  // ------------------------------------------------------------ on-chain analysis of one token (cached; NEAR AI assessment on request)
  '/api/analysis': async (u, req) => {
    const id = (u.searchParams.get('id') || '').trim();
    if (!validNearAddress(id)) return { error: 'invalid NEAR account id' };
    const refresh = u.searchParams.get('refresh') === '1' && !limited(analysisHits, req.socket.remoteAddress || 'ip', 6);
    const a = await getAnalysis(id, { refresh });
    if (!a) return { error: 'not found' };
    const job = aiRunning.get(id);
    return { ...a, ai_enabled: aiEnabled(), ai_job: job ? { running: !job.error && !job.unchanged, step: job.step || null, error: job.error || null, unchanged: !!job.unchanged, started: job.started } : null };
  },
  /** One earlier AI analyst run, with the figures it was written from and what changed since the run before. */
  '/api/analysis-run': async (u) => (await getRun(u.searchParams.get('id') || '')) || { error: 'not found' },
  '/api/analysis-ai': async (u, req) => {
    const id = (u.searchParams.get('id') || '').trim();
    if (!validNearAddress(id)) return { error: 'invalid NEAR account id' };
    if (!aiEnabled()) return { error: 'NEAR AI is not configured' };
    const cur = aiRunning.get(id);
    if (cur && !cur.error && !cur.unchanged) return { running: true, started: cur.started };
    if (limited(aiHits, req.socket.remoteAddress || 'ip', 5)) return { error: 'too many AI requests, try again in a few minutes' };
    // run only on request; every run first reads the token's latest trades (its full ledger, for up to ANALYSIS_SYNC_MINUTES), rebuilds
    // the analysis from them (with the transfer trails), then writes the first assessment or updates the last one with what changed since it
    // (no model call when nothing did)
    const started = Date.now(), job = { started, step: 'reading the latest trades' };
    aiRunning.set(id, job);
    catchUp(id, { deadline: started + config.analysis.syncMinutes * 60e3, step: (x) => { job.step = x; } })
      .catch((e) => error(`AI review of ${id}: reading the latest trades failed: ${e.message}`)) // the review still runs on what is stored
      .then(() => { job.step = 'building the analysis'; return getAnalysis(id, { refresh: true }); })
      .then((a) => { if (!a) throw new Error('not found'); job.step = 'NEAR AI is writing the review'; return assessWithAi(a); })
      .then((ai) => (ai.unchanged ? aiRunning.set(id, { started, unchanged: true, done: Date.now() }) : aiRunning.delete(id)))
      .catch((e) => aiRunning.set(id, { started, error: e.message }))
      .finally(() => setTimeout(() => { if (aiRunning.get(id)?.started === started) aiRunning.delete(id); }, 10 * 60e3));
    return { running: true, started };
  },

  // ------------------------------------------------------------ measured accuracy
  /** The latest accuracy pass (worker, hourly) plus the hand labels and the review queue size. */
  '/api/accuracy': async () => {
    const [acc, labels, pending] = await Promise.all([metaGet('accuracy'), col('ground_truth').aggregate([{ $group: { _id: { k: '$kind', l: '$label' }, n: { $sum: 1 } } }]).toArray(), col('feedback').countDocuments({ status: 'pending' })]);
    return { accuracy: acc, labels: labels.map((x) => ({ kind: x._id.k, label: x._id.l, n: x.n })), feedback_pending: pending, feedback_kinds: FEEDBACK_KINDS };
  },

  // ------------------------------------------------------------ alerts and watchlists
  /** Alerts, newest first: all of them (filter by severity, type group, or what they concern), or one watchlist's (key=). */
  '/api/alerts': async (u) => {
    const since = Number(u.searchParams.get('since')) || 0, limit = clamp(u.searchParams.get('limit'), 50, 200), key = u.searchParams.get('key');
    if (key) { if (!validKey(key)) return { error: 'invalid key' }; return { rows: (await alertsFor(key, { since, limit })).map(alertPayload) }; }
    const f = { ts: { $gt: since } };
    const sev = u.searchParams.get('severity'); if (SEVERITIES.includes(sev)) f.severity = { $in: SEVERITIES.slice(0, SEVERITIES.indexOf(sev) + 1) };
    const grp = u.searchParams.get('group'); if (grp) f.type = { $in: Object.keys(TYPES).filter((t) => TYPES[t].group === grp) };
    const kind = u.searchParams.get('kind'), id = u.searchParams.get('id');
    if (kind && id && KINDS.includes(kind)) f[`related.${kind === 'group' ? 'groups' : kind + 's'}`] = id;
    const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows] = await Promise.all([col('alerts').countDocuments(f), col('alerts').find(f).sort({ ts: -1 }).skip(offset).limit(limit).toArray()]);
    return { total, types: Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, v.label])), telegram_bot: config.alerts.telegramBot || null, telegram_channel: /^@\w+$/.test(config.alerts.telegramChannel) ? config.alerts.telegramChannel.slice(1) : null, rows: rows.map(alertPayload) };
  },
  '/api/watchlist': async (u) => {
    const key = u.searchParams.get('key');
    if (!validKey(key)) return { error: 'invalid key' };
    const w = await getWatchlist(key);
    // what each item is monitored for: a token the tracker doesn't follow only gets the contract checks
    const toks = new Map((await col('tokens').find({ _id: { $in: w.items.filter((x) => x.kind === 'token').map((x) => x.id) } }, { projection: { symbol: 1 } }).toArray()).map((t) => [t._id, t]));
    const items = w.items.map((x) => x.kind !== 'token' ? x : toks.has(x.id) ? { ...x, symbol: toks.get(x.id).symbol, tracked: true } : { ...x, tracked: false });
    return { items, webhook: w.webhook ? w.webhook.replace(/^(https:\/\/[^/]+).*/, '$1/…') : null };
  },
  /** What can be watched, matching q: only things the tracker has (tokens it follows, its groups, wallets, creators, NFT collections). */
  '/api/watch/pick': async (u) => {
    const q = (u.searchParams.get('q') || '').trim().replace(/^\$/, '').slice(0, 64), kind = u.searchParams.get('kind');
    if (q.length < 2) return { rows: [] };
    const want = (k) => !KINDS.includes(kind) || kind === k;
    const [tokens, groups, cols, creators, wallets] = await Promise.all([
      want('token') ? col('tokens').find({ $or: [{ symbol: rx(q) }, { _id: rx(q) }] }, { projection: { symbol: 1, launchpad: 1, live_ts: 1 } }).sort({ live_ts: -1 }).limit(8).toArray() : [],
      want('group') ? col('clusters').find({ $or: [{ _id: rx(q) }, { 'ai.label': rx(q) }] }, { projection: { size: 1, tag: 1, 'ai.label': 1 } }).sort({ size: -1 }).limit(4).toArray() : [],
      want('collection') ? col('nft_collections').find({ $or: [{ _id: rx(q) }, { name: rx(q) }] }, { projection: { name: 1 } }).limit(4).toArray() : [],
      want('creator') ? col('tokens').aggregate([{ $match: { creator: rx(q) } }, { $group: { _id: '$creator', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 4 }]).toArray() : [],
      want('wallet') ? col('wallets').find({ _id: rx(q) }, { projection: { tag: 1 } }).limit(4).toArray() : [],
    ]);
    const mcaps = await marketCapNow(tokens.map((t) => t._id));
    return { rows: [
      ...tokens.sort((a, b) => (String(b.symbol).toLowerCase() === q.toLowerCase()) - (String(a.symbol).toLowerCase() === q.toLowerCase())).map((t) => ({ kind: 'token', id: t._id, label: t.symbol || t._id,
        sub: `${t.launchpad || ''} · live ${t.live_ts ? new Date(t.live_ts).toISOString().slice(0, 10) : '?'}`, mcap: mcaps.get(t._id) || null })),
      ...groups.map((g) => ({ kind: 'group', id: g._id, label: g.ai?.label || g._id, sub: `${g.size} wallets · ${g.tag || ''}` })),
      ...cols.map((c) => ({ kind: 'collection', id: c._id, label: c.name || c._id, sub: 'NFT collection' })),
      ...creators.map((c) => ({ kind: 'creator', id: c._id, label: c._id, sub: `${c.n} launches` })),
      ...wallets.map((w) => ({ kind: 'wallet', id: w._id, label: w._id, sub: w.tag || 'wallet' })),
    ] };
  },

  // ------------------------------------------------------------ NFT collectibles
  '/api/nfts': async (u) => {
    const f = {};
    const tab = u.searchParams.get('tab') || '';
    if (tab === 'spam') f.spam = true; else { f.spam = { $ne: true }; if (tab === 'active') f.last_event_ts = { $gt: Date.now() - 24 * 3600e3 }; else if (tab) f.source = tab; }
    const q = (u.searchParams.get('q') || '').trim(); if (q) f.$or = [{ _id: rx(q) }, { name: rx(q) }, { symbol: rx(q) }];
    const sort = { recent: { last_event_ts: -1 }, launched: { launched_ts: -1, created_ts: -1 }, events: { events_n: -1 }, holders: { 'nb.holders': -1 } }[u.searchParams.get('sort')] || { last_event_ts: -1, 'nb.transfers_day': -1 };
    const limit = clamp(u.searchParams.get('limit'), 50, 200), offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const [total, rows, bySource] = await Promise.all([col('nft_collections').countDocuments(f), col('nft_collections').find(f).sort(sort).skip(offset).limit(limit).toArray(),
      col('nft_collections').aggregate([{ $group: { _id: { $cond: ['$spam', 'spam', '$source'] }, n: { $sum: 1 } } }]).toArray()]);
    const stats = new Map((await col('nft_events').aggregate([{ $match: { collection: { $in: rows.map((c) => c._id) } } },
      { $group: { _id: '$collection', minted: { $sum: { $cond: [{ $eq: ['$kind', 'mint'] }, '$count', 0] } }, sales: { $sum: { $cond: [{ $eq: ['$kind', 'sale'] }, '$count', 0] } }, volume: { $sum: { $cond: [{ $eq: ['$kind', 'sale'] }, { $ifNull: ['$pay_near', 0] }, 0] } }, raised: { $sum: { $cond: [{ $eq: ['$kind', 'mint'] }, { $ifNull: ['$pay_near', 0] }, 0] } } } }]).toArray()).map((x) => [x._id, x]));
    return { total, sources: Object.fromEntries(bySource.map((x) => [x._id || 'unknown', x.n])), source_labels: SOURCES,
      rows: rows.map((c) => ({ id: c._id, name: c.name || null, symbol: c.symbol || null, source: c.source || null, spam: !!c.spam, supply: c.supply ?? null, max_supply: c.max_supply ?? null, launched_ts: c.launched_ts ?? null,
        last_event_ts: c.last_event_ts ?? null, caught_up: !!c.caught_up, synced: c.sync_height != null, nb: c.nb || null, ...(stats.get(c._id) ? { minted: stats.get(c._id).minted, sales: stats.get(c._id).sales, volume_near: stats.get(c._id).volume, raised_near: stats.get(c._id).raised } : {}) })) };
  },
  '/api/nft': async (u, req) => {
    const id = (u.searchParams.get('id') || '').trim().toLowerCase();
    if (!validNearAddress(id)) return { error: 'invalid NEAR account id' };
    const c = await col('nft_collections').findOne({ _id: id }, { projection: { sync_height: 1 } });
    const job = nftJobs.get(id);
    if (!c) return { error: 'not tracked', can_add: true };
    if (c.sync_height == null && !job) return { error: 'not synced yet', can_add: true, syncing: false };
    const refresh = u.searchParams.get('refresh') === '1' && !limited(analysisHits, req.socket.remoteAddress || 'ip', 6);
    const a = await getNftAnalysis(id, { refresh });
    const aj = aiRunning.get(`nft:${id}`);
    return { ...a, ai_kind: 'nft', token: id, sync_job: job || null, ai_enabled: aiEnabled(), ai_job: aj ? { running: !aj.error && !aj.unchanged, error: aj.error || null, unchanged: !!aj.unchanged, started: aj.started } : null };
  },
  '/api/nft-add': async (u, req) => {
    const id = (u.searchParams.get('id') || '').trim().toLowerCase();
    if (!validNearAddress(id)) return { error: 'invalid NEAR account id' };
    const job = nftJobs.get(id); if (job && !job.done) return { id, ...job };
    if (!fetchAllowed(req.socket.remoteAddress || 'ip')) return { error: 'too many requests, try again in a few minutes' };
    const meta = await view(id, 'nft_metadata').catch(() => null);
    if (!meta?.spec && !meta?.name) return { error: 'this account is not an NFT collection (no nft_metadata)' };
    await registerCollection(id, { name: meta.name || null, symbol: meta.symbol || null });
    await col('nft_collections').updateOne({ _id: id, source: { $exists: false } }, { $set: { source: 'manual' } });
    return { id, ...startNftSync(id) };
  },
  '/api/nft-ai': async (u, req) => {
    const id = (u.searchParams.get('id') || '').trim().toLowerCase();
    if (!validNearAddress(id)) return { error: 'invalid NEAR account id' };
    if (!aiEnabled()) return { error: 'NEAR AI is not configured' };
    const key = `nft:${id}`, job = aiRunning.get(key);
    if (job && !job.error && !job.unchanged) return { running: true, started: job.started };
    if (limited(aiHits, req.socket.remoteAddress || 'ip', 5)) return { error: 'too many AI requests, try again in a few minutes' };
    const started = Date.now();
    aiRunning.set(key, { started });
    getNftAnalysis(id, { refresh: true }).then((a) => { if (!a) throw new Error('not found'); return assessNftWithAi(a); })
      .then((ai) => (ai.unchanged ? aiRunning.set(key, { started, unchanged: true }) : aiRunning.delete(key)))
      .catch((e) => aiRunning.set(key, { started, error: e.message }))
      .finally(() => setTimeout(() => { if (aiRunning.get(key)?.started === started) aiRunning.delete(key); }, 10 * 60e3));
    return { running: true, started };
  },

  '/api/signals': async (u) => ({ rows: await buildSignals(clamp(u.searchParams.get('hours'), 72, 720), 60) }),

  '/api/logs': async (u) => {
    const f = {}; const lv = u.searchParams.get('level'); if (lv) f.level = lv;
    const rows = await col('events').find(f, { projection: { _id: 0, at: 0 } }).sort({ ts: -1 }).limit(clamp(u.searchParams.get('limit'), 200, 1000)).toArray();
    return { rows };
  },

  // meme.cooking token pages are addressed by meme id: the UI needs token -> id once
  '/api/meme-ids': async () => ({ ids: Object.fromEntries((await col('tokens').find({ launchpad: 'memecooking', meme_id: { $ne: null } }, { projection: { meme_id: 1 } }).toArray()).map((x) => [x._id, x.meme_id])) }),

  '/api/health': async () => { let db = false; try { getDb(); db = true; } catch {} return { ok: true, db, now: Date.now(), ai: { enabled: aiEnabled(), ok: aiStatus.ok }, recent: recentLogs.length, port: config.web.ports }; },
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
      const verify = req.method === 'GET' && SITE_VERIFY[req.url.split('?')[0]];
      if (verify) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(verify); return; }
      if (req.url.startsWith('/api/v1')) { await firewallApi(req, res, new URL(req.url, 'http://localhost')); return; } // public: no password, any origin
      if (req.url === '/mcp' || req.url.startsWith('/mcp?')) { await mcpEndpoint(req, res); return; } // the Agent Guard for AI agents: public too
      if (exposed() && config.web.password && !authorized(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="entity tracker"' }).end('authentication required'); return; }
      const u = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && u.pathname === '/api/sim/sell') {
        if (exposed() && !config.web.password) { res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'simulated sells are disabled on a public deployment without DASHBOARD_PASSWORD' })); return; }
        const origin = req.headers.origin;
        if (req.headers['x-tracker'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) { res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden' })); return; }
        let body = ''; for await (const d of req) { body += d; if (body.length > 5000) break; }
        const { id, percent } = JSON.parse(body || '{}');
        const share = Number(percent) / 100;
        const pos = id && await col('sim_positions').findOne({ _id: String(id) });
        const tok = pos && await col('tokens').findOne({ _id: pos.token });
        if (!pos || !tok || !(share > 0 && share <= 1)) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'skipped', reason: 'position and percent (1-100) required' })); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(await simSell(tok, pos, { share, reason: `manual (UI ${percent}%)` })));
        return;
      }
      if (req.method === 'POST' && POSTS[u.pathname]) {
        if (OPERATOR_POSTS.has(u.pathname) && exposed() && !config.web.password) { res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'confirming or clearing a hack is disabled on a public deployment without DASHBOARD_PASSWORD' })); return; }
        const origin = req.headers.origin; // browsers: same origin and our header only; API clients send no Origin
        if (req.headers['x-tracker'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) { res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden: send the header x-tracker: 1' })); return; }
        let body = ''; for await (const d of req) { body += d; if (body.length > 4000) break; }
        let b = {}; try { b = JSON.parse(body || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid JSON' })); return; }
        const out = await POSTS[u.pathname](b, req.socket.remoteAddress || 'ip');
        res.writeHead(out?.error ? 400 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(out));
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(302, { location: '/explore' }).end(); return; }
      if (u.pathname.startsWith('/assets/')) {
        const a = asset(u.pathname);
        if (!a) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': a.type, 'cache-control': 'public, max-age=31536000, immutable' }).end(a.body); return;
      }
      if (UI_VIEWS.has(u.pathname.split('/')[1])) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page); return; } // client-side routes: /config, /groups/<id> ...
      if (HIDDEN_PUBLIC.has(u.pathname) && config.web.hosted && !config.web.password) { res.writeHead(404).end('not found'); return; } // logs and settings are not shown on a public deployment
      const route = routes[u.pathname];
      if (!route) { res.writeHead(404).end('not found'); return; }
      const data = await route(u, req);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(config.web.hideCriteria ? redact(u.pathname, data) : data, noModel));
    } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message })); }
  });
  // A host routes its public domain to ONE port (Railway: the service's target port, 8080 by default, or $PORT). Listen on all of them
  // so the app answers whichever one the domain points at.
  const ports = config.web.ports;
  const mode = exposed() ? (config.web.password ? ' (password protected)' : ' (public, no password: read-only, simulated sells disabled)') : '';
  server.listen(ports[0], config.web.host, () => info(`web UI: http://${exposed() ? config.web.host : 'localhost'}:${ports[0]}${mode}`));
  server.on('error', (e) => error(`web server ${ports[0]}: ${e.message}`));
  const extra = ports.slice(1).map((p) => {
    const s2 = http.createServer(server.listeners('request')[0]);
    s2.on('error', (e) => error(`web server ${p}: ${e.message}`));
    s2.listen(p, config.web.host, () => info(`web UI also on port ${p}`));
    return s2;
  });
  const close = server.close.bind(server);
  server.close = (...a) => { extra.forEach((s2) => s2.close()); return close(...a); };
  return server;
}
