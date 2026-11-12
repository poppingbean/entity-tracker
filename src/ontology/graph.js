// The ontology's graph in memory: every live edge between accounts (funded, controls, deployed, created_by, member_of, role_in …) as an
// adjacency list both ways, plus which accounts are bad (flagged critical / high, or on the attacker's side of a confirmed case). It is small
// (2026-11-12: 9,537 edges, ~5,000 nodes, a few MB, 1.3 s to load), so walks of 2-6 hops run in memory with no database round trip.
// MongoDB (`ontology_facts`) stays the source of truth: this is a read copy.
//
// Fresh in every process (web and worker) without reloading everything:
//   - a full load at first use and every 10 minutes;
//   - a writer run (backfill.js runWriters) appends the accounts it touched to a short change log in `meta` (ontology_graph_log) and applies
//     it in its own process at once; other processes read the log at most every 30 s and re-read only those accounts' edges;
//   - a process too far behind the log (it keeps the last 200 runs) reloads in full.
import { col, metaGet } from '../db.js';
import { classOf } from './sync.js';
import { info } from '../log.js';

/** Predicates that link two accounts (or an account to a group or a case node). */
export const EDGE_PREDICATES = ['funded', 'swept_to', 'controls', 'deployed', 'created_by', 'operated_by', 'solver_for', 'member_of', 'role_in', 'sent_to'];
/** Roles on the attacker's side of a case: an account with one, in a confirmed case, is bad. */
export const BAD_ROLES = new Set(['attacker', 'accomplice', 'sub_account', 'intents_account', 'cash_out_wallet', 'fake_token']);
const FULL_MS = 10 * 60e3, POLL_MS = 30e3, LOG_KEEP = 200;

let G = emptyGraph(), loading = null, lastPoll = 0;
function emptyGraph() { return { out: new Map(), in: new Map(), bad: new Map(), loadedTs: 0, logV: 0 }; }
const live = (now) => ({ $or: [{ valid_to: null }, { valid_to: { $gt: now } }] });

/** Add one fact to a graph (pure on the graph object). */
export function addFact(g, f) {
  const from = String(f.subject), to = String(f.object);
  if (f.predicate === 'flagged' && ['critical', 'high'].includes(f.object)) { g.bad.set(from, { why: `flagged ${f.object}${f.evidence ? `: ${f.evidence}` : ''}` }); return; }
  if (!EDGE_PREDICATES.includes(f.predicate)) return;
  const e = { p: f.predicate, to, s: f.source, role: f.role || null, status: f.status || null };
  (g.out.get(from) || g.out.set(from, []).get(from)).push(e);
  (g.in.get(to) || g.in.set(to, []).get(to)).push({ ...e, to: from });
  if (f.predicate === 'role_in' && f.status === 'confirmed' && BAD_ROLES.has(f.role) && !g.bad.has(from)) g.bad.set(from, { why: `${String(f.role).replace(/_/g, ' ')} in ${to}` });
}

/** Remove every fact whose subject is `id` (before re-reading them). */
function dropSubject(g, id) {
  for (const e of g.out.get(id) || []) { const l = g.in.get(e.to); if (l) { const k = l.filter((x) => x.to !== id); if (k.length) g.in.set(e.to, k); else g.in.delete(e.to); } }
  g.out.delete(id); g.bad.delete(id);
}

/** Load every live edge (and every bad account). */
export async function loadGraph() {
  if (loading) return loading;
  loading = (async () => {
    const t0 = Date.now(), g = emptyGraph();
    const rows = await col('ontology_facts').find({ ...live(t0), predicate: { $in: [...EDGE_PREDICATES, 'flagged'] } }, { projection: { subject: 1, predicate: 1, object: 1, source: 1, role: 1, status: 1, evidence: 1 } }).toArray();
    for (const f of rows) addFact(g, f);
    g.loadedTs = Date.now(); g.logV = (await metaGet('ontology_graph_log', null).catch(() => null))?.v || 0;
    G = g;
    info(`ontology graph: ${rows.length} facts, ${g.out.size} nodes with edges, ${g.bad.size} bad accounts (${Date.now() - t0} ms)`);
    return G;
  })().finally(() => { loading = null; });
  return loading;
}

/** Re-read the edges of some accounts (the ones a writer just touched). */
export async function reloadSubjects(ids, g = G) {
  ids = [...new Set(ids.filter(Boolean).map(String))];
  if (!ids.length || !g.loadedTs) return 0;
  const now = Date.now();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    part.forEach((id) => dropSubject(g, id));
    for (const f of await col('ontology_facts').find({ ...live(now), subject: { $in: part }, predicate: { $in: [...EDGE_PREDICATES, 'flagged'] } }, { projection: { subject: 1, predicate: 1, object: 1, source: 1, role: 1, status: 1, evidence: 1 } }).toArray()) addFact(g, f);
  }
  return ids.length;
}

/** After a writer run: log the accounts it touched for the other processes, and apply them here. Never throws. */
export async function noteGraphChange(touched) {
  if (!touched?.length) return;
  try {
    const v = Date.now(), entry = { v, ids: [...new Set(touched)].slice(0, 2000) };
    await col('meta').updateOne({ _id: 'ontology_graph_log' }, { $set: { 'value.v': v, ts: v }, $push: { 'value.runs': { $each: [entry], $slice: -LOG_KEEP } } }, { upsert: true });
    if (G.loadedTs) { await reloadSubjects(entry.ids); G.logV = Math.max(G.logV, v); }
  } catch { /* the next full load catches up */ }
}

/**
 * The graph, fresh enough. Not loaded yet: load it (`wait: false` starts the load and returns the empty graph at once, so a caller with a
 * time budget never waits). Older than 10 minutes: reload in the background, keep answering from the current copy. Every 30 s: apply the
 * change log of the other processes; one that fell off the end of the log reloads in full.
 */
export async function graph({ wait = true } = {}) {
  const now = Date.now();
  if (!G.loadedTs) { const p = loadGraph().catch(() => G); if (wait) await p; return G; }
  if (now - G.loadedTs > FULL_MS) loadGraph().catch(() => {});
  if (now - lastPoll > POLL_MS) {
    lastPoll = now;
    const log = (await metaGet('ontology_graph_log', null).catch(() => null)) || {};
    if ((log.v || 0) > G.logV) {
      const runs = log.runs || [], oldest = runs[0]?.v ?? 0;
      if (runs.length >= LOG_KEEP && G.logV < oldest) await loadGraph().catch(() => {}); // runs were dropped before this process read them
      else { await reloadSubjects(runs.filter((r) => r.v > G.logV).flatMap((r) => r.ids)); G.logV = log.v; }
    }
  }
  return G;
}
export const graphReady = () => G.loadedTs > 0;

/**
 * Walk from an account, breadth first, through the given predicates (both directions unless `dir` says), up to `maxHops`. A node that cuts
 * links (an exchange, a service, a contract, the system: the ontology's class) is never walked through: two wallets paid by the same
 * exchange are not linked. Returns [{ node, hop, path: [{ from, p, dir, to }] }] for every node reached (the start excluded). Pure on `g`.
 */
// group and case nodes (grp:…, inc:…) are not accounts: they never cut a path (an account's class decides that)
const NODE = /^(grp|inc):/;
export const cutsPath = (id) => !NODE.test(id) && classOf(id).cuts_links;

export function walk(g, from, { predicates = EDGE_PREDICATES, dir = 'both', maxHops = 2, maxNodes = 2000, cuts = cutsPath } = {}) {
  const seen = new Set([from]), out = [];
  let frontier = [{ node: from, path: [] }];
  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next = [];
    for (const { node, path } of frontier) {
      const edges = [...(dir !== 'in' ? (g.out.get(node) || []).map((e) => ({ ...e, d: 'out' })) : []), ...(dir !== 'out' ? (g.in.get(node) || []).map((e) => ({ ...e, d: 'in' })) : [])];
      for (const e of edges) {
        if (!predicates.includes(e.p) || seen.has(e.to)) continue;
        seen.add(e.to);
        const p = [...path, { from: node, p: e.p, dir: e.d, to: e.to }];
        out.push({ node: e.to, hop, path: p });
        if (out.length >= maxNodes) return out;
        // a case or a group node links its members; an account that cuts links ends the branch (recorded, never walked through)
        if (!e.to.startsWith('inc:') && (NODE.test(e.to) || !cuts(e.to))) next.push({ node: e.to, path: p });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * The nearest bad account within `maxHops` of `id` through money and control links (funded, deployed / created_by, controls, a shared wallet
 * group), or null. The account itself is not counted, and an account that cuts links (an exchange …) is not checked: an exchange is one hop
 * from every customer, honest or not. Pure on `g`.
 */
export function nearBad(g, id, { maxHops = 2, cuts = cutsPath } = {}) {
  if (cuts(id)) return null;
  const hits = walk(g, id, { predicates: ['funded', 'deployed', 'created_by', 'controls', 'member_of'], maxHops, cuts }).filter((h) => g.bad.has(h.node) && !h.node.startsWith('grp:'));
  if (!hits.length) return null;
  const h = hits.sort((a, b) => a.hop - b.hop)[0];
  return { account: h.node, hop: h.hop, why: g.bad.get(h.node).why, path: h.path };
}

/** One line for a path: "a funded b, b member of grp:x, …". */
export const pathText = (path) => path.map((s) => (s.p === 'member_of' ? (s.dir === 'out' ? `${s.from} is in group ${s.to}` : `${s.to} is in the same group`) : s.dir === 'out' ? `${s.from} ${s.p.replace(/_/g, ' ')} ${s.to}` : `${s.to} ${s.p.replace(/_/g, ' ')} ${s.from}`)).join(', ');
