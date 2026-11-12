// Academy track "memecoins": from the scanner's checks of a launch, will the token be real, a rug or a dud? And, for launches no outcome task
// uses: which early buyers work together, and how a rug was pulled. The answers come from what happened after the check and from Safe Near's
// wallet grouping, never from an AI. Only launches at least 7 days old are used.
//   real  the price later reached >= 2x the price at the check, within 7 days: a buyer at the check could double
//   rug   rugged (any kind but "the creator sold some" alone) and never above 1.2x the check price: a buyer at the check could not get out ahead
//   dud   the rest (flat, slow death)
// Levels 1-3 (outcome tasks, from the first check at about minute 2 and from the later check at about minute 15; every account replaced by
// a placeholder so the outcome cannot be looked up): 1 = clear cases (the gates got it right, strong signals); 2 = the gates got it right on
// mixed signals; 3 = hard cases (a rug that passed the gates, or a winner they blocked).
// Level 4 (investigations, real accounts named: reading the chain is the skill): which of the early buyers belong to the same people; how
// a rugged launch was rugged. They use only launches that no hidden outcome task uses, so naming the token gives no exam answer away.
import { col } from '../db.js';
import { priceSeries, priceAt } from '../collect/analyze.js';
import { applyRules } from '../scanner/rules.js';
import { taskId, splitOf, anonymize, balance } from './tasks.js';

const DAY = 86400e3, MIN_AGE_MS = 7 * DAY;
export const CLASSES = { real: 'the price later reached at least 2x the price at this check, within 7 days', rug: 'rugged, and a buyer at this check never got above 1.2x', dud: 'neither: flat or a slow decline' };
export const RUG_KINDS = {
  creator_exit: 'the creator sold most (80%+) of their own early buy within the first hour, and the price went back near launch',
  creator_dump: 'the price fell 70%+ from its peak, fast, while the creator sold',
  price_crash: 'the price collapsed from its peak, fast, without the creator being the seller',
  round_trip: 'it pumped to 3x+ of its launch price, then came all the way back: everyone who bought after launch is flat or under',
};
const OUTCOME_FORMAT = { type: 'class', example: { class: 'rug' }, or_odds: { probs: { real: 0.1, rug: 0.6, dud: 0.3 } }, odds_scoring: '1 - Brier/2: a sure right answer scores 1, a uniform guess 0.67 (under the pass mark of 0.7)' };

/** The class from what happened after the check. Pure. */
export function outcomeClass({ maxUp, rugged, rugKinds = [] }) {
  const hardRug = rugged && !(rugKinds.length === 1 && rugKinds[0] === 'creator_sold');
  return maxUp >= 2 ? 'real' : hardRug && maxUp < 1.2 ? 'rug' : 'dud';
}
/** The rug kind a launch is taught as (the rules give one at most; "flagged" and "the creator sold some" are not a kind). Pure. */
export const rugKindOf = (kinds = []) => kinds.find((k) => RUG_KINDS[k]) || null;

/** The level of a check: how hard it is, from whether the gates got it right and how clear the signals were. Pure. */
export function levelOf(cls, f, gatePass) {
  const pool = f?.pool?.nearReserve ?? 0, buyers = f?.trading?.uniqueBuyers ?? 0, sold = !!f?.trading?.creatorSold;
  const gatesRight = gatePass ? cls === 'real' : cls !== 'real';
  if (!gatesRight && (cls === 'rug' || cls === 'real')) return 3; // the gates were fooled, or missed a winner
  if (!gatesRight) return 2;
  const clear = cls === 'rug' ? sold || pool < 20 : cls === 'real' ? pool >= 100 && buyers >= 10 : pool < 20 && buyers < 5 && !sold;
  return clear ? 1 : 2;
}

// never shown: names, hashes, times, and the symbols of the creator's earlier rugs (they would name the creator)
const HIDDEN = /^(token|name|symbol|codeHash|code_hash|hash|tx|.*_ts|ts|icon|launchpad_url|creator_prior_rug_symbols)$/;
/** What the agent sees: the check-time snapshot, anonymised; names, symbols, code hashes and times removed. Pure. */
export function snapshotOf(f, { token, creator, drop = null } = {}) {
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
    return Object.fromEntries(Object.entries(o).filter(([k]) => !HIDDEN.test(k) && !(drop && drop.test(k))).map(([k, v]) => [k, strip(v)]));
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

/**
 * Which of the listed early buyers are run by the same people as another listed account (the creator included): a buyer whose wallet group
 * (Safe Near's grouping: shared funders, co-buying, money moved between them) holds another listed account, or that the creator funded. Pure.
 */
export function groupedBuyers(buyers, creator, clusterOf, creatorFunded = []) {
  const ids = [...buyers, ...(creator ? [creator] : [])];
  const n = new Map();
  for (const a of ids) { const c = clusterOf.get(a); if (c) n.set(c, (n.get(c) || 0) + 1); }
  const cf = new Set(creatorFunded);
  return buyers.filter((a) => cf.has(a) || (clusterOf.get(a) && n.get(clusterOf.get(a)) >= 2)).sort();
}

/** Every memecoin task from stored checks of launches at least 7 days old. Returns task documents (not stored). */
export async function buildMemecoinTasks({ log = () => {}, now = Date.now() } = {}) {
  const scans = await col('scans').find({ kind: { $in: ['first', 'followup'] }, features: { $type: 'object' }, ts: { $lt: now - MIN_AGE_MS } }, { projection: { token: 1, ts: 1, kind: 1, features: 1 } }).toArray();
  const toks = new Map((await col('tokens').find({ _id: { $in: [...new Set(scans.map((s) => s.token))] } }, { projection: { creator: 1, symbol: 1, 'outcome.rugged': 1, 'outcome.rug_kinds': 1, 'outcome.complete': 1 } }).toArray()).map((t) => [t._id, t]));
  const outcome = [];
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
    const later = s.kind === 'followup', mins = Math.max(1, Math.round((s.features.ageSeconds || 120) / 60));
    const kind = later ? 'outcome_later' : 'outcome';
    const id = taskId('memecoins', kind, `${s.token}|${s.ts}`);
    outcome.push({
      // one split per token: a training answer for one check of a token must not give away a hidden answer for another check of it
      _id: id, track: 'memecoins', level: levelOf(cls, s.features, pass), kind, split: splitOf(`memecoins:token:${s.token}`),
      question: `This is a check of a new memecoin on NEAR, about ${mins} minute${mins === 1 ? '' : 's'} after its pool opened (accounts are replaced by placeholders). Will it be real, a rug or a dud? Answer with one class, or with your odds for each.`,
      input: { snapshot: snapshotOf(s.features, { token: s.token, creator: t.creator }) },
      answer_format: OUTCOME_FORMAT, options: CLASSES,
      gold: { class: cls }, rationale: rationaleOf(cls, { maxUp, rugKinds, f: s.features }), label_source: 'outcome: prices after the check (stored trades) and the rug rules',
      refs: { token: s.token, check_ts: s.ts }, meta: { max_up: r2(maxUp), gate_pass: pass, minutes: mins },
    });
  };
  for (let i = 0; i < scans.length; i += 12) await Promise.all(scans.slice(i, i + 12).map(one));
  // rugs and duds far outnumber winners: no class may be more than half a level, or one constant answer would pass it
  const kept = balance(outcome, (t) => t.gold.class);
  // investigations name the token, so they only use launches no hidden outcome task uses (a test outcome task stays unknowable)
  const hiddenTokens = new Set(kept.filter((t) => t.split === 'test').map((t) => t.refs.token));
  const firsts = scans.filter((s) => s.kind === 'first' && !hiddenTokens.has(s.token) && toks.get(s.token)?.outcome?.complete);
  const inv = [];
  // how a rug was pulled
  for (const s of firsts) {
    const t = toks.get(s.token), k = t.outcome.rugged ? rugKindOf(t.outcome.rug_kinds) : null;
    if (!k) continue;
    const id = taskId('memecoins', 'rug_kind', s.token);
    inv.push({
      _id: id, track: 'memecoins', level: 4, kind: 'rug_kind', split: splitOf(id),
      question: `The memecoin ${s.token} was rugged. Read its trades and its creator's moves on chain: how was it rugged?`,
      input: { token: s.token, creator: t.creator || null, launched_at: new Date(s.ts - (s.features.ageSeconds || 120) * 1000).toISOString() },
      answer_format: { type: 'class', example: { class: 'creator_exit' } }, options: RUG_KINDS,
      gold: { class: k }, rationale: `${RUG_KINDS[k][0].toUpperCase()}${RUG_KINDS[k].slice(1)}.`, label_source: 'outcome: the rug rules on the stored trades (prices and the creator\'s sells)',
      refs: { token: s.token },
    });
  }
  // which early buyers work together
  const buyersOf = (s) => (s.features.wallets?.topBuyers || []).map((b) => b.account).filter((a) => a && a !== toks.get(s.token)?.creator);
  const accts = [...new Set(firsts.flatMap((s) => [...buyersOf(s), toks.get(s.token)?.creator].filter(Boolean)))];
  const clusterOf = new Map();
  for (let i = 0; i < accts.length; i += 2000) for (const w of await col('wallets').find({ _id: { $in: accts.slice(i, i + 2000) }, cluster_id: { $exists: true, $ne: null } }, { projection: { cluster_id: 1 } }).toArray()) clusterOf.set(w._id, w.cluster_id);
  for (const s of firsts) {
    const buyers = buyersOf(s), t = toks.get(s.token);
    if (buyers.length < 3) continue;
    const gold = groupedBuyers(buyers, t.creator, clusterOf, s.features.wallets?.creatorFundedBuyers || []);
    const id = taskId('memecoins', 'wallet_groups', s.token);
    inv.push({
      _id: id, track: 'memecoins', level: 4, kind: 'wallet_groups', split: splitOf(id),
      question: `These accounts were the biggest buyers of the memecoin ${s.token} in its first minutes. Which of them are run by the same people as another account in this list or as the creator (shared funders, money moved between them, buying together)? List them (an empty list if none).`,
      input: { token: s.token, creator: t.creator || null, early_buyers: s.features.wallets.topBuyers.filter((b) => buyers.includes(b.account)).map((b) => ({ account: b.account, bought_near: b.near })) },
      answer_format: { type: 'set', example: { set: ['a.near', 'b.near'] } },
      gold: { set: gold }, rationale: gold.length ? `${gold.join(', ')} ${gold.length > 1 ? 'belong' : 'belongs'} to the same wallet groups as another listed account or the creator (Safe Near's grouping: shared funders, transfers between them, buying together), or the creator funded ${gold.length > 1 ? 'them' : 'it'}.` : 'No two of them (or the creator) are in the same wallet group, and the creator funded none of them.',
      label_source: 'Safe Near wallet grouping (funding chains, transfers, co-buying) and the creator\'s funding',
      refs: { token: s.token },
    });
  }
  const keptInv = balance(inv, (t) => (t.kind === 'rug_kind' ? t.gold.class : t.gold.set.length ? t._id : 'none'));
  const all = [...kept, ...keptInv];
  const by = all.reduce((m, t) => ((m[t.kind] = (m[t.kind] || 0) + 1), m), {});
  log(`memecoin tasks: ${all.length} from ${scans.length} checks (${outcome.length - kept.length + inv.length - keptInv.length} dropped to keep levels balanced) ${JSON.stringify(by)}`);
  return all;
}
