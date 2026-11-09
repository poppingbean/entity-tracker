// Shadow mode (migration step 2): every module keeps deciding as today; beside each decision we ask the ontology the same question and
// record whether the two agree. Never awaited by the caller, never changes a decision, never throws. The gate reads what this records.
//   ontology_shadow        one document per (module, account, old answer): agree, the ontology's answer and why, counts, first/last seen
//   ontology_shadow_stats  per module and day: decisions, disagreements, missing (the ontology knew nothing), latency samples
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { col, metaSet, metaGet } from '../db.js';
import { config } from '../config.js';
import { whatIsMany } from './index.js';

/** The migration steps this code contains. Each migration PR adds its letter; the heartbeat reports them and the gate reads them. */
export const ONTOLOGY_STEPS = ['A', 'B', 'C', 'D', 'E', 'F'];

const on = () => config.ontology?.shadow !== false;
const seen = new Map(); // module|account|old → { ts, r }: the last comparison, reused for an hour
const stats = new Map(); // module|day → { n, disagree, missing, ms: [] }
let queue = [], busy = false, flushTimer = null;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const key = (...p) => createHash('sha1').update(p.map((x) => JSON.stringify(x)).join('|')).digest('hex').slice(0, 24);

/**
 * Record one decision. `old` is what the module decided (a string / boolean); `compare(entity)` returns
 * { agree: bool, now: what the ontology says, missing?: bool } for the ontology's resolved entity.
 */
export function shadow(module, account, old, compare) {
  if (!on() || !account) return;
  const ts = Date.now(), k = `${module}|${account}|${JSON.stringify(old)}`;
  // the same decision again within the hour: count it with the last comparison, no new ontology read
  const c = seen.get(k);
  if (c && ts - c.ts < 3600e3) { count(module, ts, c.r); return; }
  if (queue.length >= 2000) return; // never grow without bound; a busy loop is sampled
  queue.push({ module, account: String(account), old, compare, ts, k });
  if (!busy) setImmediate(drain);
  if (!flushTimer) { flushTimer = setInterval(() => flushStats().catch(() => {}), 60e3); flushTimer.unref?.(); }
}

const count = (module, ts, r) => { const s = stat(module, ts); s.n++; if (r.missing) s.missing++; else if (!r.agree) s.disagree++; return s; };

/** Record latency of an ontology read made in shadow for a latency-bound module (the firewall's 2.5 s budget). */
const stat = (module, ts) => {
  const k = `${module}|${day(ts)}`;
  if (!stats.has(k)) stats.set(k, { module, day: day(ts), n: 0, disagree: 0, missing: 0, ms: [] });
  return stats.get(k);
};

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, 200);
      const t0 = Date.now();
      const ents = await whatIsMany(batch.map((b) => b.account));
      const ms = Date.now() - t0;
      const writes = [];
      for (const b of batch) {
        const e = ents.get(b.account);
        let r;
        try { r = b.compare(e); } catch { continue; }
        const s = count(b.module, b.ts, r);
        if (s.ms.length < 500 && b === batch.find((x) => x.module === b.module)) s.ms.push(ms); // one ontology read (the whole batch) per module
        const fresh = seen.get(b.k);
        seen.set(b.k, { ts: Date.now(), r }); if (seen.size > 20000) seen.delete(seen.keys().next().value);
        if (fresh && Date.now() - fresh.ts < 3600e3) continue; // queued twice before the first comparison landed
        writes.push({ updateOne: { filter: { _id: key(b.module, b.account, b.old) }, upsert: true, update: {
          $set: { module: b.module, account: b.account, old: b.old, agree: !!r.agree && !r.missing, missing: !!r.missing, now: r.now ?? null, class: e?.class ?? null, why: e?.why ?? null, conflicts: e?.conflicts?.length || 0, last_ts: b.ts, steps: ONTOLOGY_STEPS },
          $setOnInsert: { first_ts: b.ts }, $inc: { n: 1 } } } });
      }
      if (writes.length) await col('ontology_shadow').bulkWrite(writes, { ordered: false }).catch(() => {});
    }
  } catch { /* shadow must never break the caller */ } finally { busy = false; }
}

/** Write the per-day counters (every minute, and on demand). */
export async function flushStats() {
  const all = [...stats.values()];
  stats.clear();
  for (const s of all) {
    if (!s.n) continue;
    await col('ontology_shadow_stats').updateOne({ _id: `${s.module}|${s.day}` }, { $set: { module: s.module, day: s.day }, $inc: { n: s.n, disagree: s.disagree, missing: s.missing }, $push: { ms: { $each: s.ms, $slice: -2000 } } }, { upsert: true }).catch(() => {});
  }
}

/** The commit this process runs: the host's variable, or git when deployed from a checkout. */
export function runningCommit() {
  const env = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || process.env.SOURCE_VERSION || process.env.RENDER_GIT_COMMIT;
  if (env) return env;
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim() || null; } catch { return null; }
}

/** Heartbeat (once a minute): which commit and which migration steps run, per process role. The gate's proof that a PR is deployed. */
export function startHeartbeat(role) {
  if (config.ontology?.heartbeat === false) return;
  const commit = runningCommit(), started = Date.now();
  const beat = async () => {
    await metaSet(`ontology_heartbeat:${role}`, { role, commit, steps: ONTOLOGY_STEPS, shadow: on(), started_ts: started, ts: Date.now() });
    // when each step was first seen running (the start of its shadow window)
    const since = await metaGet('ontology_steps_since', {});
    let changed = false;
    for (const s of ONTOLOGY_STEPS) if (!since[s]) { since[s] = { ts: Date.now(), commit }; changed = true; }
    if (changed) await metaSet('ontology_steps_since', since);
  };
  beat().catch(() => {});
  const t = setInterval(() => beat().catch(() => {}), 60e3); t.unref?.();
}

// --- comparisons used by the hooks: what each module's old answer means in the ontology's terms ---

/** origin.identify(): kind exchange | service | contract | wallet. */
export const compareIdentify = (old) => (e) => {
  if (!e || e.class === 'unknown') return { missing: true, now: 'unknown' };
  const now = e.top === 'person' ? 'wallet' : e.top === 'system' ? 'contract' : e.top;
  // routers, launchpads and bridges have code: the tracer calls them contracts, the ontology services; that is no disagreement
  const agree = old === now || old === 'contract' && e.top === 'service' && e.class !== 'service/intents_solver';
  return { agree, now: e.class };
};
/** A yes / no about passing money through. */
export const comparePass = (old) => (e) => ({ agree: !!old === !!e?.pass_through, now: !!e?.pass_through, missing: !old && (!e || e.class === 'unknown') });
/** Grouping: does sharing this account link two wallets? (old: classifyAccount kind, or isService) */
export const compareCuts = (oldCuts) => (e) => {
  if (!e || e.class === 'unknown') return { missing: true, now: 'unknown', agree: !oldCuts };
  return { agree: !!oldCuts === !!e.cuts_links, now: e.class };
};
/** Firewall: the worst flag severity, and whether it is an exchange. */
export const compareFirewall = (old) => (e) => {
  const sev = e?.flagged?.severity || null;
  const exch = e?.top === 'exchange';
  return { agree: (old.severity || null) === sev && (!old.exchange || exch), now: { severity: sev, exchange: exch, class: e?.class || 'unknown' }, missing: !old.severity && !old.exchange && (!e || e.class === 'unknown') };
};
