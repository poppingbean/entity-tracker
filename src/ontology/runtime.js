// Starts the ontology's background parts in a process: the heartbeat (both roles), and in the worker the shadow check of the three
// pass-through lists and the periodic backfill.
import { config } from '../config.js';
import { warn } from '../log.js';
import { startHeartbeat, shadow, comparePass } from './shadow.js';
import { backfill } from './backfill.js';

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
  try { await backfill(); await shadowLists(); } catch (e) { warn(`ontology backfill failed: ${e.message}`); } finally { backfilling = false; }
}

/** role: 'web' | 'worker' | 'all'. */
export function startOntology(role) {
  startHeartbeat(role);
  if (role === 'web') return;
  shadowLists().catch(() => {});
  const every = config.ontology.backfillEveryHours;
  if (every > 0) {
    const first = setTimeout(runBackfill, 2 * 60e3); first.unref?.(); // after the worker's first cycle
    const t = setInterval(runBackfill, every * 3600e3); t.unref?.();
  }
}
