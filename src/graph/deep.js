// Deep linking: follow funding and money flow up to DEEP_DEPTH hops from every early wallet, through ordinary wallets only, and report
// the accounts that two or more early wallets reach. Pure functions (unit-tested); the DB side is graph/expand.js.
//
// Edges come from what the profiler stored for each wallet (early wallets and the "network" wallets expand.js profiles around them):
//   funders / chain  - who funded it (every meaningful first funder, then the first funder's own chain)
//   flow_out         - where it sent NEAR (dust to bots / fee addresses is ignored)
// Exchanges, relayers, protocol accounts, NEAR Intents and hot wallets (kinds other than "wallet") are never walked through: sharing them proves nothing.
import { classifyAccount, isGenericKind } from './profile.js';

export const DEEP_DEPTH = 3;        // hops followed from an early wallet
export const DEEP_MAX_DEGREE = 30;  // an account touching more wallets than this is a distributor / service, not an owner
export const DEEP_MAX_REACH = 15;   // an account reached by more early wallets than this links nothing
export const DEEP_MIN_NEAR = 2;     // flows below this are dust

/** Undirected neighbour list of one profiled wallet: [{ account, rel: 'funder' | 'flow', near }]. */
export function walletNeighbors(w) {
  const out = [];
  for (const f of w.funders || []) if (f.account && !f.creator_only && !isGenericKind(f.kind)) out.push({ account: f.account, rel: 'funder', near: f.near ?? null });
  for (const c of w.chain || []) { if (isGenericKind(c.kind)) break; if (c.account) out.push({ account: c.account, rel: 'funder', near: c.near ?? null }); }
  for (const f of w.flow_out || []) {
    if (!f.to || f.to === w._id || (f.near ?? 0) < DEEP_MIN_NEAR) continue;
    if (isGenericKind(classifyAccount(f.to, null))) continue;
    out.push({ account: f.to, rel: 'flow', near: f.near });
  }
  return out;
}

/** Kind of every account we know something about (profiled wallets, funders in chains), so hubs and relayers can be skipped by kind, not only by name. */
export function kindMap(docs) {
  const kinds = new Map();
  for (const w of docs) {
    if (w.kind) kinds.set(w._id, w.kind);
    for (const f of w.funders || []) if (f.kind && !kinds.has(f.account)) kinds.set(f.account, f.kind);
    for (const c of w.chain || []) if (c.kind && !kinds.has(c.account)) kinds.set(c.account, c.kind);
  }
  return kinds;
}

/**
 * Undirected adjacency over the profiled wallets. Chains contribute their own links (chain[0] funded the wallet, chain[1] funded chain[0] ...)
 * so a profiled wallet's funding line is walkable even when the intermediate accounts were never profiled themselves.
 */
export function buildAdjacency(docs) {
  const adj = new Map();
  const add = (a, b, rel) => {
    if (!a || !b || a === b) return;
    (adj.get(a) || adj.set(a, new Map()).get(a)).set(b, rel);
    (adj.get(b) || adj.set(b, new Map()).get(b)).set(a, rel);
  };
  for (const w of docs) {
    for (const n of walletNeighbors(w)) add(w._id, n.account, n.rel);
    let prev = w._id;
    for (const c of w.chain || []) { if (isGenericKind(c.kind)) break; add(prev, c.account, 'funder'); prev = c.account; }
  }
  return adj;
}

/** Accounts that must not be walked through: wrong kind (exchange / relayer / hub ...) or too many neighbours (distributor). */
export function blockedSet(adj, kinds, maxDegree = DEEP_MAX_DEGREE) {
  const blocked = new Set();
  for (const [a, nb] of adj) if (nb.size > maxDegree || (kinds.has(a) && isGenericKind(kinds.get(a))) || isGenericKind(classifyAccount(a, null))) blocked.add(a);
  return blocked;
}

/** Breadth-first from `start`, at most `maxDepth` hops, never entering or leaving a blocked account. Returns Map(node -> { d, parent }). */
export function reachFrom(start, adj, blocked, maxDepth = DEEP_DEPTH) {
  const seen = new Map([[start, { d: 0, parent: null }]]);
  let frontier = [start];
  for (let d = 1; d <= maxDepth; d++) {
    const next = [];
    for (const x of frontier) for (const y of adj.get(x)?.keys() || []) {
      if (seen.has(y) || blocked.has(y)) continue;
      seen.set(y, { d, parent: x });
      next.push(y);
    }
    frontier = next;
  }
  return seen;
}

/** Path of accounts from `start` to `node` (both included), following BFS parents. */
export function pathTo(reach, node) {
  const path = [];
  for (let x = node; x != null; x = reach.get(x)?.parent) path.push(x);
  return path.reverse();
}

/**
 * Accounts (not early wallets themselves unless they are the meeting point) that at least two early wallets reach within `maxDepth` hops.
 * Returns [{ anchor, depth, wallets, paths }] where depth is the longest leg and paths maps wallet -> [start, ..., anchor].
 * Reaches are returned too, for the per-group network summary.
 */
export function deepAnchors(earlyIds, docs, { maxDepth = DEEP_DEPTH, maxReach = DEEP_MAX_REACH, maxDegree = DEEP_MAX_DEGREE } = {}) {
  const adj = buildAdjacency(docs), kinds = kindMap(docs), blocked = blockedSet(adj, kinds, maxDegree);
  const reaches = new Map(), byNode = new Map();
  for (const id of earlyIds) {
    if (!adj.has(id) || blocked.has(id)) continue;
    const r = reachFrom(id, adj, blocked, maxDepth);
    reaches.set(id, r);
    for (const [node, info] of r) if (node !== id) (byNode.get(node) || byNode.set(node, []).get(node)).push({ wallet: id, d: info.d });
  }
  const anchors = [];
  for (const [anchor, hits] of byNode) {
    if (hits.length < 2 || hits.length > maxReach) continue;
    anchors.push({ anchor, depth: Math.max(...hits.map((h) => h.d)), wallets: hits.map((h) => h.wallet), paths: Object.fromEntries(hits.map((h) => [h.wallet, pathTo(reaches.get(h.wallet), anchor)])) });
  }
  return { anchors, reaches, adj, blocked };
}
