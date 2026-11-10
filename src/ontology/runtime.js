// Starts the ontology's background parts in a process: the heartbeat (both roles), and in the worker the shadow check of the three
// pass-through lists and the periodic backfill.
import { config } from '../config.js';
import { warn } from '../log.js';
import { startHeartbeat, shadow, comparePass } from './shadow.js';
import { backfill, parity } from './backfill.js';
import { metaGet, metaSet } from '../db.js';
import { refreshSnapshot } from './sync.js';
import { syncGroupingIfChanged } from './apply.js';

let backfilling = false;

/** The three router lists (docs/ontology-design.md, 2.1) against the ontology: each list's answer for every account any list names. */
export async function shadowLists() {
  const [{ ROUTERS: detect }, { ROUTERS: origin }, { PASS_THROUGH: trace }] = await Promise.all([import('../incident/detect.js'), import('../incident/origin.js'), import('../incident/trace.js')]);
  const lists = { detect, origin, trace };
  const all = new Set(Object.values(lists).flatMap((l) => [...l]));
  for (const [name, list] of Object.entries(lists)) for (const a of all) shadow(`pass_through.${name}`, a, list.has(a), comparePass(list.has(a)));
}

async function runBackfill() {
  if (backfilling) return;
  backfilling = true;
  try {
    // G2's evidence: what the direct writers left missing or stale, measured before the backfill repairs it (14 days kept)
    const p = await parity().catch((e) => { warn(`ontology parity failed: ${e.message}`); return null; });
    if (p) await metaSet('ontology_parity', [...(await metaGet('ontology_parity', [])), { ts: p.ts, clean: p.clean, writers: p.writers }].slice(-14));
    await backfill(); await refreshSnapshot({ force: true }); await shadowLists();
  } catch (e) { warn(`ontology backfill failed: ${e.message}`); } finally { backfilling = false; }
}

/** role: 'web' | 'worker' | 'all'. */
export function startOntology(role) {
  startHeartbeat(role);
  refreshSnapshot().catch(() => {});
  const snapT = setInterval(() => refreshSnapshot().catch(() => {}), 10 * 60e3); snapT.unref?.();
  if (role === 'web') return;
  shadowLists().catch(() => {});
  // stored grouping kinds follow the grouping rule (once per change of ONTOLOGY_READ), after the snapshot is loaded
  const sync = setTimeout(() => syncGroupingIfChanged().catch((e) => warn(`ontology grouping re-sync failed: ${e.message}`)), 30e3); sync.unref?.();
  const every = config.ontology.backfillEveryHours;
  if (every > 0) {
    const first = setTimeout(runBackfill, 2 * 60e3); first.unref?.(); // after the worker's first cycle
    const t = setInterval(runBackfill, every * 3600e3); t.unref?.();
  }
}
