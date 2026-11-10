// The migration gate: is the next ontology PR ready to be opened? Read-only. Decides from what production reports, not from a person:
//   - the heartbeat: which migration steps the running processes contain (proof a PR is merged AND deployed);
//   - the shadow log: how long it has run, how many decisions each module made, every disagreement not explained in triage.json;
//   - the golden set, resolved against production's facts;
//   - the firewall's latency for an ontology read.
//   node src/cli.js ontology-gate [--json]
import { readFileSync } from 'node:fs';
import { THROTTLE_MS } from './writers.js';
import { col, metaGet } from '../db.js';
import { whatIsMany, clearCache } from './index.js';
import { GOLDEN, checkGolden } from './golden.js';

export const GATE = {
  minDays: 7,
  heartbeatFreshMs: 15 * 60e3,
  minDecisions: { 'tracer.identify': 50, 'tracer.pass_through': 200, 'grouping.classify': 500, 'grouping.service': 500, 'firewall.context': 200 },
  firewallP95Ms: 300, // an ontology read may take this share of the firewall's 2.5 s budget
  parityRuns: 3,      // G2: this many daily parity checks in a row with nothing missing or stale (after G1 runs)
  parityLagShare: 0.01, // ... except the throttled writers (entities, clusters), allowed this share of their facts (up to 10 minutes behind)
};

// The PRs after A (docs/ontology-design.md, 6), what each needs, and which shadow modules it moves.
export const STEPS = {
  B: { title: 'show it: account pages, GET /api/v1/entity, the what_is Agent Guard tool (step 8)', needs: ['A'], days: 0, modules: [] },
  C: { title: 'one pass-through definition (step 3)', needs: ['A'], days: GATE.minDays, modules: ['pass_through.detect', 'pass_through.origin', 'pass_through.trace', 'tracer.pass_through'] },
  D: { title: 'incident tracer reads whatIs (step 4)', needs: ['A', 'C'], days: GATE.minDays, modules: ['tracer.identify'], replay: true },
  E: { title: 'grouping reads whatIs (step 5)', needs: ['A'], days: GATE.minDays, modules: ['grouping.classify', 'grouping.service'] },
  F: { title: 'firewall and Safety Check read whatIsMany (step 6)', needs: ['A'], days: GATE.minDays, modules: ['firewall.context'], latency: true },
  // step 7 in three parts (docs/ontology-design.md 6.5). G1 started before the 7-day window by the operator's choice: it is additive and
  // changes no decision. G2 waits for its own evidence (parity). G3 removes the rollback switch, so it waits for #74's readers' 7 days.
  G1: { title: 'writers assert facts at the source (step 7, part 1)', needs: ['A', 'C', 'D', 'E', 'F'], days: 0, modules: [] },
  G2: { title: 'the daily backfill off, its old facts retired (step 7, part 2)', needs: ['G1'], days: 0, modules: [], parity: true },
  G3: { title: 'the old lists and the ONTOLOGY_READ switch go (step 7, part 3)', needs: ['A', 'C', 'D', 'E', 'F', 'G1'], daysOf: ['C', 'D', 'E', 'F'], days: GATE.minDays, modules: [] },
};

/** Disagreements already explained (the cause, and what was done), kept in the repository so they are reviewed in PRs. */
/** What keeps one parity record from being clean (docs/ontology-design.md 6.5, G2). */
export function parityProblems(p) {
  const out = [];
  for (const [name, w] of Object.entries(p.writers || {})) {
    const allowed = THROTTLE_MS[name] ? Math.ceil((w.facts || 0) * GATE.parityLagShare) : 0;
    if (w.missing + w.stale > allowed) out.push(`${name}: ${w.missing} missing, ${w.stale} stale${w.sample_missing?.length ? ` (e.g. ${w.sample_missing[0]})` : ''}`);
    if (w.legacy) out.push(`${name}: ${w.legacy} facts still from the old backfill`);
  }
  return out;
}

export function loadTriage(path = new URL('./triage.json', import.meta.url)) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

const p95 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]); };

export async function gate({ now = Date.now() } = {}) {
  const beats = (await col('meta').find({ _id: /^ontology_heartbeat:/ }).toArray()).map((d) => d.value).filter(Boolean);
  const fresh = beats.filter((b) => now - b.ts < GATE.heartbeatFreshMs);
  const worker = fresh.filter((b) => b.role === 'worker' || b.role === 'all');
  const web = fresh.filter((b) => b.role === 'web' || b.role === 'all');
  // a step is running only when every fresh process has it (a half-finished deploy does not count)
  const running = (s) => worker.length > 0 && fresh.every((b) => (b.steps || []).includes(s));
  const since = await metaGet('ontology_steps_since', {});
  const daysSince = (s) => (since[s]?.ts ? (now - since[s].ts) / 86400e3 : 0);

  clearCache();
  const golden = checkGolden(await whatIsMany(GOLDEN.map((g) => g[0])));
  const goldenOk = golden.every((g) => g.ok);

  const triage = loadTriage();
  const startDay = since.A?.ts ? new Date(since.A.ts).toISOString().slice(0, 10) : '9999';
  const stats = await col('ontology_shadow_stats').find({ day: { $gte: startDay } }).toArray();
  const mod = {};
  for (const s of stats) {
    const m = mod[s.module] ||= { n: 0, disagree: 0, missing: 0, ms: [] };
    m.n += s.n || 0; m.disagree += s.disagree || 0; m.missing += s.missing || 0; m.ms.push(...(s.ms || []));
  }
  const open = await col('ontology_shadow').find({ agree: false, missing: false, last_ts: { $gte: (since.A?.ts || now) - 3600e3 } }, { projection: { module: 1, account: 1, old: 1, now: 1, class: 1, why: 1, n: 1, last_ts: 1 } }).sort({ n: -1 }).limit(2000).toArray();
  const unexplained = open.filter((d) => !triage[`${d.module}|${d.account}`]);
  const modules = Object.fromEntries(Object.entries(mod).map(([k, m]) => [k, { decisions: m.n, disagreements: m.disagree, missing: m.missing, p95_ms: p95(m.ms), unexplained: unexplained.filter((d) => d.module === k).length }]));

  const steps = {};
  for (const [id, st] of Object.entries(STEPS)) {
    const why = [];
    if (running(id)) { steps[id] = { title: st.title, status: 'done', why: ['running in production'] }; continue; }
    for (const n of st.needs) if (!running(n)) why.push(`step ${n} is not running in production yet`);
    const last = Math.min(...(st.daysOf || st.needs).map(daysSince));
    if (st.days && last < st.days) why.push(`shadow log ${last.toFixed(1)} of ${st.days} days`);
    if (!goldenOk) why.push(`golden set: ${golden.filter((g) => !g.ok).map((g) => `${g.account.slice(0, 20)} is ${g.got}, expected ${g.expect}`).join('; ')}`);
    for (const m of st.modules) {
      const x = modules[m] || { decisions: 0, unexplained: 0 };
      const min = GATE.minDecisions[m];
      if (min && x.decisions < min) why.push(`${m}: ${x.decisions} of ${min} decisions`);
      if (x.unexplained) why.push(`${m}: ${x.unexplained} disagreements not explained in src/ontology/triage.json`);
    }
    if (st.latency) {
      const ms = modules['firewall.context']?.p95_ms;
      if (!web.length) why.push('no web process heartbeat (the firewall runs there)');
      if (ms == null || ms > GATE.firewallP95Ms) why.push(`firewall ontology read p95 ${ms ?? '?'} ms (budget ${GATE.firewallP95Ms} ms)`);
    }
    if (st.replay) why.push('the stored-case replay (shipped with PR C) has not passed yet');
    if (st.parity) {
      const runs = (await metaGet('ontology_parity', [])).filter((p) => p.ts > (since.G1?.ts || Infinity)).slice(-GATE.parityRuns);
      const bad = runs.map((p) => parityProblems(p)).filter((x) => x.length);
      if (runs.length < GATE.parityRuns) why.push(`parity: ${runs.length} of ${GATE.parityRuns} daily checks since G1 runs`);
      if (bad.length) why.push(`parity: ${bad[bad.length - 1].join('; ')}`);
    }
    steps[id] = { title: st.title, status: why.length ? 'waiting' : 'ready', why };
  }
  return {
    ts: now,
    deployed: fresh.map((b) => ({ role: b.role, commit: b.commit, steps: b.steps, shadow: b.shadow, seen_s: Math.round((now - b.ts) / 1000) })),
    shadow_since: since,
    golden: { ok: goldenOk, failed: golden.filter((g) => !g.ok) },
    modules,
    unexplained: unexplained.slice(0, 50).map((d) => ({ module: d.module, account: d.account, old: d.old, ontology: d.now, why: d.why, n: d.n })),
    steps,
    next: Object.entries(steps).filter(([, s]) => s.status === 'ready').map(([id]) => id),
  };
}

/** The gate as text, for a person or a pull request description. */
export function gateText(g) {
  const L = [];
  L.push(`Ontology migration gate · ${new Date(g.ts).toISOString()}`);
  L.push(g.deployed.length ? `Running: ${g.deployed.map((d) => `${d.role} ${String(d.commit || '?').slice(0, 7)} steps ${d.steps.join(',')}`).join(' · ')}` : 'Running: no fresh heartbeat (the ontology code is not deployed, or the processes are down)');
  L.push(`Golden set: ${g.golden.ok ? 'all correct' : `${g.golden.failed.length} wrong`}`);
  for (const f of g.golden.failed) L.push(`  ✗ ${f.account} is ${f.got}, expected ${f.expect} (${f.why || 'no facts'})`);
  L.push('Shadow modules:');
  for (const [m, x] of Object.entries(g.modules)) L.push(`  ${m.padEnd(22)} ${String(x.decisions).padStart(7)} decisions · ${x.disagreements} disagree · ${x.unexplained} unexplained · ${x.missing} unknown${x.p95_ms != null ? ` · p95 ${x.p95_ms} ms` : ''}`);
  if (g.unexplained.length) { L.push('Unexplained disagreements (top):'); for (const d of g.unexplained.slice(0, 15)) L.push(`  ${d.module} ${d.account}: old ${JSON.stringify(d.old)}, ontology ${JSON.stringify(d.ontology)} (${d.why || ''})`); }
  L.push('Steps:');
  for (const [id, s] of Object.entries(g.steps)) L.push(`  ${id} ${s.status.toUpperCase().padEnd(7)} ${s.title}${s.why.length && s.status !== 'done' ? `\n      - ${s.why.join('\n      - ')}` : ''}`);
  L.push(g.next.length ? `Ready to open: ${g.next.join(', ')}` : 'Nothing ready yet.');
  return L.join('\n');
}
