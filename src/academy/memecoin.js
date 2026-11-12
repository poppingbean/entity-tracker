// Academy track "memecoins": from the scanner's first check of a launch (its check-time features), will the token be real, a rug or a dud?
// The answer comes from what happened after the check, never from an AI. Only launches at least 7 days old are used, every account is
// replaced by a placeholder (the outcome cannot be looked up on chain), and gate thresholds are never part of a task.
//   real  the price later reached >= 2x the price at the check, within 7 days: a buyer at the check could double
//   rug   rugged (any kind but "the creator sold some" alone) and never above 1.2x the check price: a buyer at the check could not get out ahead
//   dud   the rest (flat, slow death)
// Levels: 1 = clear cases (Safe Near's gates got it right, with strong signals); 2 = the gates got it right on mixed signals;
// 3 = hard cases (a rug that passed the gates, or a winner they blocked).
import { col } from '../db.js';
import { priceSeries, priceAt } from '../collect/analyze.js';
import { applyRules } from '../scanner/rules.js';
import { taskId, splitOf, anonymize, balance } from './tasks.js';

const DAY = 86400e3, MIN_AGE_MS = 7 * DAY;
export const CLASSES = { real: 'the price later reached at least 2x the price at this check, within 7 days', rug: 'rugged, and a buyer at this check never got above 1.2x', dud: 'neither: flat or a slow decline' };

/** The class from what happened after the check. Pure. */
export function outcomeClass({ maxUp, rugged, rugKinds = [] }) {
  const hardRug = rugged && !(rugKinds.length === 1 && rugKinds[0] === 'creator_sold');
  return maxUp >= 2 ? 'real' : hardRug && maxUp < 1.2 ? 'rug' : 'dud';
}

/** The level of a check: how hard it is, from whether the gates got it right and how clear the signals were. Pure. */
export function levelOf(cls, f, gatePass) {
  const pool = f?.pool?.nearReserve ?? 0, buyers = f?.trading?.uniqueBuyers ?? 0, sold = !!f?.trading?.creatorSold;
  const gatesRight = gatePass ? cls === 'real' : cls !== 'real';
  if (!gatesRight && (cls === 'rug' || cls === 'real')) return 3; // the gates were fooled, or missed a winner
  if (!gatesRight) return 2;
  const clear = cls === 'rug' ? sold || pool < 20 : cls === 'real' ? pool >= 100 && buyers >= 10 : pool < 20 && buyers < 5 && !sold;
  return clear ? 1 : 2;
}

/** What the agent sees: the check-time snapshot, anonymised; names, symbols, code hashes and times removed. Pure. */
export function snapshotOf(f, { token, creator } = {}) {
  // the token's name and symbol also turn up inside free text (an audit headline: "MALLACE is a token ..."): replaced there too
  const names = new Set();
  const collect = (o) => { if (Array.isArray(o)) o.forEach(collect); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (/^(name|symbol)$/.test(k) && typeof v === 'string' && v.trim().length >= 3 && !/^w?near$/i.test(v.trim())) names.add(v.trim()); else collect(v); } };
  collect(f);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const NAME = names.size ? new RegExp(`(?<![A-Za-z0-9])\\$?(${[...names].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
  const unname = (o) => (typeof o === 'string' ? (NAME ? o.replace(NAME, 'TOKEN') : o) : Array.isArray(o) ? o.map(unname) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, unname(v)])) : o);
  const strip = (o) => {
    if (Array.isArray(o)) return o.map(strip);
    if (!o || typeof o !== 'object') return o;
    return Object.fromEntries(Object.entries(o).filter(([k]) => !/^(token|name|symbol|codeHash|code_hash|hash|tx|.*_ts|ts|icon|launchpad_url)$/.test(k)).map(([k, v]) => [k, strip(v)]));
  };
  return unname(anonymize(strip(f), { token, creator }));
}

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
/** The explanation shown after an answer. Pure. */
export function rationaleOf(cls, { maxUp, rugKinds = [], f }) {
  const t = f?.trading || {}, p = f?.pool || {};
  const signals = `At the check: pool ${r2(p.nearReserve)} NEAR, ${t.uniqueBuyers ?? '?'} buyers, top-3 buyers ${t.top3BuyerShare != null ? Math.round(t.top3BuyerShare * 100) + '%' : '?'} of the buying, the creator ${t.creatorSold ? 'had already sold' : 'had not sold'}, price ${r2(t.priceMultipleSinceFirstTrade)}x the first trade.`;
  const what = cls === 'real' ? `It was real: the price later reached ${r2(maxUp)}x the price at the check within 7 days.`
    : cls === 'rug' ? `It was a rug (${rugKinds.join(', ') || 'rugged'}): a buyer at the check never got above ${r2(maxUp)}x.`
      : `It was a dud: the best a buyer at the check could get was ${r2(maxUp)}x, and it did not rug outright.`;
  return `${what} ${signals}`;
}

/** Every memecoin task from stored first checks of launches at least 7 days old. Returns task documents (not stored). */
export async function buildMemecoinTasks({ log = () => {}, now = Date.now() } = {}) {
  const scans = await col('scans').find({ kind: 'first', features: { $exists: true }, ts: { $lt: now - MIN_AGE_MS } }, { projection: { token: 1, ts: 1, features: 1 } }).toArray();
  const toks = new Map((await col('tokens').find({ _id: { $in: scans.map((s) => s.token) } }, { projection: { creator: 1, 'outcome.rugged': 1, 'outcome.rug_kinds': 1, 'outcome.complete': 1 } }).toArray()).map((t) => [t._id, t]));
  const out = [];
  const one = async (s) => {
    const t = toks.get(s.token);
    if (!t?.outcome?.complete) return;
    const trades = await col('trades').find({ token: s.token, ts: { $lte: s.ts + 7 * DAY } }, { projection: { ts: 1, near: 1, tokens: 1 } }).sort({ ts: 1 }).toArray();
    const series = priceSeries(trades), p0 = priceAt(series, s.ts);
    if (!(p0 > 0)) return;
    const after = series.filter((x) => x.ts > s.ts).map((x) => x.price);
    const maxUp = after.length ? Math.max(...after) / p0 : 1;
    const rugKinds = t.outcome.rug_kinds || [];
    const cls = outcomeClass({ maxUp, rugged: !!t.outcome.rugged, rugKinds });
    let pass = false; try { pass = applyRules(s.features).pass; } catch { return; }
    const level = levelOf(cls, s.features, pass);
    const id = taskId('memecoins', 'outcome', `${s.token}|${s.ts}`);
    out.push({
      _id: id, track: 'memecoins', level, kind: 'outcome', split: splitOf(id),
      question: 'This is the first check of a new memecoin on NEAR, about 2 minutes after its pool opened (accounts are replaced by placeholders). Will it be real, a rug or a dud? Answer with one class.',
      input: { snapshot: snapshotOf(s.features, { token: s.token, creator: t.creator }) },
      answer_format: { type: 'class', example: { class: 'rug' } }, options: CLASSES,
      gold: { class: cls }, rationale: rationaleOf(cls, { maxUp, rugKinds, f: s.features }), label_source: 'outcome: prices after the check (stored trades) and the rug rules',
      refs: { token: s.token, check_ts: s.ts }, meta: { max_up: r2(maxUp), gate_pass: pass },
    });
  };
  for (let i = 0; i < scans.length; i += 12) await Promise.all(scans.slice(i, i + 12).map(one));
  // rugs and duds far outnumber winners: no class may be more than half a level, or one constant answer would pass it
  const kept = balance(out, (t) => t.gold.class);
  log(`memecoin tasks: ${kept.length} from ${scans.length} checks (${out.length - kept.length} dropped to keep levels balanced)`);
  return kept;
}
