// The AI's daily call budget: every AI stage of the audits and the investigations takes one call from it, so a flood of new contracts or
// findings cannot run up the bill. AUTO_AUDIT_AI_PER_DAY (200) sets it; the count is per UTC day in MongoDB (meta audit:ai:<day>).
import { col } from '../../db.js';
import { config } from '../../config.js';
import { aiEnabled } from './nearai.js';

const day = () => new Date().toISOString().slice(0, 10);
/** Take one call from today's budget; false when it is spent (or the AI is off). */
export async function aiBudget() {
  if (!aiEnabled() || config.autoAudit.aiDailyBudget <= 0) return false;
  const r = await col('meta').findOneAndUpdate({ _id: `audit:ai:${day()}` }, { $inc: { 'value.calls': 1 }, $set: { ts: Date.now() } }, { upsert: true, returnDocument: 'after' });
  const doc = r?.value !== undefined && r?.ok !== undefined ? r.value : r; // driver versions differ
  return (doc?.value?.calls ?? 0) <= config.autoAudit.aiDailyBudget;
}
