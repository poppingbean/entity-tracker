// Scanner mode: when a launch is old enough, collect features, apply the hard gates, ask the AI analyst, and (if it approves) buy
// it in the simulated wallet. Tokens that scored well are re-reviewed later (follow-up reviews). Everything is stored in `scans`.
import { col } from '../db.js';
import { flagRug } from '../collect/rugs.js';
import { config } from '../config.js';
import { info, warn, error } from '../log.js';
import { syncTokenTrades } from '../collect/trades.js';
import { aiEnabled } from '../ai/nearai.js';
import { collectFeatures } from './features.js';
import { applyRules } from './rules.js';
import { analyse } from './analyst.js';
import { simBuy, simSell, ensureAccount } from '../sim/portfolio.js';

const MIN = 60e3;
const INFRA_CREATOR = /(^|\.)(nearlytrade|justhoot|meme-cooking)\.near$|(^|\.)(ref-labs|ref-finance)\.near$/;
const running = new Set();

/** Creators caught dumping a token the simulated wallet held are refused from then on (launchpad accounts never). */
export async function blacklistCreator(account, info_) {
  if (!account || INFRA_CREATOR.test(account)) return false;
  const r = await col('blacklist').updateOne({ _id: account }, { $setOnInsert: { _id: account, ts: Date.now(), ...info_ } }, { upsert: true });
  if (info_?.token) await flagRug(info_.token, { source: 'tracker', reason: info_.reason, creator: account }).catch(() => {}); // the token the creator dumped is a rug
  return !!r.upsertedCount;
}

const minAgeSeconds = (t) => Math.max(config.scan.observeSeconds, t.launchpad === 'justhoot' ? config.scan.justhootMinAgeSeconds : 0);

/** What to do after the AI answered: buy / skip, and how much. */
export function decide(rules, ai) {
  const A = config.analyst;
  let action = ai ? ai.action : null;
  let why = ai ? `AI ${ai.action} ${ai.confidence.toFixed(2)} [${ai.risk_level}]` : (aiEnabled() ? 'AI review failed' : 'AI off');
  if (!ai) {
    if (A.requireAi) return { buy: false, action: null, why: why + ' → no buy (SIM_REQUIRE_AI)', near: 0 };
    action = 'BUY_MORE'; why += ' → rules alone decide';
  } else {
    if (action === 'BUY_MORE' && ai.confidence < A.minConfidence) { action = 'HOLD'; why += ` (confidence < ${A.minConfidence} → HOLD)`; }
    if (action === 'HOLD' && rules.score >= A.holdBuyMinScore && !(A.holdBuyBlockHighRisk && ai.risk_level === 'high')) { action = 'BUY_MORE'; why += ` → rules score ${rules.score} ≥ ${A.holdBuyMinScore}: buying despite HOLD`; }
  }
  if (action !== 'BUY_MORE') return { buy: false, action, why, near: 0 };
  const high = ai?.risk_level === 'high' || ai?.risk_level === 'extreme';
  const near = high ? Math.min(config.sim.highRiskBuyNear, config.sim.buyNear) : config.sim.buyNear;
  return { buy: true, action, why: why + (high ? ` · risk high → ${near} N` : ''), near, high };
}

async function saveScan(t, kind, minutes, f, rules, ai, decision, trade) {
  const ts = Date.now();
  const id = `${t._id}|${ts}|${kind}`;
  const doc = { _id: id, id, token: t._id, symbol: t.symbol || null, launchpad: t.launchpad, ts, kind, minutes, score: rules.score, pass: rules.pass, failed: rules.failed.map((g) => ({ id: g.id, why: g.why })), features: f,
    ai: ai ? { action: ai.action, confidence: ai.confidence, risk_level: ai.risk_level, quality_score: ai.quality_score, reasons: ai.reasons, red_flags: ai.red_flags, model: ai.model } : null, decision: decision?.why || null, action: decision?.action || null, trade: trade || null };
  await col('scans').replaceOne({ _id: id }, doc, { upsert: true });
  return doc;
}

/** The first check of a launch. */
export async function scanToken(t) {
  const sync = await syncTokenTrades(t, { maxRows: 400 }).catch(() => null);
  const fresh = await col('tokens').findOne({ _id: t._id });
  const f = await collectFeatures(fresh, config.sim.buyNear);
  const rules = applyRules(f);
  let ai = null, decision = { buy: false, action: null, why: 'rules failed' }, trade = null;
  info(`SCAN ${fresh.symbol || ''} ${fresh._id}: rules ${rules.pass ? 'PASS' : 'FAIL'} (score ${rules.score}${rules.failed.length ? '; ' + rules.failed.map((g) => g.id).join(', ') : ''})`);
  if (rules.pass) {
    if (aiEnabled()) { try { ai = await analyse(f, rules, { holding: null }); } catch (e) { warn(`AI analyst failed for ${t._id}: ${e.message}`); } }
    decision = decide(rules, ai);
    info(`ANALYST ${fresh.symbol || ''} ${fresh._id}: ${decision.why} → ${decision.buy ? 'BUY ' + decision.near + ' N' : 'no buy'}`);
    if (decision.buy && config.sim.enabled) {
      const r = await simBuy(fresh, decision.near, { ai, score: rules.score, reason: decision.why, sizeReason: decision.high ? 'AI risk high' : 'standard', scanId: null, origin: 'first_scan' });
      trade = { status: r.status, reason: r.reason || null, position: r.position?._id || null, near: decision.near };
      if (r.status !== 'bought') warn(`SIM BUY ${t._id} not done: ${r.reason}`);
    }
  }
  const scan = await saveScan(fresh, 'first', Math.round((Date.now() - fresh.live_ts) / MIN), f, rules, ai, decision, trade);
  await col('tokens').updateOne({ _id: t._id }, { $set: { scan: { ts: scan.ts, id: scan.id, score: rules.score, pass: rules.pass, decision: decision.why, bought: trade?.status === 'bought', failed: rules.failed.map((g) => g.id) }, scan_done: true } });
  return scan;
}

/** Start the first check of every launch that is old enough (in the background, a few at a time). */
export async function scanTick() {
  if (!config.scan.enabled) return 0;
  const now = Date.now();
  await ensureAccount();
  const cands = await col('tokens').find({ scan_done: { $ne: true }, status: { $nin: ['skipped_quote'] }, live_ts: { $gt: now - 24 * 3600e3 } }).sort({ live_ts: 1 }).limit(40).toArray();
  let started = 0;
  for (const t of cands) {
    const age = (now - t.live_ts) / 1000;
    if (age < minAgeSeconds(t) || running.has(t._id)) continue;
    if (age > config.scan.maxTokenAgeMinutes * 60) { await col('tokens').updateOne({ _id: t._id }, { $set: { scan_done: true, scan: { ts: now, stale: true, decision: 'stale: not checked within the first hour' } } }); continue; }
    if (running.size >= 3) break;
    running.add(t._id); started++;
    scanToken(t).catch(async (e) => { error(`scan ${t._id} failed: ${e.message}`); await col('tokens').updateOne({ _id: t._id }, { $set: { scan_done: true, scan: { ts: Date.now(), error: e.message.slice(0, 200), decision: 'error' } } }).catch(() => {}); }).finally(() => running.delete(t._id));
  }
  return started;
}

// ---------------------------------------------------------------- follow-up reviews
/** Re-review tokens that scored above FOLLOWUP_MIN_SCORE at the first check: 15 / 90 / 180 minutes after the pool opened. */
async function followUp(t, minutes) {
  const F = config.followUp;
  const open = await col('sim_positions').findOne({ token: t._id, status: 'open' });
  const fresh = await col('tokens').findOne({ _id: t._id });
  await syncTokenTrades(fresh, { maxRows: 600 }).catch(() => null);
  const f = await collectFeatures(await col('tokens').findOne({ _id: t._id }), config.sim.buyNear);
  const rules = applyRules(f);
  const done = (await col('scans').find({ token: t._id }).sort({ ts: 1 }).toArray()).map((s) => ({ kind: s.kind, minutes: s.minutes, score: s.score, pass: s.pass, action: s.action }));
  info(`FOLLOW-UP +${minutes}m ${t.symbol || ''} ${t._id}: rules ${rules.pass ? 'PASS' : 'FAIL'} (score ${rules.score})${open ? ' · holding' : ''}`);
  let ai = null, decision = { buy: false, action: null, why: open ? 'holding' : 'rules failed, no AI review' }, trade = null;
  if (!open && !rules.pass) { // a failed review cancels the later checkpoints
    for (const m of F.minutes) if (m > minutes) await col('followups').updateOne({ _id: `${t._id}|${m}` }, { $setOnInsert: { _id: `${t._id}|${m}`, token: t._id, minutes: m, status: 'cancelled', ts: Date.now(), note: `the +${minutes} min review failed` } }, { upsert: true });
  } else if (aiEnabled()) {
    try { ai = await analyse(f, rules, { holding: open ? { costNear: open.cost_near } : null, followUpMinutes: minutes, previous: done }); } catch (e) { warn(`AI follow-up failed for ${t._id}: ${e.message}`); }
    if (open && ai?.action === 'SELL') {
      decision = { action: 'SELL', why: `AI SELL ${ai.confidence.toFixed(2)} [${ai.risk_level}]`, buy: false };
      if (F.canSell) { const r = await simSell(fresh, open, { share: 1, reason: `follow-up +${minutes}m: AI SELL` }); trade = { status: r.status, near: r.near ?? null }; }
      else decision.why += ' (advice only: FOLLOWUP_CAN_SELL=false)';
    } else if (!open && rules.pass) {
      decision = decide(rules, ai);
      if (decision.buy && config.sim.enabled) { const r = await simBuy(fresh, decision.near, { ai, score: rules.score, reason: `follow-up +${minutes}m: ${decision.why}`, origin: `follow_up_${minutes}` }); trade = { status: r.status, reason: r.reason || null, position: r.position?._id || null, near: decision.near }; }
    } else decision = { buy: false, action: ai?.action || null, why: ai ? `AI ${ai.action} ${ai.confidence.toFixed(2)}` : 'no AI answer' };
  }
  const scan = await saveScan(fresh, 'followup', minutes, f, rules, ai, decision, trade);
  await col('followups').replaceOne({ _id: `${t._id}|${minutes}` }, { _id: `${t._id}|${minutes}`, token: t._id, minutes, status: 'done', ts: Date.now(), scan: scan.id, pass: rules.pass, score: rules.score }, { upsert: true });
}

export async function followUpTick() {
  const F = config.followUp;
  if (!F.enabled || !config.scan.enabled || !F.minutes.length) return 0;
  const now = Date.now();
  const cands = await col('tokens').find({ 'scan.score': { $gt: F.minScore }, live_ts: { $gt: now - (F.minutes.at(-1) * 2 + 10) * MIN } }).toArray();
  let started = 0;
  for (const t of cands) {
    const age = (now - t.live_ts) / MIN;
    const marks = await col('followups').find({ token: t._id }).toArray();
    const have = new Set(marks.map((m) => m.minutes));
    const due = F.minutes.filter((m) => age >= m && !have.has(m));
    if (!due.length || running.has(`f|${t._id}`) || running.size >= 3) continue;
    const m = due.at(-1);
    if (F.minutes.indexOf(m) + 1 < F.minutes.length && age >= F.minutes[F.minutes.indexOf(m) + 1]) continue; // let the later checkpoint take it
    for (const x of due.slice(0, -1)) await col('followups').updateOne({ _id: `${t._id}|${x}` }, { $setOnInsert: { _id: `${t._id}|${x}`, token: t._id, minutes: x, status: 'missed', ts: now } }, { upsert: true });
    running.add(`f|${t._id}`); started++;
    followUp(t, m).catch((e) => error(`follow-up ${t._id} failed: ${e.message}`)).finally(() => running.delete(`f|${t._id}`));
  }
  return started;
}

/** The analysis of a token fetched on demand: features, gates and the AI analyst, stored like a scan, never buying. */
export async function analyseOnDemand(tokenId) {
  const t = await col('tokens').findOne({ _id: tokenId });
  if (!t || t.track_only || ['awaiting_pool', 'no_pool', 'skipped_quote'].includes(t.status)) return null;
  const f = await collectFeatures(t, config.sim.buyNear);
  const rules = applyRules(f);
  let ai = null;
  if (aiEnabled()) { try { ai = await analyse(f, rules, { holding: null }); } catch (e) { warn(`AI analyst failed for ${tokenId}: ${e.message}`); } }
  const decision = { buy: false, action: ai?.action || null, why: ai ? `AI ${ai.action} ${ai.confidence.toFixed(2)} [${ai.risk_level}] (fetched on demand, never buys)` : `${rules.pass ? 'gates pass' : 'gates fail'}, ${aiEnabled() ? 'AI review failed' : 'AI off'} (fetched on demand)` };
  const scan = await saveScan(t, 'first', Math.round((Date.now() - t.live_ts) / MIN), f, rules, ai, decision, null);
  await col('scans').updateOne({ _id: scan.id }, { $set: { source: 'on-demand' } });
  await col('tokens').updateOne({ _id: tokenId }, { $set: { scan: { ts: scan.ts, id: scan.id, score: rules.score, pass: rules.pass, decision: decision.why, bought: false, failed: rules.failed.map((g) => g.id) }, scan_done: true } });
  return scan;
}

/** Check any token on demand without buying (CLI `scan <token>`): features, gates and (with a key) the AI analyst. */
export async function scanDry(tokenId, { withAi = true } = {}) {
  const t = await col('tokens').findOne({ _id: tokenId });
  if (!t) throw new Error(`token ${tokenId} is not in the database (run backfill first)`);
  await syncTokenTrades(t, { maxRows: 1000 }).catch(() => null);
  const f = await collectFeatures(await col('tokens').findOne({ _id: tokenId }), config.sim.buyNear);
  const rules = applyRules(f);
  let ai = null;
  if (withAi && aiEnabled() && rules.pass) { try { ai = await analyse(f, rules, { holding: null }); } catch (e) { warn(`AI analyst failed: ${e.message}`); } }
  return { features: f, rules, ai, decision: rules.pass ? decide(rules, ai) : { buy: false, why: 'rules failed' } };
}
