// The automated audit of one contract as the outside world sees it (public API, the safety-check page), and audits started in this
// process: a web-only server has no worker queue, so a page that asks for an audit starts one here and polls it.
import { col } from '../db.js';
import { autoAudit, AUTO_AUDIT_V } from './auto.js';
import { enqueueAudit } from './watcher.js';

const jobs = new Map(); // account -> { running, started, error }
/** Start an automated audit of `id` in this process unless one is running. Returns the job. */
export function startAutoAudit(id, { force = false } = {}) {
  const cur = jobs.get(id);
  if (cur?.running) return cur;
  const j = { running: true, started: Date.now(), error: null };
  jobs.set(id, j);
  autoAudit(id, { force }).catch((e) => { j.error = e.message; }).finally(() => { j.running = false; });
  if (jobs.size > 500) for (const [k, v] of jobs) if (!v.running) { jobs.delete(k); if (jobs.size <= 400) break; }
  return j;
}
export const auditJob = (id) => jobs.get(id) || null;

/**
 * The automated audit of one contract. Missing or older than a day: queued for the worker (`queue`), or started here (`start`).
 * status: ok | refreshing | queued | auditing | no_contract.
 */
export async function contractReport(id, { start = false } = {}) {
  const doc = await col('audits').findOne({ _id: id }, { projection: { auto: 1 } });
  const a = doc?.auto;
  const stale = !a || a.v !== AUTO_AUDIT_V || Date.now() - a.ts > 86400e3;
  if (stale) { if (start) startAutoAudit(id); else await enqueueAudit(id, { reason: 'api', priority: 3, force: false }); }
  const job = auditJob(id);
  if (!a) return { account: id, status: job?.running ? 'auditing' : 'queued', job: job ? { running: job.running, started: job.started, error: job.error } : null, note: 'no audit yet: it is being done, ask again in a minute' };
  if (a.no_code) return { account: id, status: 'no_contract' };
  return { account: id, status: stale ? 'refreshing' : 'ok', audited_ts: a.ts, type: { role: a.role, label: a.label, standards: a.standards, confidence: a.confidence, source: a.role_source },
    level: a.level, control: { summary: a.control?.summary, full_access_keys: a.control?.full_keys, controllers: (a.control?.controllers || []).map((c) => ({ account: c.account, kind: c.kind, via: c.via, flags: c.flags })) },
    powers: (a.powers || []).map((p) => ({ power: p.power, label: p.label, methods: p.methods, severity: p.severity, normal_for_type: !!p.normal_for_role })),
    findings: (a.findings || []).filter((f) => f.severity !== 'info').map((f) => ({ severity: f.severity, key: f.key, title: f.title, detail: f.detail, ai: !!f.ai })),
    family: { code: a.code_key, accounts: a.family_n }, source: a.source ? { link: a.source.link, version: a.source.version, verified_methods: a.source_review ? !a.source_review.missing?.length && !a.source_review.error : null } : null,
    deploy: a.deploy ? { deployer: a.deploy.deployer, signer: a.deploy.signer } : null, summary: a.summary ? { headline: a.summary.headline, summary: a.summary.summary, risks_for_users: a.summary.risks_for_users } : null,
    change: a.change ? { added_powers: a.change.added_powers, removed_powers: a.change.removed_powers, explanation: a.change.ai?.explanation || null } : null };
}
