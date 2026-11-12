// Safe Near Academy: graded tasks with known answers, for training and testing other AI agents (docs/academy-design.md).
// An agent asks for a task, answers it, is scored, then sees the right answer and why. It levels up as it passes; its own runtime keeps the
// solved tasks to retrain or as worked examples. Pure: the task format, the train / test split, the scorers, what an agent may see.
import { createHash } from 'node:crypto';

/** The tracks and their levels (what each level asks). */
export const TRACKS = {
  contracts: {
    title: 'Contract security',
    for: 'agents that audit or attack NEAR smart contracts',
    levels: {
      1: 'What kind of contract is this and which NEAR standards does it implement? Is its code a launchpad template, a copy or its own?',
      2: 'Which methods can send NEAR, deploy code, change keys or delete the account? Which call other contracts? Who controls the contract?',
      3: 'Which of those powerful methods never check who is calling?',
      4: 'Which methods give someone power over users (move funds, freeze, mint, upgrade, take fees)?',
      5: 'Upgrades: the contract replaced its code. Which methods were added or removed, and which powers did it gain?',
    },
  },
  memecoins: {
    title: 'Memecoins at minute 2',
    for: 'trading and scam-detection agents',
    levels: {
      1: 'Clear cases: from a check of a new token, will it be real, a rug or a dud?',
      2: 'Mixed signals: the same question when the signals disagree',
      3: "Hard cases: rugs that passed Safe Near's gates and winners that failed them",
      4: 'Investigations: which early buyers work together, and how a rug was pulled',
    },
  },
};

/** A task id's split: about one in five is a hidden test task (no answer is ever shown for it). Stable for a key. */
export const splitOf = (key) => (parseInt(createHash('sha1').update(String(key)).digest('hex').slice(0, 8), 16) % 5 === 0 ? 'test' : 'train');
export const taskId = (track, kind, ref) => `${track}:${kind}:${createHash('sha1').update(String(ref)).digest('hex').slice(0, 16)}`;

/** What an agent sees before answering: never the answer, the rationale or the source references that would give it away. */
export function publicTask(t, stats = null) {
  return { id: t._id, track: t.track, level: t.level, kind: t.kind, question: t.question, input: t.input, answer_format: t.answer_format, ...(t.options ? { options: t.options } : {}), split: t.split,
    ...(stats?.answered ? { solved_by: { agents: stats.answered, pass_rate: Math.round((stats.passed / stats.answered) * 100) / 100 } } : {}) };
}
/** What an agent sees after answering a training task: the answer and why (a test task shows only the score). */
export function revealed(t) {
  return { answer: t.gold, why: t.rationale, label_source: t.label_source, refs: t.refs || null };
}

const norm = (x) => String(x ?? '').trim().toLowerCase();
const asSet = (x) => new Set((Array.isArray(x) ? x : String(x ?? '').split(/[,\s]+/)).map(norm).filter(Boolean));
const r3 = (x) => Math.round(x * 1000) / 1000;
/** Precision, recall and F1 of a set answer against the right set (both empty = a perfect answer). */
export function setScore(answer, gold) {
  const a = asSet(answer), g = asSet(gold);
  if (!a.size && !g.size) return { score: 1, precision: 1, recall: 1 };
  const hit = [...a].filter((x) => g.has(x)).length;
  const precision = a.size ? hit / a.size : 0, recall = g.size ? hit / g.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { score: r3(f1), precision: r3(precision), recall: r3(recall), missed: [...g].filter((x) => !a.has(x)), extra: [...a].filter((x) => !g.has(x)) };
}

/** Odds over the labels, scored 1 - Brier / 2: sure and right = 1, sure and wrong = 0, a uniform guess over 3 labels = 0.67 (under the pass mark). */
export function brier(probs, gold, labels) {
  const p = Object.fromEntries(Object.entries(probs || {}).map(([k, v]) => [norm(k), Number(v)]));
  if (Object.values(p).some((v) => !Number.isFinite(v) || v < 0)) throw new Error('probs: numbers from 0 to 1');
  const sum = Object.values(p).reduce((s, v) => s + v, 0);
  if (!(sum > 0)) throw new Error('probs: at least one label above 0');
  const b = labels.reduce((s, l) => s + ((p[norm(l)] || 0) / sum - (norm(l) === norm(gold) ? 1 : 0)) ** 2, 0);
  return { score: r3(1 - b / 2), brier: r3(b) };
}

/**
 * Score an answer (0..1) by the task's answer format. Deterministic: no AI grades another AI here.
 *   class            one label from `options`, or odds { probs: { label: p, … } } scored by Brier (above)
 *   set              a list (methods, standards): F1 against the right list
 *   class+set        { class, set }: half each (a contract's type and its standards)
 *   sets             { <part>: [ … ], … }: the mean F1 over the task's parts (an upgrade's added and removed methods, added powers)
 */
export function scoreAnswer(t, answer) {
  const fmt = t.answer_format?.type;
  if (fmt === 'class') {
    if (answer && typeof answer === 'object' && answer.probs) {
      const labels = t.options && !Array.isArray(t.options) ? Object.keys(t.options) : Array.isArray(t.options) ? t.options : [t.gold.class];
      return { ...brier(answer.probs, t.gold.class, labels), given: 'probs' };
    }
    const a = norm(typeof answer === 'object' && answer ? answer.class ?? answer.answer : answer);
    return { score: a === norm(t.gold.class) ? 1 : 0, given: a };
  }
  if (fmt === 'set') return setScore(typeof answer === 'object' && !Array.isArray(answer) && answer ? answer.set ?? answer.methods ?? answer.answer : answer, t.gold.set);
  if (fmt === 'class+set') {
    const c = norm(answer?.class) === norm(t.gold.class) ? 1 : 0, s = setScore(answer?.set ?? answer?.standards, t.gold.set);
    return { score: r3((c + s.score) / 2), class_ok: !!c, set: s };
  }
  if (fmt === 'sets') {
    const parts = t.answer_format.parts || Object.keys(t.gold);
    const by = Object.fromEntries(parts.map((k) => [k, setScore(answer?.[k], t.gold[k])]));
    return { score: r3(parts.reduce((s, k) => s + by[k].score, 0) / parts.length), parts: by };
  }
  throw new Error(`unknown answer format ${fmt}`);
}

/** Passing an answer: 0.7 or more. Levelling up: at least `need` scored answers at a level, with a pass rate of `rate` or more. */
export const PASS = 0.7;
export const LEVEL_UP = { need: 10, rate: 0.7 };
export function nextLevel(current, attemptsAtLevel, maxLevel) {
  const n = attemptsAtLevel.length, passed = attemptsAtLevel.filter((a) => a.score >= PASS).length;
  return n >= LEVEL_UP.need && passed / n >= LEVEL_UP.rate && current < maxLevel ? current + 1 : current;
}

/**
 * Replace account names in a memecoin snapshot with stable placeholders (TOKEN, CREATOR, W1, W2 …) so the outcome cannot be looked up on chain.
 * Hex ids, named accounts and sub-accounts are all replaced; numbers, labels and kinds stay. Pure.
 */
// infrastructure every launch touches: named, never masked (it says how the token trades, not who it is)
export const INFRA = new Set(['wrap.near', 'v2.ref-finance.near', 'dclv2.ref-labs.near', 'intents.near', 'aggregatedex.near', 'dex.intear.near', 'near', 'system']);
export function anonymize(obj, { token = null, creator = null, keep = INFRA } = {}) {
  const map = new Map([...keep].map((k) => [k, k]));
  if (token) map.set(token, 'TOKEN');
  if (creator) map.set(creator, 'CREATOR');
  let n = 0;
  const ACCOUNT = /^([0-9a-f]{64}|([a-z0-9_-]+\.)+(near|tg)|0x[0-9a-f]{40})$/;
  const name = (s) => { if (!map.has(s)) map.set(s, `W${++n}`); return map.get(s); };
  const walk = (v) => {
    if (typeof v === 'string') return ACCOUNT.test(v) ? name(v) : v.replace(/\b([0-9a-f]{64}|([a-z0-9_-]+\.)+(near|tg))\b/g, (m) => name(m));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj);
}

/**
 * Keep a level honest: no single answer may be more than `maxShare` of a kind of task at a level, or an agent that always gives that answer
 * would pass. The extra tasks of the majority answer are dropped by a stable hash of their id (the same tasks every rebuild). Pure.
 */
export function balance(tasks, answerKey, { maxShare = 0.5 } = {}) {
  const h = (id) => createHash('sha1').update(`keep|${id}`).digest('hex');
  const out = [];
  const levels = new Map();
  for (const t of tasks) { const k = `${t.track}|${t.kind}|${t.level}`; if (!levels.has(k)) levels.set(k, []); levels.get(k).push(t); }
  for (const xs of levels.values()) {
    const groups = new Map();
    for (const t of xs) { const a = answerKey(t); if (!groups.has(a)) groups.set(a, []); groups.get(a).push(t); }
    const sizes = [...groups.values()].map((g) => g.length).sort((a, b) => b - a);
    const rest = sizes.slice(1).reduce((s, n) => s + n, 0);
    // the largest group may be at most maxShare of the level: n / (n + rest) <= maxShare
    const cap = groups.size < 2 ? Infinity : Math.max(1, Math.floor((maxShare * rest) / (1 - maxShare)));
    for (const g of groups.values()) out.push(...(g.length > cap ? g.slice().sort((a, b) => (h(a._id) < h(b._id) ? -1 : 1)).slice(0, cap) : g));
  }
  return out;
}

/** The fixed exam of a track: the same test tasks for every agent (up to `perLevel` per level, chosen by a stable hash). Pure. */
export function examSet(testTasks, perLevel = 10) {
  const h = (id) => createHash('sha1').update(`exam|${id}`).digest('hex');
  const by = new Map();
  for (const t of testTasks) { if (!by.has(t.level)) by.set(t.level, []); by.get(t.level).push(t); }
  return [...by.keys()].sort((a, b) => a - b).flatMap((l) => by.get(l).slice().sort((a, b) => (h(a._id) < h(b._id) ? -1 : 1)).slice(0, perLevel));
}
