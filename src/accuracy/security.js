// Accuracy of the security verdicts (WP-03 to WP-05): hack cases and live detections, the firewall, contract audits. Everything is scored
// against the ground truth of truth.js. Pure functions on plain objects (unit-tested) with thin database wrappers at the bottom.
// Nothing here changes a verdict, a flag or an alert: it only measures.
import { col } from '../db.js';
import { config } from '../config.js';
import { confusion, auc } from './score.js';
import { incidentTruth, detectionTruth, accountTruth } from './truth.js';

const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const pct = (xs, p) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
export const SMALL = 'few cases: read as a first sign, not a measurement';
/** Every block carries its sample size and, when small, a note. */
export const withN = (o, n) => ({ ...o, n, ...(n < 20 ? { note: SMALL } : {}) });

/** When the status history says the rules (not a report or a person) first called the case confirmed, or null. */
export const firstRulesConfirm = (inc) => (inc.status_history || []).find((e) => e.status === 'confirmed' && e.by === 'rules')?.ts ?? null;
/** The first time a report or an operator confirmed it, or null. */
const firstOutsideConfirm = (inc) => (inc.status_history || []).find((e) => e.status === 'confirmed' && (e.by === 'report' || e.by === 'operator'))?.ts ?? (inc.confirmed_by?.ts ?? null);

/**
 * Hack cases. rows: [{ inc, truth: { label, source } }]. `called` = ever confirmed by the rules (a public grave tag); precision over the
 * labelled ones; recall = of the cases labelled bad, how many the rules confirmed before any report or operator; time to detect; cases
 * the rules called and later cleared (`retracted`, with the hours each stayed public); loss figure ratio; cases found long after.
 */
export function casesAccuracy(rows, { alertMaxAgeDays = 7 } = {}) {
  const labelled = rows.filter((x) => x.truth.label), called = rows.filter((x) => firstRulesConfirm(x.inc) != null);
  const conf = confusion(labelled.map((x) => ({ flagged: firstRulesConfirm(x.inc) != null, bad: x.truth.label === 'bad' })));
  const retracted = called.filter((x) => (x.inc.status_history || []).some((e) => e.ts > firstRulesConfirm(x.inc) && ['cleared', 'suspected', 'dismissed'].includes(e.status))).slice(0, 20).map((x) => {
    const t0 = firstRulesConfirm(x.inc), end = (x.inc.status_history || []).find((e) => e.ts > t0 && e.status !== 'confirmed');
    return { id: x.inc._id, hours_public: r3((end.ts - t0) / 3600e3) };
  });
  const bad = rows.filter((x) => x.truth.label === 'bad');
  const byRules = bad.filter((x) => { const t = firstRulesConfirm(x.inc), o = firstOutsideConfirm(x.inc); return t != null && (o == null || t <= o); });
  const ttd = byRules.map((x) => (firstRulesConfirm(x.inc) - (x.inc.started_ts ?? x.inc.first_seen_ts)) / 60e3).filter((m) => m >= 0);
  const ratios = bad.filter((x) => x.inc.confirmed_by?.loss_usd > 0 && x.inc.traced_usd > 0).map((x) => x.inc.traced_usd / x.inc.confirmed_by.loss_usd);
  const foundLater = bad.filter((x) => { const t = Math.min(...[firstRulesConfirm(x.inc), firstOutsideConfirm(x.inc)].filter((v) => v != null)); return Number.isFinite(t) && x.inc.started_ts != null && t - x.inc.started_ts > alertMaxAgeDays * 86400e3; }).length;
  return withN({ called: called.length, ...conf, retracted, recall_by_rules: bad.length ? r3(byRules.length / bad.length) : null, labelled_bad: bad.length,
    time_to_detect_min: { median: r3(median(ttd)), p90: r3(pct(ttd, 0.9)), n: ttd.length }, found_later: foundLater,
    loss_ratio: { median: r3(median(ratios)), within_25pct: ratios.length ? r3(ratios.filter((x) => Math.abs(x - 1) <= 0.25).length / ratios.length) : null, n: ratios.length }, unlabelled: rows.length - labelled.length }, labelled.length);
}

/** The same precision / recall per case kind, when a kind has 5+ labelled cases (otherwise just n). */
export function byKind(rows) {
  const kinds = [...new Set(rows.map((x) => x.inc.kind || 'none'))], out = {};
  for (const k of kinds) {
    const xs = rows.filter((x) => (x.inc.kind || 'none') === k && x.truth.label);
    out[k] = xs.length >= 5 ? (({ precision, recall, tp, fp, fn, tn }) => ({ n: xs.length, precision, recall, tp, fp, fn, tn }))(confusion(xs.map((x) => ({ flagged: firstRulesConfirm(x.inc) != null, bad: x.truth.label === 'bad' })))) : { n: xs.length };
  }
  return out;
}

/** Live detections: flagged = the detector called it a suspect (or a hack). rows: [{ det, truth }]. */
export function detectionsAccuracy(rows) {
  const labelled = rows.filter((x) => x.truth.label);
  const kinds = {}; for (const x of rows) kinds[x.det.kind || 'none'] = (kinds[x.det.kind || 'none'] || 0) + 1;
  return withN({ ...confusion(labelled.map((x) => ({ flagged: ['suspect', 'hack'].includes(x.det.verdict), bad: x.truth.label === 'bad' }))), by_kind: kinds, unlabelled: rows.length - labelled.length }, labelled.length);
}

/** Audit level to a risk number (critical 4 … info 0) for the AUC. */
export const LEVEL_RISK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
/** The truth of a contract: a hand label; bad when it rugged, is the target of a bad case or is flagged critical; good when 30 days old with none of those; else unknown. */
export function contractTruth(c, now = Date.now()) {
  if (c.manual === 'bad' || c.manual === 'good') return { label: c.manual, source: 'manual' };
  if (c.rugged || c.target_of_bad_case || c.flagged_critical) return { label: 'bad', source: c.rugged ? 'rugged' : c.target_of_bad_case ? 'case_target' : 'flag' };
  if (c.first_ts != null && now - c.first_ts >= 30 * 86400e3) return { label: 'good', source: 'aged_30d' };
  return { label: null, source: null };
}
/** Audits: counts per level, the bad rate per level, AUC with the level as the risk, coverage. rows: [{ level, truth }]. */
export function auditsAccuracy(rows, audited = rows.length) {
  const per = {};
  for (const lv of Object.keys(LEVEL_RISK)) { const xs = rows.filter((x) => x.level === lv); const l = xs.filter((x) => x.truth.label); per[lv] = withN({ audited: xs.length, labelled: l.length, bad_rate: l.length ? r3(l.filter((x) => x.truth.label === 'bad').length / l.length) : null }, l.length); }
  const lab = rows.filter((x) => x.truth.label);
  return { per_level: per, auc: auc(lab.map((x) => ({ risk: LEVEL_RISK[x.level] ?? null, bad: x.truth.label === 'bad' }))), coverage: { labelled: lab.length, audited }, ...(lab.length < 20 ? { note: SMALL } : {}) };
}

/** Firewall: of known-bad accounts how many get block or warn; of known-good accounts how many get a verdict above ok (false alarms). check(id) → { verdict, findings }. */
export function firewallAccuracy(bad, good, check) {
  const hit = bad.map((id) => ({ id, ...check(id) })), fa = good.map((id) => ({ id, ...check(id) }));
  const falseAlarms = fa.filter((x) => x.verdict !== 'ok');
  return { blocked_bad: withN({ share: bad.length ? r3(hit.filter((x) => ['block', 'warn'].includes(x.verdict)).length / bad.length) : null, missed: hit.filter((x) => !['block', 'warn'].includes(x.verdict)).slice(0, 20).map((x) => x.id) }, bad.length),
    false_alarm_good: withN({ share: good.length ? r3(falseAlarms.length / good.length) : null, rows: falseAlarms.slice(0, 30).map((x) => ({ account: x.id, verdict: x.verdict, finding: x.findings?.[0]?.code || null })) }, good.length) };
}

// ---------------------------------------------------------------- the database side

/** Every case with its truth. */
async function loadCases(now) {
  const man = await col('ground_truth').find({ kind: 'incident' }).toArray(), by = new Map(man.map((m) => [m.id, m.label]));
  const incs = await col('incidents').find({}, { projection: { status: 1, kind: 1, status_history: 1, confirmed_by: 1, cleared: 1, started_ts: 1, first_seen_ts: 1, traced_usd: 1, stolen_usd: 1, accounts: 1, 'target.account': 1 } }).toArray();
  return incs.map((inc) => ({ inc, truth: incidentTruth(inc, by.get(inc._id), now) }));
}

/** The offline firewall context for an account: stored flags and the ontology, no network (the same rule set a wallet's check would use). */
async function offlineCheck(ids) {
  const { checkTransactions, TRUSTED } = await import('../firewall/rules.js');
  const { whatIsMany } = await import('../ontology/index.js');
  const flags = new Map((await col('firewall_flags').find({ _id: { $in: ids } }).toArray()).map((f) => [f._id, f]));
  const ents = await whatIsMany(ids);
  const accounts = new Map(ids.map((id) => { const f = flags.get(id), e = ents.get(id); return [id, { exists: true, contract: !!e && /^contract|^service/.test(e.class), flags: f ? [{ severity: f.severity, reason: f.reason, detail: f.detail }] : [], label: e?.label || null, known_dapp: TRUSTED.has(id) || !!e?.trusted }]; }));
  const ctx = { accounts, signers: new Map(), trusted: TRUSTED, near_usd: null };
  return (id) => {
    const tx = { signer: 'user.near', receiver: id, actions: [{ index: 0, kind: 'transfer', deposit: '1000000000000000000000000' }] };
    const r = checkTransactions([tx], ctx);
    return { verdict: r.verdict, findings: r.findings };
  };
}

/** The whole security block, stored by evaluateAccuracy under `security`. */
/**
 * The money watch (docs/money-watch-design.md section 8). Ground truth is a person's report or a hack case: the number to keep at zero is
 * the watches the reviewer closed as normal whose money later turned out to be part of a hack (a report after the close, or an account of
 * the watch in a case labelled bad). Aggregates only: watches are private, so no id leaves this function.
 * rows: watches ({ status, closed_ts, status_history, reports, accounts }); badAccounts: accounts of cases labelled bad.
 */
export function watchAccuracy(rows, badAccounts = new Set()) {
  const closedBy = (w) => [...(w.status_history || [])].reverse().find((h) => h.status === 'normal')?.by || null;
  const normal = rows.filter((w) => w.status === 'normal');
  const laterBad = normal.filter((w) => (w.reports || []).some((r) => r.ts > (w.closed_ts || 0)) || (w.accounts || []).some((a) => badAccounts.has(a.account)));
  const escalated = rows.filter((w) => (w.status_history || []).some((h) => h.status === 'suspicious'));
  const confirmed = escalated.filter((w) => w.status === 'confirmed' || (w.accounts || []).some((a) => badAccounts.has(a.account)));
  const by = {}; for (const w of normal) { const k = closedBy(w) === 'rules' && /idle/.test(JSON.stringify(w.status_history?.at(-1) || '')) ? 'idle' : closedBy(w) || 'unknown'; by[k] = (by[k] || 0) + 1; }
  return withN({ watches: rows.length, open: rows.filter((w) => ['watching', 'suspicious'].includes(w.status)).length, closed_normal: normal.length, closed_by: by,
    normal_later_bad: laterBad.length, escalated: escalated.length, escalated_confirmed: confirmed.length, escalated_precision: escalated.length ? r3(confirmed.length / escalated.length) : null }, normal.length + escalated.length);
}

export async function securityAccuracy({ now = Date.now() } = {}) {
  const cases = await loadCases(now), out = {};
  out.incidents = { ...casesAccuracy(cases, { alertMaxAgeDays: config.incidents.alertMaxAgeDays }), by_kind: byKind(cases) };
  // live detections
  const dets = await col('incident_detections').find({}, { projection: { verdict: 1, kind: 1, receiver: 1, ts: 1 } }).toArray();
  const caseOf = new Map(cases.map((c) => [c.inc._id, c.truth]));
  out.detections = detectionsAccuracy(dets.map((det) => ({ det, truth: detectionTruth(det, caseOf.get(`inc:${det.receiver}`) || null, null, now) })));
  // account truth from case roles
  const roleTruth = new Map();
  for (const c of cases) for (const a of c.inc.accounts || []) { const l = roleTruth.get(a.account) || []; l.push({ role: a.role, truth: c.truth.label }); roleTruth.set(a.account, l); }
  // the firewall: known-bad from case roles, known-good from the golden set and the busiest services / contracts
  const { GOLDEN } = await import('../ontology/golden.js');
  const bad = [...roleTruth].filter(([a, roles]) => accountTruth(a, roles).label === 'bad' && /\.near$|^[0-9a-f]{64}$/.test(a)).map(([a]) => a).slice(0, 300);
  const goldenGood = GOLDEN.filter(([, cls]) => accountTruth('x', [], null, cls).label === 'good').map(([a]) => a);
  const busy = (await col('ontology_entities').find({ top: { $in: ['exchange', 'service', 'contract'] } }, { projection: { _id: 1 } }).limit(200).toArray()).map((e) => e._id);
  const good = [...new Set([...goldenGood, ...busy])].filter((a) => !bad.includes(a));
  if (bad.length || good.length) {
    const check = await offlineCheck([...bad, ...good]);
    const { lookalikeOf } = await import('../firewall/rules.js');
    out.firewall = { ...firewallAccuracy(bad, good, check), lookalike_false_alarms: good.filter((a) => lookalikeOf(a)).slice(0, 20) };
  }
  // contract audits
  const man = new Map((await col('ground_truth').find({ kind: 'contract' }).toArray()).map((m) => [m.id, m.label]));
  const audits = await col('audits').find({ 'auto.level': { $exists: true } }, { projection: { 'auto.level': 1, 'auto.ts': 1, fetchedAt: 1 } }).toArray();
  const ids = audits.map((a) => a._id);
  const rugged = new Set((await col('tokens').find({ _id: { $in: ids }, 'outcome.rugged': true }, { projection: { _id: 1 } }).toArray()).map((t) => t._id));
  const targets = new Set(cases.filter((c) => c.truth.label === 'bad').map((c) => c.inc.target?.account).filter(Boolean));
  const crit = new Set((await col('firewall_flags').find({ _id: { $in: ids }, severity: 'critical' }, { projection: { _id: 1 } }).toArray()).map((f) => f._id));
  // the contract's age comes from when it was deployed (contract_deploys), never from when it was audited
  const deployed = new Map((await col('contract_deploys').aggregate([{ $match: { account: { $in: ids } } }, { $group: { _id: '$account', ts: { $min: '$ts' } } }]).toArray()).map((d) => [d._id, d.ts]));
  out.audits = auditsAccuracy(audits.map((a) => ({ level: a.auto.level, truth: contractTruth({ manual: man.get(a._id), rugged: rugged.has(a._id), target_of_bad_case: targets.has(a._id), flagged_critical: crit.has(a._id), first_ts: deployed.get(a._id) ?? null }, now) })), audits.length);
  // classification: the golden set against the ontology's answers
  const { GOLDEN: G, checkGolden, goldenReport } = await import('../ontology/golden.js');
  const { whatIsMany: wim } = await import('../ontology/index.js');
  out.ontology = goldenReport(checkGolden(await wim(G.map((g) => g[0]))));
  // the money watch: closed as normal, then shown to be part of a hack (the number to keep at zero)
  const badAccounts = new Set([...roleTruth].filter(([a, roles]) => accountTruth(a, roles).label === 'bad').map(([a]) => a));
  const watches = await col('watches').find({}, { projection: { status: 1, closed_ts: 1, status_history: 1, 'reports.ts': 1, 'accounts.account': 1 } }).toArray().catch(() => []);
  if (watches.length) out.money_watch = watchAccuracy(watches, badAccounts);
  return out;
}
