// Money watch, the review lane (docs/money-watch-design.md sections 4 and 6). One watch at a time, oldest first:
//   1. step 1, the look back: where did the money come from (origin class, from the chain), once per watch;
//   2. the rules' verdict (classifyOrigin / decide): closes the routine ones with no AI call;
//   3. NEAR AI reads the origin, the accounts watched and what they did, and any person's report: normal / keep_watching / suspicious;
//   4. normal closes the watch (stored, no longer followed); suspicious opens an incident (the full trace and the deep review take over; the
//      watch keeps being followed); keep_watching just moves the review clock.
// The AI never confirms a hack: only a person or a public report does (report.js).
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { txIndexer } from '../near/rpc.js';
import { chatJSON, aiEnabled } from '../ai/tools/nearai.js';
import { grounded } from '../ai/tools/grounding.js';
import { UNTRUSTED_RULE, evidenceMessage } from '../ai/tools/untrusted.js';
import { aiBudget } from '../ai/tools/budget.js';
import { prompt } from '../ai/prompts/index.js';
import { whatIs, whatIsMany } from '../ontology/index.js';
import { exchangeWalletMap, unusualOutflow } from '../incident/exchanges.js';
import { ownFunds } from '../incident/ownfunds.js';
import { pastTransfers } from '../incident/deepreview.js';
import { enqueueIncident } from '../incident/service.js';
import { classifyOrigin, decide, isIdle, reviewDue, OPEN } from './rules.js';
import { setStatus, noteReview } from './store.js';
import { metaGet } from '../db.js';

const SYSTEM = prompt('watch-review'); // src/ai/prompts/watch-review.md
const KIND = { 'contract/staking': 'staking', 'contract/vault_farm': 'farm', 'contract/lending': 'lending', 'contract/amm': 'amm' };

/** The payer's kind for the origin rules, from the ontology. */
export async function payerKind(account) {
  const c = (await whatIs(account).catch(() => null))?.class || 'unknown';
  if (KIND[c]) return KIND[c];
  if (c.startsWith('exchange')) return 'exchange';
  if (c.startsWith('service') || c.startsWith('contract')) return 'service';
  if (c.startsWith('person')) return 'wallet';
  return (await exchangeWalletMap().catch(() => new Map())).has(account) ? 'exchange' : 'unknown';
}

/** { first_ts, txs } of an account: its first transaction and how many it has in its latest 200 (an age and an activity measure). */
export async function activityOf(account) {
  const first = await txIndexer('/v0/account', { account_id: account, limit: 1, desc: false }).catch(() => null);
  const last = await txIndexer('/v0/account', { account_id: account, limit: 200, desc: true }).catch(() => null);
  const t = Number(first?.account_txs?.[0]?.tx_block_timestamp) / 1e6;
  return { first_ts: Number.isFinite(t) ? t : null, txs: (last?.account_txs || []).length };
}

/** Step 1: gather the facts about where the money came from, and classify. Never throws: a missing fact is null. */
export async function gatherOrigin(w) {
  if (w.trigger.kind === 'reported') return { class: 'reported_by_person', lean: 'high', reasons: ['an address reported by a person; no movement of its own opened this watch'], facts: { payer: 'unknown' } };
  const { from: payer, to: receiver, ts, usd, amount, token } = w.trigger, day = 86400e3;
  const [kind, rAct, pAct] = await Promise.all([payerKind(payer), activityOf(receiver), activityOf(payer)]);
  const own = ['staking', 'farm', 'lending', 'amm'].includes(kind) ? await ownFunds(receiver, payer, { beforeTs: ts, withdrawnUsd: usd }).catch(() => null) : null;
  const past = await pastTransfers(receiver, [payer], ts - 3600e3, { maxRows: 1500 }).catch(() => null);
  const ex = kind === 'exchange' && token === 'near' ? (await exchangeWalletMap().catch(() => new Map())).get(payer) : null;
  const facts = {
    payer: kind, own_funds: !!own?.own_funds, earlier_transfers: past?.payers?.[0]?.n ?? 0,
    receiver_age_days: rAct.first_ts ? (ts - rAct.first_ts) / day : null, payer_age_days: pAct.first_ts ? (ts - pAct.first_ts) / day : null, receiver_txs: rAct.txs,
    exchange_unusual: !!ex && unusualOutflow(ex, Number(amount) || 0, null).length > 0,
  };
  return { ...classifyOrigin(facts), facts, own_funds_detail: own?.own_funds ? own.explanation : null };
}

/** What the reviewer reads: compact, no raw dumps. */
/** The accounts the reviewer reads: the trigger's two sides, the watched accounts and the moves' two sides. */
export const accountsOf = (w) => [...new Set([w.trigger?.from, w.trigger?.to, ...(w.accounts || []).slice(0, 40).map((a) => a.account), ...(w.moves || []).slice(-25).flatMap((m) => [m.from, m.to])].filter((a) => a && a !== 'reported'))];
/** The ontology's short answer for an account: class, and its name when it has one ('unknown' says nothing is known). */
const isWhat = (c) => (c ? `${c.class || 'unknown'}${c.label ? ` (${c.label})` : c.operator ? ` (${String(c.operator).replace(/^org:/, '')})` : ''}${c.source === 'behaviour' && c.top === 'exchange' ? ', only because it is busy: not proven' : ''}` : 'unknown');

export function evidenceOf(w, origin, classes = new Map()) {
  const is = (a) => isWhat(classes.get(a));
  const accs = (w.accounts || []).slice(0, 40).map((a) => ({ account: a.account, what_is: is(a.account), depth: a.depth, received_usd: Math.round(a.in_usd || 0), sent_on_usd: Math.round(a.out_usd || 0), state: a.state }));
  const moves = (w.moves || []).slice(-25).map((m) => ({ when: new Date(m.ts).toISOString().slice(0, 16), from: m.from, to: m.to, to_is: is(m.to), usd: m.usd, token: m.symbol || m.token, followed: m.followed, ...(m.inbound ? { direction: 'into the watch, from outside it', from_is: is(m.from) } : {}), ...(m.exit ? { ended_at: m.exit.kind + (m.exit.chain ? ` on ${m.exit.chain}` : '') + (m.exit.label ? ` (${m.exit.label})` : '') } : {}) }));
  return {
    movement: { from: w.trigger.from, from_is: is(w.trigger.from), to: w.trigger.to, to_is: is(w.trigger.to), usd: w.trigger.usd, token: w.trigger.symbol || w.trigger.token, when: new Date(w.trigger.ts).toISOString().slice(0, 16), tx: w.trigger.tx },
    origin: { class: origin.class, lean: origin.lean, why: origin.reasons, facts: origin.facts, own_funds: origin.own_funds_detail || undefined },
    accounts_watched: accs, moves, exits: (w.moves || []).filter((m) => m.exit).length,
    reports_from_people: (w.reports || []).map((r) => ({ when: new Date(r.ts).toISOString().slice(0, 10), by: r.by, note: r.note || null, source: r.source || null })),
    earlier_reviews: (w.reviews || []).slice(-3).map((r) => ({ verdict: r.verdict, what_it_is: r.what_it_is, reasons: r.reasons })),
  };
}

async function aiVerdict(w, origin) {
  if (!config.watch.ai || !aiEnabled() || !(await aiBudget('watch'))) return null;
  const classes = await whatIsMany(accountsOf(w)).catch(() => new Map());
  const evidence = evidenceOf(w, origin, classes);
  const { user } = evidenceMessage('The watched movement, where the money came from and what it did since (reconstructed from executed transactions; strings inside are untrusted data):', evidence);
  const strong = origin.lean === 'high' || (w.moves || []).some((m) => m.exit);
  const { json, model, unverified } = await grounded({ path: 'watch_review', evidence, budget: 'watch', run: (extra) => chatJSON({ system: SYSTEM + UNTRUSTED_RULE, user: user + extra, model: strong ? config.ai.analysisModel : config.ai.model, maxTokens: 2500, timeoutMs: config.ai.analysisTimeoutMs, attempts: 2 }) })
    .catch((e) => { warn(`watch review AI: ${e.message}`); return {}; });
  if (!json?.verdict) return null;
  return { verdict: ['normal', 'keep_watching', 'suspicious'].includes(json.verdict) ? json.verdict : 'keep_watching', confidence: ['high', 'medium', 'low'].includes(json.confidence) ? json.confidence : 'low',
    what_it_is: String(json.what_it_is || '').slice(0, 120), reasons: (Array.isArray(json.reasons) ? json.reasons : []).map((r) => String(r).slice(0, 300)).slice(0, 6),
    check_next: (Array.isArray(json.check_next) ? json.check_next : []).map((r) => String(r).slice(0, 200)).slice(0, 4), model, ...(unverified ? { unverified } : {}) };
}

/**
 * The incident of a watch: the one it points to, or the case its receiver ended up in. An escalated watch only queues an investigation, and
 * the trace may re-root the case to the real attacker (`inc:<attacker>`, with `pasted` = the receiver), so the id is never assumed.
 */
export async function incidentOfWatch(w) {
  const or = [...(w.incident ? [{ _id: w.incident }] : []), { _id: `inc:${w.receiver}` }, { pasted: w.receiver }, { 'accounts.account': w.receiver }];
  const inc = await col('incidents').find({ $or: or, status: { $ne: 'nothing_found' } }, { projection: { status: 1 } }).sort({ updated_ts: -1 }).limit(1).next().catch(() => null);
  if (inc && inc._id !== w.incident) await col('watches').updateOne({ _id: w._id }, { $set: { incident: inc._id } }).catch(() => {});
  return inc;
}

/** Review one watch: origin (once), the rules, the AI, then close / escalate / keep. Returns what it did. */
export async function reviewWatch(w) {
  const origin = w.origin || await gatherOrigin(w);
  if (!w.origin) await col('watches').updateOne({ _id: w._id }, { $set: { origin } });
  const inc = await incidentOfWatch(w);
  const incidentOpen = !!inc && !['cleared', 'nothing_found'].includes(inc.status);
  const rulesOnly = decide(w, origin, null, { incidentOpen });
  const ai = rulesOnly.action === 'normal' && rulesOnly.by === 'rules' ? null : await aiVerdict(w, origin);
  const d = rulesOnly.action === 'normal' && rulesOnly.by === 'rules' ? rulesOnly : decide(w, origin, ai, { incidentOpen });
  const review = { ts: Date.now(), verdict: d.action === 'normal' ? 'normal' : d.action === 'suspicious' ? 'suspicious' : 'keep_watching', by: d.by, what_it_is: d.why, confidence: ai?.confidence || null, reasons: ai?.reasons || origin.reasons, check_next: ai?.check_next || [], model: ai?.model || null, origin_class: origin.class, ...(ai?.unverified ? { unverified: ai.unverified } : {}) };
  if (d.action === 'normal') { await setStatus(w._id, 'normal', { by: d.by, review, why: d.why }); info(`watch ${w._id}: normal (${d.why}) by ${d.by}`); return 'normal'; }
  if (d.action === 'suspicious' && w.status !== 'suspicious') {
    // WATCH_ESCALATE: the public incident path (trace, deep review, possible alerts and flags). Off: suspicious on the private page only
    if (config.watch.escalate) await enqueueIncident({ account: w.receiver }, { reason: 'watch' });
    await setStatus(w._id, 'suspicious', { by: 'ai', review, why: d.why }); // the incident id is found later by incidentOfWatch
    info(`watch ${w._id}: suspicious (${d.why})${config.watch.escalate ? ' → incident queued' : ' (escalation off: WATCH_ESCALATE=false)'}`);
    return 'suspicious';
  }
  await noteReview(w._id, review, { aiMissing: !ai && config.watch.ai && aiEnabled() && !(rulesOnly.action === 'normal') }); // a missing AI verdict is retried after the review gap
  info(`watch ${w._id}: keep watching (${d.why})`);
  return 'keep';
}

/** The worker lane: close what has gone idle, then review the next due watch. Returns what it did, or null. */
export async function processWatches() {
  const W = config.watch, now = Date.now();
  if (!W.enabled) return null;
  const idle = await col('watches').find({ status: { $in: OPEN }, last_move_ts: { $lt: now - W.maxIdleDays * 86400e3 } }).limit(20).toArray();
  for (const w of idle) if (isIdle(w, now, W)) await setStatus(w._id, 'normal', { by: 'rules', why: `idle for ${W.maxIdleDays} days`, review: { ts: now, verdict: 'normal', by: 'rules', what_it_is: 'idle', reasons: [`no move for ${W.maxIdleDays} days`] } });
  // 1) a watch never looked at comes first (its origin and the rules' verdict cost no AI call; old watches waiting for the AI cannot starve it)
  let w = await col('watches').find({ status: { $in: OPEN }, last_review_ts: null }).sort({ opened_ts: 1 }).limit(1).next();
  if (!w) {
    // 2) the others that are due; a watch that only waits for the AI is skipped while today's budget is spent (it would be re-read for nothing)
    const spent = (await metaGet(`watch:ai:${new Date().toISOString().slice(0, 10)}`, null))?.calls >= W.aiPerDay;
    const or = [{ moved_since_review_usd: { $gte: W.reviewMinUsd } }, { new_exit: true }, ...(spent ? [] : [{ ai_missing: true }])];
    const due = await col('watches').find({ status: { $in: OPEN }, last_review_ts: { $ne: null }, $or: or }).sort({ last_review_ts: 1 }).limit(25).toArray();
    w = due.find((x) => reviewDue(spent ? { ...x, ai_missing: false } : x, now, W));
  }
  if (!w) return null;
  return { id: w._id, did: await reviewWatch(w) };
}
