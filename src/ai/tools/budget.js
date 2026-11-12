// The AI's daily call budgets: every AI stage takes one call, so a flood of new contracts or findings cannot run up the bill. Two scopes,
// counted per UTC day in MongoDB (meta <scope>:ai:<day>): the contract audits (AUTO_AUDIT_AI_PER_DAY, 200) and the hack investigations,
// their reports and deep reviews (INCIDENT_AI_PER_DAY, 60).
import { col } from '../../db.js';
import { config } from '../../config.js';
import { aiEnabled } from './nearai.js';

const day = () => new Date().toISOString().slice(0, 10);
// each scope has its own count, so a busy day of contract audits cannot leave the hack investigations without NEAR AI
const SCOPES = { audit: () => config.autoAudit.aiDailyBudget, incident: () => config.incidents.aiPerDay, watch: () => config.watch.aiPerDay };

/** Take one call from today's budget of `scope` (audit or incident); false when it is spent (or the AI is off). */
export async function aiBudget(scope = 'audit') {
  // the contract audits get extra calls a day when the Academy's revenue reserve pays for them (0 when its business is off)
  const extra = scope === 'audit' ? await import('../../academy/business.js').then((m) => m.extraAiCalls()).catch(() => 0) : 0;
  const base = SCOPES[scope]();
  if (!aiEnabled() || base <= 0) return false; // an operator's 0 turns the AI off: extra calls never turn it back on
  const limit = base + extra;
  const r = await col('meta').findOneAndUpdate({ _id: `${scope}:ai:${day()}` }, { $inc: { 'value.calls': 1 }, $set: { ts: Date.now() } }, { upsert: true, returnDocument: 'after' });
  const doc = r?.value !== undefined && r?.ok !== undefined ? r.value : r; // driver versions differ
  return (doc?.value?.calls ?? 0) <= limit;
}
