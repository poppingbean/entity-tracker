// Runs an AI write-up and checks it against its evidence (WP-09): an account or number that is not in the evidence is asked again once,
// and if it is still there the text is kept but marked (`unverified`), so the page can say "Not found in the evidence: …".
// The check never changes a verdict: it only marks text. Every run is counted per path and day in meta `ai_grounding`.
import { col } from '../../db.js';
import { config } from '../../config.js';
import { KNOWN } from '../../ontology/known.js';
import { groundingReport } from './verify.js';
import { aiBudget } from './budget.js';

const ALLOW = Object.keys(KNOWN); // accounts the products themselves name (wrap.near, intents.near, …): a write-up may mention them
const day = () => new Date().toISOString().slice(0, 10);

/** Count one checked write-up: path = incident | analysis | nft | group | deep_review | followup. */
export async function recordGrounding(path, { clean, retried, unverified }) {
  const k = `value.days.${day()}.${path}`;
  try { await col('meta').updateOne({ _id: 'ai_grounding' }, { $inc: { [`${k}.checked`]: 1, [`${k}.clean`]: clean ? 1 : 0, [`${k}.retried`]: retried ? 1 : 0, [`${k}.unverified`]: unverified ? 1 : 0 }, $set: { ts: Date.now() } }, { upsert: true }); } catch { /* counting must never break a write-up */ }
}

/** The last 30 days' totals per path (older days are dropped): { path: { checked, clean, retried, unverified } }. */
export async function groundingTotals() {
  let doc = null; try { doc = await col('meta').findOne({ _id: 'ai_grounding' }); } catch { /* no database */ }
  const days = doc?.value?.days || {};
  const cutoff = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10), out = {}, old = {};
  for (const [d, paths] of Object.entries(days)) {
    if (d < cutoff) { old[`value.days.${d}`] = ''; continue; }
    for (const [p, c] of Object.entries(paths)) { const t = out[p] ||= { checked: 0, clean: 0, retried: 0, unverified: 0 }; for (const k of Object.keys(t)) t[k] += c[k] || 0; }
  }
  if (Object.keys(old).length) try { await col('meta').updateOne({ _id: 'ai_grounding' }, { $unset: old }); } catch { /* next time */ }
  return out;
}

const retryNote = (r) => `\n\nThese are not in the evidence, remove or correct them: ${[...r.accounts, ...r.amounts].slice(0, 20).join(', ')}`;

/**
 * `run(extra)` makes the model call (its `user` message plus `extra`) and returns the chatJSON result, `{ json, … }`; `pick(result)` is the
 * text to check (default the model's whole answer); `budget`: the AI budget scope the retry is charged to (incident, watch). Returns the final result with `unverified: { accounts, amounts }` or `null`.
 */
export async function grounded({ path, evidence, run, pick = (r) => r.json, budget = null }) {
  let res = await run('');
  if (!res?.json) return res;
  let rep = groundingReport(pick(res), evidence, { allow: ALLOW }), retried = false;
  // the retry is a second model call: on a budgeted path it takes one more call from the same daily budget, and is skipped when that is spent
  if (!rep.ok && config.ai.groundingRetry && (!budget || await aiBudget(budget).catch(() => false))) {
    retried = true;
    const again = await run(retryNote(rep)).catch(() => null);
    if (again?.json) { const r2 = groundingReport(pick(again), evidence, { allow: ALLOW }); if (r2.ok || r2.accounts.length + r2.amounts.length <= rep.accounts.length + rep.amounts.length) { res = again; rep = r2; } }
  }
  recordGrounding(path, { clean: rep.ok && !retried, retried, unverified: !rep.ok });
  return { ...res, unverified: rep.ok ? null : { accounts: rep.accounts, amounts: rep.amounts } };
}
