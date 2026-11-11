// Step G1 (docs/ontology-design.md 6.5): a module that changes the data a writer reads calls syncFacts right after, so the ontology knows
// at once, not at the next daily backfill. The writers are the backfill's own (backfill.js WRITERS), so a direct write and the backfill
// make the same facts; the parity check (backfill.js parity, the G2 gate) shows any data a module changed without calling this.
//
//   await syncFacts(['incidents', 'firewall_flags'])            after a case or its flags change
//   await syncFacts(['audits'], { scope: { audits: { ids } } })  after an audit (only those accounts)
//
// Never throws: a failed sync is logged and the daily backfill repairs it, so the caller's own work is never undone by the ontology.
// One sync per writer at a time; calls that arrive meanwhile are merged into one more run. ONTOLOGY_DIRECT_WRITERS=false turns it off.
// Loaded lazily, so the modules that call it do not import the ontology (and its imports) at start.
import { config } from '../config.js';
import { warn } from '../log.js';

// writers that read big, ever-changing collections run at most this often (a trailing run picks up what was skipped)
export const THROTTLE_MS = { entities: 10 * 60e3, clusters: 10 * 60e3 };
const state = new Map(); // writer -> { running: Promise|null, again: scope|true|null, last: ts, timer }
export const stats = { runs: 0, failed: 0, last: null };

const mergeScope = (a, b) => (a === true || b === true || !a || !b ? true : { ids: [...new Set([...(a.ids || []), ...(b.ids || [])])] });

async function runOne(name, scope) {
  const { runWriters } = await import('./backfill.js');
  const r = await runWriters([name], { scope: scope && scope !== true ? { [name]: scope } : {} });
  stats.runs++; stats.last = { writer: name, ts: Date.now(), written: r.written, retired: r.retired, touched: r.touched };
  return r;
}

function schedule(name, scope) {
  const s = state.get(name) || { running: null, again: null, last: 0, timer: null };
  state.set(name, s);
  if (s.running) { s.again = s.again ? mergeScope(s.again, scope) : scope; return s.running; }
  const wait = (THROTTLE_MS[name] || 0) - (Date.now() - s.last);
  if (wait > 0 && !scope?.ids) {
    // throttled: one trailing run when the window ends (unref: a short CLI process does not wait for it; the backfill covers it)
    if (!s.timer) { s.timer = setTimeout(() => { s.timer = null; schedule(name, true); }, wait); s.timer.unref?.(); }
    return Promise.resolve(null);
  }
  s.running = (async () => {
    let cur = scope;
    try {
      for (;;) {
        s.last = Date.now();
        await runOne(name, cur).catch((e) => { stats.failed++; warn(`ontology writer ${name}: ${e.message}`); });
        if (!s.again) break;
        cur = s.again; s.again = null;
      }
    } finally { s.running = null; }
  })();
  return s.running;
}

/** Re-run some writers now (scoped when `scope[name]` is given). Resolves when they are done; never rejects. */
export async function syncFacts(names, { scope = {} } = {}) {
  if (!config.ontology.directWriters) return;
  await Promise.all([].concat(names).map((n) => schedule(n, scope[n] || true))).catch(() => {});
}

/** Wait for the writers still running (a CLI command calls this before it closes the database). */
export async function flushWriters() {
  await Promise.all([...state.values()].map((s) => s.running).filter(Boolean)).catch(() => {});
}

/**
 * Sync one case: its role_in / sent_to facts and the flags of its accounts, not every case and flag (a full run re-resolves thousands of
 * accounts on each follow-up). `extra` adds accounts whose flag may have gone (the case's accounts before this save, a single new wallet).
 */
export async function syncCase(inc, extra = []) {
  if (!inc?._id) return;
  const accounts = [...new Set([...(inc.accounts || []).map((a) => a.account), inc.attacker?.account, ...extra].filter(Boolean))];
  await syncFacts(['incidents', 'firewall_flags'], { scope: { incidents: { ids: [inc._id] }, firewall_flags: { ids: accounts } } });
}
