// The network around an account, a wallet group (grp:…) or a case (inc:…) for the 3D graph page (GET /api/graph3d). Read-only: the
// in-memory ontology graph (graph.js) gives the nodes and links, whatIsMany what each node is, and one query on `ontology_facts` the
// evidence of the links shown. It walks like `walk`: an exchange, a service, a contract (anything that cuts links) is shown but never
// walked through, and an organisation node (org:…) is never walked through either: it links every wallet it operates.
import { col } from '../db.js';
import { graph, cutsPath, EDGE_PREDICATES } from './graph.js';
import { whatIsMany } from './index.js';

export const MAX_NODES = 500, MAX_HOPS = 4, MAX_LINKS = 3000;
const SPECIAL = /^(grp|inc|org):/;

/** What a node id is when it is not an account. */
export const nodeKind = (id) => (id.startsWith('grp:') ? 'group' : id.startsWith('inc:') ? 'case' : id.startsWith('org:') ? 'org' : 'account');

/**
 * Breadth first from `start` up to `hops`, at most `maxNodes` nodes; then every link between the nodes kept. Pure on `g`.
 * Returns { nodes: [{ id, hop, cut }], links: [{ source, target, p, s, role, status }], capped }.
 */
export function buildGraph3d(g, start, { hops = 2, maxNodes = MAX_NODES, maxLinks = MAX_LINKS, cuts = cutsPath, predicates = EDGE_PREDICATES } = {}) {
  const hop = new Map([[start, 0]]), cut = new Set();
  const stops = (id) => id !== start && (id.startsWith('inc:') || id.startsWith('org:') || (!SPECIAL.test(id) && cuts(id)));
  const edgesOf = (id) => [...(g.out.get(id) || []), ...(g.in.get(id) || [])].filter((e) => predicates.includes(e.p));
  let frontier = [start], capped = null;
  for (let h = 1; h <= hops && frontier.length && !capped; h++) {
    const next = [];
    for (const id of frontier) {
      for (const e of edgesOf(id)) {
        if (hop.has(e.to)) continue;
        if (hop.size >= maxNodes) { capped = `stopped at ${maxNodes} nodes`; break; }
        hop.set(e.to, h);
        if (stops(e.to)) cut.add(e.to); else next.push(e.to);
      }
      if (capped) break;
    }
    frontier = next;
  }
  // every link between two kept nodes, each fact once (out edges only: the in lists mirror them)
  const links = [], seen = new Set();
  for (const id of hop.keys()) {
    for (const e of g.out.get(id) || []) {
      if (!predicates.includes(e.p) || !hop.has(e.to)) continue;
      const k = `${id}|${e.p}|${e.to}|${e.role || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (links.length >= maxLinks) { capped = capped || `stopped at ${maxLinks} links`; break; }
      links.push({ source: id, target: e.to, p: e.p, s: e.s || null, role: e.role || null, status: e.status || null });
    }
  }
  return { nodes: [...hop].map(([id, h]) => ({ id, hop: h, cut: cut.has(id) })), links, capped };
}

/** Evidence of the links shown: one query, keyed like the links. Empty when the database cannot be read. */
async function evidenceOf(links) {
  if (!links.length) return new Map();
  const subjects = [...new Set(links.map((l) => l.source))], objects = [...new Set(links.map((l) => l.target))], now = Date.now();
  try {
    const rows = await col('ontology_facts').find({ subject: { $in: subjects }, object: { $in: objects }, predicate: { $in: [...new Set(links.map((l) => l.p))] }, $or: [{ valid_to: null }, { valid_to: { $gt: now } }] },
      { projection: { subject: 1, predicate: 1, object: 1, role: 1, evidence: 1, confidence: 1 } }).limit(MAX_LINKS * 2).toArray();
    return new Map(rows.map((f) => [`${f.subject}|${f.predicate}|${f.object}|${f.role || ''}`, f]));
  } catch { return new Map(); }
}

/** The answer of GET /api/graph3d. */
export async function graph3d(id, { hops = 2, maxNodes = MAX_NODES } = {}) {
  const g = await graph();
  hops = Math.max(1, Math.min(MAX_HOPS, Number(hops) || 2));
  maxNodes = Math.max(10, Math.min(MAX_NODES, Number(maxNodes) || MAX_NODES));
  const b = buildGraph3d(g, id, { hops, maxNodes });
  const accounts = b.nodes.filter((x) => !SPECIAL.test(x.id)).map((x) => x.id);
  const [ans, ev] = await Promise.all([whatIsMany(accounts), evidenceOf(b.links)]);
  const nodes = b.nodes.map((x) => {
    const kind = nodeKind(x.id), a = kind === 'account' ? ans.get(x.id) : null, bad = g.bad.get(x.id) || null;
    const operators = a ? (a.operators?.length ? a.operators : a.operator ? [a.operator] : []) : [];
    return { id: x.id, hop: x.hop, cut: x.cut, kind, class: a?.class || kind, top: a?.top || kind, label: a?.label || null, operators,
      flagged: a?.flagged || null, bad: bad ? bad.why : null, roles: (a?.roles || []).slice(0, 6), degree: 0 };
  });
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const links = b.links.map((l) => {
    byId.get(l.source).degree++; byId.get(l.target).degree++;
    const f = ev.get(`${l.source}|${l.p}|${l.target}|${l.role || ''}`);
    return { ...l, evidence: f?.evidence || null, confidence: f?.confidence ?? null };
  });
  return { id, hops, start_known: g.out.has(id) || g.in.has(id), graph_loaded_ts: g.loadedTs, nodes, links, capped: b.capped, max_nodes: maxNodes };
}

// ---- the whole layer (GET /api/graph3d/all, the /graph page): every node and link of the in-memory graph, compact ----
export const OVERVIEW_MAX_NODES = 40000;
const TOPS = ['person', 'exchange', 'service', 'contract', 'system', 'unknown', 'group', 'case', 'org'];

/**
 * Every node with a link and every link, as arrays so 10,000 nodes stay a few hundred KB. Pure on `g` (and `cls`, the class lookup).
 *   nodes: [id, top index (TOPS), flags (1 bad, 2 cut: shown, never walked through), degree, island, label | null]
 *   links: [source index, target index, predicate index (EDGE_PREDICATES), role | null]
 *   islands: sizes of the connected parts, by island number (0 is the largest)
 * Past `maxNodes`, the nodes with the fewest links are left out (capped says so).
 */
export function buildOverview(g, { cls, maxNodes = OVERVIEW_MAX_NODES, predicates = EDGE_PREDICATES } = {}) {
  const deg = new Map();
  for (const [id, list] of g.out) for (const e of list) if (predicates.includes(e.p)) { deg.set(id, (deg.get(id) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
  let ids = [...deg.keys()], capped = null;
  if (ids.length > maxNodes) { ids.sort((a, b) => deg.get(b) - deg.get(a) || (a < b ? -1 : 1)); ids = ids.slice(0, maxNodes); capped = `the ${maxNodes} best-linked of ${deg.size} nodes`; }
  const index = new Map(ids.map((id, i) => [id, i]));
  // islands: union-find over the kept links
  const up = ids.map((_, i) => i);
  const root = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const links = [], seen = new Set();
  for (const [id, list] of g.out) {
    const a = index.get(id); if (a == null) continue;
    for (const e of list) {
      const b = index.get(e.to);
      if (b == null || !predicates.includes(e.p)) continue;
      const k = `${a}|${b}|${e.p}|${e.role || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push([a, b, predicates.indexOf(e.p), e.role || null]);
      const ra = root(a), rb = root(b); if (ra !== rb) up[ra] = rb;
    }
  }
  const size = new Map();
  for (let i = 0; i < ids.length; i++) { const r = root(i); size.set(r, (size.get(r) || 0) + 1); }
  const order = [...size].sort((x, y) => y[1] - x[1]), island = new Map(order.map(([r], n) => [r, n]));
  const nodes = ids.map((id, i) => {
    const kind = nodeKind(id), c = kind === 'account' ? (cls ? cls(id) : null) : null;
    const top = kind === 'account' ? (TOPS.includes(c?.top) ? c.top : 'unknown') : kind;
    const flags = (g.bad.has(id) ? 1 : 0) | (kind === 'account' && c?.cuts_links ? 2 : 0);
    return [id, TOPS.indexOf(top), flags, deg.get(id), island.get(root(i)), c?.label ? String(c.label).slice(0, 60) : null];
  });
  return { tops: TOPS, predicates, nodes, links, islands: order.map(([, n]) => n), capped, total_nodes: deg.size };
}

let overviewMemo = null;
/** The answer of GET /api/graph3d/all: built once per graph version (a full load or a writer's change), at most once a minute. */
export async function overview3d() {
  const g = await graph();
  // not loaded (the database is not connected yet, just after a start): say so, and keep nothing
  if (!g.loadedTs) throw new Error('the ontology graph is still loading: try again in a few seconds');
  const key = `${g.loadedTs}|${g.logV}`;
  if (overviewMemo && (overviewMemo.key === key || Date.now() - overviewMemo.ts < 60e3)) return overviewMemo.data;
  const { classOf } = await import('./sync.js');
  const data = { ...buildOverview(g, { cls: classOf }), graph_loaded_ts: g.loadedTs, built_ts: Date.now() };
  overviewMemo = { key, ts: Date.now(), data };
  return data;
}
