// Where the AI works in the automated audit (docs/auto-audit-design.md §4.7). Rules screen; the AI takes what rules can't place:
//   code review (Haiku, once per new code)   the type of an unrecognised contract; which power each unknown method is
//   deep review (Sonnet, once per new code)  for contracts that hold value or look risky: what can go wrong, from the capability map,
//                                            the claimed source's admin functions and recent behaviour
//   change (Haiku)                           what a redeploy changed for users
//   write-up (Haiku)                         a plain-language summary of an audit
// Guardrails: everything from the contract (strings in its code, method names, metadata, source files) is attacker-written and goes
// through the untrusted-data guard; the AI can only add risk; every AI finding must cite a method or string the pipeline can check, or
// it is dropped; calls are cached per code and capped per day (AUTO_AUDIT_AI_PER_DAY).
import { col } from '../db.js';
import { config } from '../config.js';
import { chatJSON, aiEnabled } from '../ai/nearai.js';
import { UNTRUSTED_RULE, evidenceMessage } from '../ai/untrusted.js';
import { ROLES } from './classify.js';
import { POWERS, SEV } from './powers.js';

const VALID_ROLES = new Set([...Object.keys(ROLES), 'nft', 'token', 'multi_token', 'unknown']);
const day = () => new Date().toISOString().slice(0, 10);

/** Take one call from today's budget; false when it is spent (or the AI is off). */
export async function aiBudget() {
  if (!aiEnabled() || config.autoAudit.aiDailyBudget <= 0) return false;
  const r = await col('meta').findOneAndUpdate({ _id: `audit:ai:${day()}` }, { $inc: { 'value.calls': 1 }, $set: { ts: Date.now() } }, { upsert: true, returnDocument: 'after' });
  const doc = r?.value !== undefined && r?.ok !== undefined ? r.value : r; // driver versions differ
  return (doc?.value?.calls ?? 0) <= config.autoAudit.aiDailyBudget;
}
async function ask(system, preamble, evidence, { model = config.ai.model, maxTokens = 1500 } = {}) {
  const { user, findings } = evidenceMessage(preamble, evidence);
  const { json, model: used } = await chatJSON({ system: system + UNTRUSTED_RULE, user, model, maxTokens, timeoutMs: config.ai.analysisTimeoutMs, attempts: 2 });
  return { json: json || {}, model: used, injection: findings };
}
/** Keep only AI findings whose evidence (a method or a string) is really in the contract; severities capped at high (rules decide critical). */
export function verifiedFindings(items, { exports = [], strings = [], sourceText = '' } = {}) {
  const ex = new Set(exports), hay = strings.join('\n') + '\n' + sourceText;
  return (Array.isArray(items) ? items : []).map((x) => ({ severity: SEV.includes(x?.severity) ? x.severity : 'medium', title: String(x?.title || '').slice(0, 140), detail: String(x?.detail || '').slice(0, 600), evidence: String(x?.evidence || '').slice(0, 120) }))
    .filter((x) => x.title && x.evidence && (ex.has(x.evidence) || (x.evidence.length >= 6 && hay.includes(x.evidence))))
    .map((x) => ({ ...x, severity: x.severity === 'critical' ? 'high' : x.severity, key: 'ai_finding', ai: true }));
}

const CODE_SYSTEM = `You are a NEAR smart-contract security reviewer. You get a contract's exported methods, what the rule engine already
concluded (type, powers, unknown methods), what each write method can reach in the code (NEAR host functions: deploy_code, add keys,
send_near, delete_account, reads_caller), readable strings from its WASM (panic and log messages) and its NEP-330 source metadata.
1. If the rule type is "unknown" or low-confidence, say what kind of contract it most likely is: one of ${[...VALID_ROLES].join(', ')}.
2. For each method in "unknown_writes", say which power it most likely gives (one of: ${Object.keys(POWERS).join(', ')}, or "none" for a
   normal user action), from its name, the strings and its type.
Base everything on the evidence given; do not guess beyond it. Reply with ONE JSON object:
{"role":"<type>","role_confidence":0..1,"role_reason":"one sentence","powers":[{"method":"name","power":"<power or none>","confidence":0..1,"reason":"short"}]}
Keep each reason under 20 words.`;

/** Stages 1 + 2 for one code (Haiku). Returns { role, role_confidence, role_reason, powers: [{ method, power, reason }], model } or null. */
export async function aiCodeReview(code, strings) {
  if (!(await aiBudget())) return null;
  const evidence = { rule: { role: code.role, confidence: code.confidence, candidates: code.candidates, powers: code.powers.map((p) => ({ power: p.power, methods: p.methods })) },
    exports: (code.exports || []).slice(0, 250), unknown_writes: code.unknown_writes.slice(0, 30), capabilities: code.capabilities, strings: strings.slice(0, 40), source: code.source };
  const { json, model, injection } = await ask(CODE_SYSTEM, 'Contract to review:', evidence, { maxTokens: 3000 });
  const ex = new Set(code.exports || []);
  return {
    role: VALID_ROLES.has(json.role) ? json.role : null, role_confidence: Math.max(0, Math.min(1, Number(json.role_confidence) || 0)), role_reason: String(json.role_reason || '').slice(0, 300),
    powers: (Array.isArray(json.powers) ? json.powers : []).filter((p) => ex.has(p?.method) && (POWERS[p?.power] || p?.power === 'none')).slice(0, 40).map((p) => ({ method: p.method, power: p.power, confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)), reason: String(p.reason || '').slice(0, 200) })),
    injection: injection.length ? injection : undefined, model, ts: Date.now(),
  };
}

const DEEP_SYSTEM = `You are a senior NEAR smart-contract auditor. A rule engine already audited this contract: its type, the powers its
methods give and who holds them, what each write method can reach in the code (host functions), and recent behaviour. You may also get
excerpts of the admin functions from the source the contract claims (NEP-330). Find what can go wrong FOR USERS that the rule findings
do not already say: a way for the owner or anyone to take users' funds or NFTs, block withdrawals or sales, mint or inflate, change fees
or prices to drain value, or take over accounts. Every finding must cite as "evidence" an exact method name from the exports or an
exact string from the strings or source excerpts. No speculation without evidence; if nothing new, return an empty list.
Reply with ONE JSON object: {"findings":[{"severity":"high|medium|low","title":"short","detail":"2-3 sentences","evidence":"method or exact string"}],
"summary":"2-3 sentences on how the contract's design protects or exposes users"}`;

/** Stages 3 + 4 + 6 (Sonnet): extra findings with checked evidence. Cached per code by the caller. */
export async function aiDeepReview(code, auto, strings, sourceReview) {
  if (!(await aiBudget())) return null;
  const writes = Object.fromEntries(Object.entries(code.capabilities || {}).slice(0, 80));
  const evidence = { type: { role: code.role, label: code.label, standards: code.standards }, exports: (code.exports || []).slice(0, 250), capabilities: writes,
    rule_findings: auto.findings.filter((f) => f.severity !== 'info').map((f) => ({ severity: f.severity, title: f.title, detail: f.detail })).slice(0, 25),
    control: auto.control, behaviour: auto.facts?.behaviour, strings: strings.slice(0, 40),
    source: sourceReview?.excerpts?.length ? { link: sourceReview.link, missing_methods: sourceReview.missing, admin_functions: sourceReview.excerpts.map((e) => ({ path: e.path, method: e.method, code: e.text.slice(0, 2500) })) } : null };
  const { json, model, injection } = await ask(DEEP_SYSTEM, 'Contract audit to review:', evidence, { model: config.ai.analysisModel, maxTokens: 2500 });
  const findings = verifiedFindings(json.findings, { exports: code.exports || [], strings, sourceText: (sourceReview?.excerpts || []).map((e) => e.text).join('\n') });
  return { findings, summary: String(json.summary || '').slice(0, 800), dropped: Math.max(0, (Array.isArray(json.findings) ? json.findings.length : 0) - findings.length), injection: injection.length ? injection : undefined, model, ts: Date.now() };
}

const CHANGE_SYSTEM = `You explain what a contract upgrade changed, for its users, in plain English. You get the powers and exported methods
before and after the redeploy. Say what users should know (new powers, removed limits, new ways to move funds) in 2-3 sentences; if nothing
that matters to users changed, say so. Reply with ONE JSON object: {"explanation":"2-3 sentences","severity":"high|medium|low|info"}`;
/** Stage 5 (Haiku): what a redeploy changed. */
export async function aiExplainChange(change) {
  if (!(await aiBudget())) return null;
  const { json, model } = await ask(CHANGE_SYSTEM, 'Before and after the redeploy:', change, { maxTokens: 500 });
  return { explanation: String(json.explanation || '').slice(0, 800), severity: SEV.includes(json.severity) ? (json.severity === 'critical' ? 'high' : json.severity) : 'medium', model, ts: Date.now() };
}

const WRITE_SYSTEM = `You write the summary of an automated security audit of a NEAR contract for ordinary users, in plain English. You get its
type, who controls it, the findings (already decided: never soften or contradict them) and facts. Say what the contract is, who is in
charge, and what could go wrong for someone who uses it, without technical jargon. No financial advice.
Reply with ONE JSON object: {"headline":"one sentence","summary":"2-4 sentences","risks_for_users":["1-4 short points"]}`;
/** Stage 7 (Haiku): the plain-language summary of one account's audit. */
export async function aiWriteUp(account, auto) {
  if (!(await aiBudget())) return null;
  const evidence = { account, type: auto.label, standards: auto.standards, level: auto.level, control: auto.control?.summary, controllers: (auto.control?.controllers || []).map((c) => ({ account: c.account, kind: c.kind, via: c.via, flags: c.flags })),
    findings: auto.findings.filter((f) => f.severity !== 'info').map((f) => ({ severity: f.severity, title: f.title, detail: f.detail })).slice(0, 20), facts: auto.facts, deploy: auto.deploy };
  const { json, model } = await ask(WRITE_SYSTEM, 'Audit to summarise:', evidence, { maxTokens: 700 });
  return { headline: String(json.headline || '').slice(0, 200), summary: String(json.summary || '').slice(0, 1000), risks_for_users: (Array.isArray(json.risks_for_users) ? json.risks_for_users : []).map((x) => String(x).slice(0, 200)).slice(0, 4), model, ts: Date.now() };
}
