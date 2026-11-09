// The ontology for code that cannot wait: the tracers and grouping ask "is this a router? does it link owners?" inside tight loops.
// A snapshot of `ontology_entities` (rebuilt by every backfill) is kept in memory and refreshed every 10 minutes; an account not in it
// is resolved from the code-level facts alone (names, the known lists). Same answers as whatIs(), without a database round trip.
//
// ONTOLOGY_READ says which modules decide with the ontology: a comma list of pass_through, tracer, grouping, firewall, or "none".
// It is the rollback: ONTOLOGY_READ=none puts every module back on its old rules without deploying old code.
import { col } from '../db.js';
import { config } from '../config.js';
import { virtualFacts } from './known.js';
import { resolve } from './resolve.js';

let snap = new Map(), loadedTs = 0, loading = null;
const memo = new Map();

/** Load (or reload) the snapshot: one load at a time, at most every 10 minutes unless forced. */
export async function refreshSnapshot({ force = false } = {}) {
  if (loading) return loading;
  if (!force && Date.now() - loadedTs < 10 * 60e3) return snap.size;
  loading = (async () => {
    try {
      const rows = await col('ontology_entities').find({}, { projection: { class: 1, top: 1, pass_through: 1, cuts_links: 1, why: 1, label: 1, operator: 1, source: 1, confidence: 1, trusted: 1 } }).toArray();
      snap = new Map(rows.map((r) => [r._id, { class: r.class, top: r.top, pass_through: !!r.pass_through, cuts_links: !!r.cuts_links, why: r.why, label: r.label || null, operator: r.operator || null, source: r.source || null, confidence: r.confidence ?? 0, trusted: !!r.trusted }]));
      memo.clear(); loadedTs = Date.now();
    } catch { /* keep the last snapshot */ }
    return snap.size;
  })().finally(() => { loading = null; });
  return loading;
}
export const snapshotSize = () => snap.size;

/** The resolved answer for an account, synchronously: { class, top, pass_through, cuts_links, why, label, operator }. */
export function classOf(id) {
  const a = String(id || '');
  const s = snap.get(a);
  if (s) return s;
  let m = memo.get(a);
  if (!m) {
    const r = resolve(a, virtualFacts(a));
    m = { class: r.class, top: r.top, pass_through: r.pass_through, cuts_links: r.cuts_links, why: r.why, label: r.label, operator: r.operator, source: r.source, confidence: r.confidence, trusted: r.trusted };
    memo.set(a, m); if (memo.size > 20000) memo.delete(memo.keys().next().value);
  }
  return m;
}
export const passThrough = (id) => classOf(id).pass_through;

/** Does this module decide with the ontology? (ONTOLOGY_READ) */
export const reads = (module) => {
  const r = config.ontology?.read;
  return !!r && r !== 'none' && String(r).split(',').map((x) => x.trim()).includes(module);
};
/** For tests and the replay: switch modules at run time. */
export const setReads = (list) => { config.ontology.read = list; };

/** The ontology has a real answer (not "nothing known", not the weakest "nothing marks it as special" fact). */
export const confident = (c) => !!c && c.class !== 'unknown' && !(c.source === 'name_pattern' && (c.confidence ?? 0) < 0.3);

const HUB_TX_COUNT = 15000;
/**
 * Grouping's kind for an account (intents | relayer | protocol | hub | wallet), from the ontology; null when it has no real answer
 * (the caller then keeps its old rules). Only "wallet" links owners; relayer and protocol are never a funder; hub funds but links nothing.
 */
export function groupingKind(account, txCount) {
  const c = classOf(account);
  if (!confident(c)) return null;
  const k = c.class;
  if (k.startsWith('person')) return (txCount ?? 0) >= HUB_TX_COUNT ? 'hub' : 'wallet';
  if (k === 'service/intents_solver' || account === 'intents.near') return 'intents';
  if (k === 'service/relayer') return 'relayer';
  if (k.startsWith('exchange') || k === 'service/bridge' || k === 'service/treasury_or_reward') return 'hub';
  return 'protocol'; // routers, launchpads, factories, contracts, system
}
