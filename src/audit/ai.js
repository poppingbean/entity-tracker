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
import { chatJSON, aiEnabled } from '../ai/tools/nearai.js';
import { UNTRUSTED_RULE, evidenceMessage } from '../ai/tools/untrusted.js';
import { ROLES } from './classify.js';
import { POWERS, SEV } from './powers.js';

import { prompt } from '../ai/prompts/index.js';
import { aiBudget } from '../ai/tools/budget.js';
import { verifiedFindings } from '../ai/tools/verify.js';
const VALID_ROLES = new Set([...Object.keys(ROLES), 'nft', 'token', 'multi_token', 'unknown']);
const day = () => new Date().toISOString().slice(0, 10);

async function ask(system, preamble, evidence, { model = config.ai.model, maxTokens = 1500 } = {}) {
  const { user, findings } = evidenceMessage(preamble, evidence);
  const { json, model: used } = await chatJSON({ system: system + UNTRUSTED_RULE, user, model, maxTokens, timeoutMs: config.ai.analysisTimeoutMs, attempts: 2 });
  return { json: json || {}, model: used, injection: findings };
}

const CODE_SYSTEM = prompt('audit-code-review', { roles: [...VALID_ROLES].join(', '), powers: Object.keys(POWERS).join(', ') }); // src/ai/prompts/

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

const DEEP_SYSTEM = prompt('audit-deep-review');

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

const CHANGE_SYSTEM = prompt('audit-change');
/** Stage 5 (Haiku): what a redeploy changed. */
export async function aiExplainChange(change) {
  if (!(await aiBudget())) return null;
  const { json, model } = await ask(CHANGE_SYSTEM, 'Before and after the redeploy:', change, { maxTokens: 1200 });
  return { explanation: String(json.explanation || '').slice(0, 800), severity: SEV.includes(json.severity) ? (json.severity === 'critical' ? 'high' : json.severity) : 'medium', model, ts: Date.now() };
}

const WRITE_SYSTEM = prompt('audit-write-up');
/** Stage 7 (Haiku): the plain-language summary of one account's audit. */
export async function aiWriteUp(account, auto) {
  if (!(await aiBudget())) return null;
  const evidence = { account, type: auto.label, standards: auto.standards, level: auto.level, control: auto.control?.summary, controllers: (auto.control?.controllers || []).map((c) => ({ account: c.account, kind: c.kind, via: c.via, flags: c.flags })),
    findings: auto.findings.filter((f) => f.severity !== 'info').map((f) => ({ severity: f.severity, title: f.title, detail: f.detail })).slice(0, 20), facts: auto.facts, deploy: auto.deploy };
  const { json, model } = await ask(WRITE_SYSTEM, 'Audit to summarise:', evidence, { maxTokens: 1500 });
  return { headline: String(json.headline || '').slice(0, 200), summary: String(json.summary || '').slice(0, 1000), risks_for_users: (Array.isArray(json.risks_for_users) ? json.risks_for_users : []).map((x) => String(x).slice(0, 200)).slice(0, 4), model, ts: Date.now() };
}
