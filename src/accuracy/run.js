// Measured accuracy: every judgment the tracker makes early (gates, rule score, audit risk, AI analyst, group verdicts) scored against
// what happened later. Ground truth for a launch is what a buyer at the moment of the check saw 24 h later (bad = the price fell below
// config.accuracy.badBelow of it; the 24 h return itself is reported too, which needs no threshold), unless
// someone labelled it by hand (ground_truth, e.g. from a report or reviewed feedback). Results are kept in meta "accuracy".
import { col, metaSet } from '../db.js';
import { config } from '../config.js';
import { info } from '../log.js';
import { priceSeries, priceAt } from '../collect/analyze.js';
import { applyRules } from '../scanner/rules.js';
import { outcomeLabel, confusion, auc, calibration, gateLift, returnSplit } from './score.js';

const DAY = 86400e3;
const SCORE_EDGES = [0, 40, 55, 70, 85, 101];
const RISK_ORDER = { low: 0, medium: 1, high: 2, extreme: 3 };
const AI_WARNS = new Set(['SELL', 'SKIP']); // the AI said stay out; BUY / BUY_MORE / HOLD let it through

/** Every first check with its ground truth. Checks imported from the old scanner are marked: their recorded gate decisions used older thresholds,
 *  so they count for the AI and for replays on the current gates, not for the recorded gate / score numbers. */
export async function checkDataset() {
  const checks = await col('scans').find({ kind: 'first' }, { projection: { token: 1, ts: 1, pass: 1, score: 1, failed: 1, features: 1, ai: 1, source: 1 } }).toArray();
  const toks = new Map((await col('tokens').find({ _id: { $in: checks.map((c) => c.token) } }, { projection: { live_ts: 1, 'outcome.rugged': 1, 'outcome.complete': 1 } }).toArray()).map((t) => [t._id, t]));
  const manual = new Map((await col('ground_truth').find({ kind: 'token' }).toArray()).map((g) => [g.id, g.label]));
  const rows = [];
  const judge = async (c) => {
    const t = toks.get(c.token);
    if (!t?.outcome?.complete && !manual.has(c.token)) return; // too young to judge
    const trades = await col('trades').find({ token: c.token, ts: { $lte: c.ts + DAY + 3600e3 } }, { projection: { ts: 1, near: 1, tokens: 1 } }).sort({ ts: 1 }).toArray();
    const s = priceSeries(trades);
    const truth = outcomeLabel({ priceAtCheck: priceAt(s, c.ts), price24h: priceAt(s, c.ts + DAY), rugged: !!t?.outcome?.rugged, manual: manual.get(c.token), badBelow: config.accuracy.badBelow });
    if (!truth.label) return;
    rows.push({ token: c.token, ts: c.ts, imported: c.source === 'scanner', pass: !!c.pass, score: c.score ?? null, failed: new Set((c.failed || []).map((g) => g.id ?? g)), features: c.features || null, ai: c.ai || null,
      bad: truth.label === 'bad', ret: truth.ret ?? null, rugged: !!t?.outcome?.rugged, truth_source: truth.source });
  };
  for (let i = 0; i < checks.length; i += 16) await Promise.all(checks.slice(i, i + 16).map(judge));
  return rows.sort((a, b) => a.ts - b.ts);
}

/** Replay the gates on the stored features with some thresholds changed (config.rules keys). Returns rows with the replayed decision. */
export function replayGates(rows, overrides = {}) {
  const saved = { ...config.rules };
  Object.assign(config.rules, overrides);
  // features stored by older versions may lack a block the gates read today: those checks can't be replayed
  const one = (x) => { try { const r = applyRules(x.features); return { ...x, replay_pass: r.pass, replay_failed: new Set(r.failed.map((g) => g.id)) }; } catch { return null; } };
  try { return rows.filter((x) => x.features).map(one).filter(Boolean); }
  finally { Object.assign(config.rules, saved); }
}

/** Group verdicts out of time: each early buy scored with the verdict its group had BEFORE the buy (cluster_history), against the buy's 24 h ROI. */
async function groupVerdicts() {
  const hist = await col('cluster_history').find({}, { projection: { cluster_id: 1, ts: 1, verdict: 1 } }).sort({ ts: 1 }).toArray();
  const byGroup = new Map(); for (const h of hist) (byGroup.get(h.cluster_id) || byGroup.set(h.cluster_id, []).get(h.cluster_id)).push(h);
  const wallets = await col('wallets').find({ cluster_id: { $in: [...byGroup.keys()] } }, { projection: { cluster_id: 1 } }).toArray();
  const groupOf = new Map(wallets.map((w) => [w._id, w.cluster_id]));
  const entries = await col('entries').find({ wallet: { $in: [...groupOf.keys()] }, 'roi.1440': { $exists: true } }, { projection: { wallet: 1, first_buy_ts: 1, roi: 1 } }).toArray();
  const rows = [];
  for (const e of entries) {
    const h = byGroup.get(groupOf.get(e.wallet)) || [];
    let v = null; for (const x of h) { if (x.ts < e.first_buy_ts) v = x.verdict; else break; }
    if (!v) continue; // the group had no verdict yet when it bought
    rows.push({ verdict: v, bad: 1 + e.roi['1440'] < config.accuracy.badBelow, roi: e.roi['1440'] });
  }
  const per = ['good', 'neutral', 'bad', 'unknown'].map((v) => { const xs = rows.filter((x) => x.verdict === v); const s = xs.map((x) => x.roi).sort((a, b) => a - b);
    return { verdict: v, entries: xs.length, bad_rate: xs.length ? +(xs.filter((x) => x.bad).length / xs.length).toFixed(3) : null, median_roi: s.length ? +s[s.length >> 1].toFixed(3) : null }; });
  // hand labels (reports, accepted feedback) against the group's verdict today
  const labels = await col('ground_truth').find({ kind: 'group' }).toArray();
  const now = new Map((await col('clusters').find({ _id: { $in: labels.map((g) => g.id) } }, { projection: { verdict: 1 } }).toArray()).map((c) => [c._id, c.verdict]));
  const manual = confusion(labels.filter((g) => now.has(g.id)).map((g) => ({ flagged: now.get(g.id) === 'bad', bad: g.label === 'bad' })));
  return { entries: rows.length, per_verdict: per, manual, bad_verdict: confusion(rows.filter((x) => x.verdict !== 'unknown').map((x) => ({ flagged: x.verdict === 'bad', bad: x.bad }))) };
}

/** Everything, stored in meta "accuracy". */
export async function evaluateAccuracy() {
  const t0 = Date.now();
  const all = await checkDataset(), rows = all.filter((x) => !x.imported);
  const gateIds = [...new Set(rows.flatMap((x) => [...x.failed]))].sort();
  const ai = all.filter((x) => x.ai?.action);
  const out = {
    ts: Date.now(), checks: rows.length, imported_checks: all.length - rows.length, base_rate: rows.length ? +(rows.filter((x) => x.bad).length / rows.length).toFixed(3) : null,
    truth: { manual: rows.filter((x) => x.truth_source === 'manual').length, by_price: rows.filter((x) => x.truth_source !== 'manual').length, label: `bad = a buyer at the check held under ${Math.round(config.accuracy.badBelow * 100)} % of the price 24 h later`, bad_below: config.accuracy.badBelow },
    gates: { ...confusion(rows.map((x) => ({ flagged: !x.pass, bad: x.bad }))), returns: returnSplit(rows.map((x) => ({ flagged: !x.pass, ret: x.ret }))) },
    gates_vs_rug_flag: confusion(rows.map((x) => ({ flagged: !x.pass, bad: x.rugged }))),
    per_gate: gateLift(rows, gateIds),
    rule_score: { auc: auc(all.map((x) => ({ risk: x.score == null ? null : -x.score, bad: x.bad }))), calibration: calibration(all.map((x) => ({ value: x.score, bad: x.bad })), SCORE_EDGES) },
    audit_risk: { auc: auc(all.map((x) => ({ risk: x.features?.audit?.available ? x.features.audit.risk_score : null, bad: x.bad }))), audited: all.filter((x) => x.features?.audit?.available).length },
    ai: { checks: ai.length, warn_vs_outcome: confusion(ai.map((x) => ({ flagged: AI_WARNS.has(x.ai.action), bad: x.bad }))), returns: returnSplit(ai.map((x) => ({ flagged: AI_WARNS.has(x.ai.action), ret: x.ret }))),
      actions: ai.reduce((m, x) => ({ ...m, [x.ai.action]: (m[x.ai.action] || 0) + 1 }), {}), risk_auc: auc(ai.map((x) => ({ risk: RISK_ORDER[x.ai.risk_level] ?? null, bad: x.bad }))),
      note: 'Few verdicts, mostly from the old scanner: read as a first sign, not a measurement' },
    replay_current_gates: (() => { const xs = replayGates(all); return { ...confusion(xs.map((x) => ({ flagged: !x.replay_pass, bad: x.bad }))), returns: returnSplit(xs.map((x) => ({ flagged: !x.replay_pass, ret: x.ret }))), note: 'the current gates replayed on every stored check, imported ones included' }; })(),
    groups: await groupVerdicts(),
    feedback_pending: await col('feedback').countDocuments({ status: 'pending' }),
  };
  out.took_ms = Date.now() - t0;
  await metaSet('accuracy', out);
  info(`ACCURACY ${out.checks} checks · gates precision ${out.gates.precision} recall ${out.gates.recall} · rule score AUC ${out.rule_score.auc} · group bad-verdict precision ${out.groups.bad_verdict.precision}`);
  return out;
}

/** Backtest: the gates as they are vs with `overrides`, on the same stored checks. */
export async function backtest(overrides) {
  const rows = await checkDataset();
  const base = replayGates(rows, {}), alt = replayGates(rows, overrides);
  const m = (xs) => ({ ...confusion(xs.map((x) => ({ flagged: !x.replay_pass, bad: x.bad }))), returns: returnSplit(xs.map((x) => ({ flagged: !x.replay_pass, ret: x.ret }))) });
  return { checks: base.length, overrides, current: m(base), changed: m(alt), passed: { current: base.filter((x) => x.replay_pass).length, changed: alt.filter((x) => x.replay_pass).length } };
}
