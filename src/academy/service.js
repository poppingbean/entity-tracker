// Safe Near Academy: storage and the agent's side (next task, submit, progress, the exam, the training set, the leaderboard). Collections:
//   academy_tasks     the tasks (with their answers, which no agent sees before answering); rebuilt nightly from the audits and the checks
//   academy_attempts  one per agent and task (_id "<agent>|<task>": the first answer counts)
//   academy_agents    an agent's level per track
//   academy_stats     per task: how many agents answered it and how many passed (its difficulty, measured; kept across rebuilds)
// The MCP server (academy/mcp.js) and the CLI call these. Nothing here reads production data while an agent waits: tasks are prebuilt.
import { col, metaGet, metaSet } from '../db.js';
import { info } from '../log.js';
import { TRACKS, publicTask, revealed, scoreAnswer, nextLevel, examSet, PASS } from './tasks.js';

const AGENT = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const EXAM_PER_LEVEL = 10;
const maxLevel = (track) => Math.max(...Object.keys(TRACKS[track].levels).map(Number));
// the baselines' names on the leaderboard: no agent may take them
export const RESERVED = new Set(['safe-near-gates', 'always-the-commonest-answer']);
export function checkAgent(agent) {
  const a = String(agent || '').trim();
  if (!AGENT.test(a)) throw new Error('agent: a name for your agent, 2-64 letters, digits, dots, dashes or underscores (e.g. my-auditor.near)');
  if (RESERVED.has(a.toLowerCase())) throw new Error(`agent: "${a}" is a baseline's name on the leaderboard; choose another`);
  return a.toLowerCase();
}
function checkTrack(track) { if (!TRACKS[track]) throw new Error(`track: one of ${Object.keys(TRACKS).join(', ')}`); return track; }
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Reference scores on the hidden test tasks, shown beside the agents on the leaderboard. memecoins: Safe Near's own gates (pass = "real",
 * blocked = "rug") and the commonest answer every time; contracts: the commonest answer every time (the audit itself is the answer key).
 */
export function baselines(tasks) {
  const out = {};
  for (const track of Object.keys(TRACKS)) {
    const test = tasks.filter((t) => t.track === track && t.split === 'test');
    if (!test.length) continue;
    const rows = [];
    const outcome = test.filter((t) => t.kind === 'outcome' || t.kind === 'outcome_later');
    // the gates say "buy" or "don't", not "rug": passed is taken as real, blocked as even odds of rug and dud
    const gates = (t) => (t.meta?.gate_pass ? { probs: { real: 1 } } : { probs: { rug: 0.5, dud: 0.5 } });
    if (outcome.length) rows.push({ agent: 'safe-near-gates', what: 'Safe Near\'s gates as odds: passed = real, blocked = half rug, half dud (outcome tasks only)', tasks: outcome.length, exam_score: r3(outcome.reduce((s, t) => s + scoreAnswer(t, gates(t)).score, 0) / outcome.length) });
    // the commonest answer of each kind of task, given every time
    const common = new Map();
    for (const t of test) { const k = `${t.kind}`, a = JSON.stringify(t.gold); const m = common.get(k) || new Map(); m.set(a, (m.get(a) || 0) + 1); common.set(k, m); }
    const pick = (k) => JSON.parse([...common.get(k).entries()].sort((a, b) => b[1] - a[1])[0][0]);
    rows.push({ agent: 'always-the-commonest-answer', what: 'the most frequent right answer of each kind of task, every time', tasks: test.length, exam_score: r3(test.reduce((s, t) => s + scoreAnswer(t, pick(t.kind)).score, 0) / test.length) });
    out[track] = rows;
  }
  return out;
}

/** Build every task and store it (a task keeps its id across rebuilds: ids come from what the task is about). `dry`: count only. */
export async function buildAcademy({ dry = false, log = info } = {}) {
  const [{ buildMemecoinTasks }, { buildContractTasks }] = await Promise.all([import('./memecoin.js'), import('./contracts.js')]);
  const tasks = [...await buildContractTasks({ log }), ...await buildMemecoinTasks({ log })];
  const version = Date.now(), counts = {};
  for (const t of tasks) { const k = `${t.track}|${t.level}|${t.split}`; counts[k] = (counts[k] || 0) + 1; }
  const base = baselines(tasks);
  if (!dry && tasks.length) {
    for (let i = 0; i < tasks.length; i += 500) await col('academy_tasks').bulkWrite(tasks.slice(i, i + 500).map((t) => ({ replaceOne: { filter: { _id: t._id }, replacement: { ...t, version, built_ts: version }, upsert: true } })), { ordered: false });
    // a task no longer built (its contract's audit changed type, a check left the window) leaves the pool; attempts on it stay
    await col('academy_tasks').deleteMany({ version: { $ne: version } });
    await metaSet('academy_baselines', base);
  }
  return { tasks: tasks.length, counts, baselines: base, version, dry };
}

/** The tracks, their levels and how many tasks each has (train / test). */
export async function tracks() {
  const rows = await col('academy_tasks').aggregate([{ $group: { _id: { track: '$track', level: '$level', split: '$split' }, n: { $sum: 1 }, kinds: { $addToSet: '$kind' } } }]).toArray();
  const g = (t, l, s) => rows.find((r) => r._id.track === t && r._id.level === l && r._id.split === s);
  return Object.entries(TRACKS).map(([id, T]) => ({ track: id, title: T.title, for: T.for, levels: Object.entries(T.levels).map(([l, q]) => ({ level: Number(l), asks: q, kinds: [...new Set([...(g(id, Number(l), 'train')?.kinds || []), ...(g(id, Number(l), 'test')?.kinds || [])])].sort(), train_tasks: g(id, Number(l), 'train')?.n || 0, test_tasks: g(id, Number(l), 'test')?.n || 0 })) }));
}

async function agentDoc(agent) {
  await col('academy_agents').updateOne({ _id: agent }, { $setOnInsert: { _id: agent, levels: Object.fromEntries(Object.keys(TRACKS).map((t) => [t, 1])), created_ts: Date.now() } }, { upsert: true });
  const a = await col('academy_agents').findOne({ _id: agent });
  for (const t of Object.keys(TRACKS)) a.levels[t] ||= 1; // a track added after the agent started
  return a;
}
const statsOf = async (ids) => new Map((await col('academy_stats').find({ _id: { $in: ids } }).toArray()).map((s) => [s._id, s]));

/**
 * The next task for an agent: at its level (or a lower level it asks for), one it has not answered. `mode`: 'train' (the answer is shown
 * after answering) or 'exam' (hidden test tasks: only the score is shown). `order`: 'random' (default) or 'hardest' (the lowest pass rate
 * among tasks at least 3 agents answered; random when none has). `kind`: one kind of task only (e.g. upgrade, wallet_groups).
 */
export async function nextTask(agentRaw, trackRaw, { level = null, mode = 'train', order = 'random', kind = null } = {}) {
  const agent = checkAgent(agentRaw), track = checkTrack(trackRaw), a = await agentDoc(agent);
  // the free tier caps training tasks a day when the Academy sells passes (the exam is always free)
  if (mode !== 'exam') { const gate = await (await import('./business.js')).trainingGate(agent); if (gate) throw new Error(gate); }
  // a kind asked for without a level: the highest level at or below the agent's that has that kind
  const allKindLevels = kind && !level ? await col('academy_tasks').distinct('level', { track, kind: String(kind) }) : [];
  const kindLevels = allKindLevels.filter((l) => l <= a.levels[track]);
  if (kind && !level && allKindLevels.length && !kindLevels.length) return { agent, track, level: a.levels[track], mode, task: null, note: `${kind} tasks start at level ${Math.min(...allKindLevels)}; you are at level ${a.levels[track]}` };
  const lv = kindLevels.length ? Math.max(...kindLevels) : Math.min(Number(level) || a.levels[track], a.levels[track]);
  const done = (await col('academy_attempts').find({ agent, track }, { projection: { task: 1 } }).toArray()).map((x) => x.task);
  const match = { track, level: lv, split: mode === 'exam' ? 'test' : 'train', _id: { $nin: done }, ...(kind ? { kind: String(kind) } : {}) };
  let t = null;
  if (order === 'hardest') {
    const ids = (await col('academy_tasks').find(match, { projection: { _id: 1 } }).toArray()).map((x) => x._id);
    const hard = [...(await statsOf(ids)).values()].filter((s) => s.answered >= 3).sort((x, y) => x.passed / x.answered - y.passed / y.answered)[0];
    if (hard) t = await col('academy_tasks').findOne({ _id: hard._id });
  }
  if (!t) [t] = await col('academy_tasks').aggregate([{ $match: match }, { $sample: { size: 1 } }]).toArray();
  if (!t) return { agent, track, level: lv, mode, task: null, note: `no unanswered ${mode === 'exam' ? 'test' : 'training'} task${kind ? ` of kind ${kind}` : ''} left at level ${lv}` };
  return { agent, track, level: lv, mode, task: publicTask(t, (await statsOf([t._id])).get(t._id)) };
}

/** Score an answer. A training task shows the right answer and why; a test task only the score. The first answer to a task counts. */
export async function submit(agentRaw, taskIdRaw, answer) {
  const agent = checkAgent(agentRaw), t = await col('academy_tasks').findOne({ _id: String(taskIdRaw || '') });
  if (!t) throw new Error('no such task (task ids come from academy_next_task or academy_exam)');
  const prev = await col('academy_attempts').findOne({ _id: `${agent}|${t._id}` });
  if (prev) return { task: t._id, score: prev.score, passed: prev.score >= PASS, note: 'already answered: the first answer counts', ...(t.split === 'train' ? { reveal: revealed(t) } : {}) };
  const s = scoreAnswer(t, answer);
  try {
    await col('academy_attempts').insertOne({ _id: `${agent}|${t._id}`, agent, task: t._id, track: t.track, level: t.level, kind: t.kind, split: t.split, score: s.score, ts: Date.now() });
  } catch (e) { if (e?.code === 11000) return submit(agent, t._id, answer); throw e; } // the same answer sent twice at once: the first counts
  await col('academy_stats').updateOne({ _id: t._id }, { $inc: { answered: 1, passed: s.score >= PASS ? 1 : 0 } }, { upsert: true });
  const a = await agentDoc(agent), cur = a.levels[t.track];
  const atLevel = await col('academy_attempts').find({ agent, track: t.track, level: cur }, { projection: { score: 1 } }).toArray();
  const lv = nextLevel(cur, atLevel, maxLevel(t.track));
  if (lv !== cur) await col('academy_agents').updateOne({ _id: agent }, { $set: { [`levels.${t.track}`]: lv } });
  return { task: t._id, score: s.score, passed: s.score >= PASS, detail: s, level: lv, leveled_up: lv > cur, ...(t.split === 'train' ? { reveal: revealed(t) } : { note: 'a test task: the answer is not shown' }) };
}

/**
 * The fixed exam of a track: the same hidden test tasks for every agent (up to 10 per level), so scores compare. Returns the tasks not yet
 * answered (answer them with submit) and, once all are answered, the final score per level and overall.
 */
export async function exam(agentRaw, trackRaw) {
  const agent = checkAgent(agentRaw), track = checkTrack(trackRaw);
  const set = examSet(await col('academy_tasks').find({ track, split: 'test' }).toArray(), EXAM_PER_LEVEL);
  const mine = new Map((await col('academy_attempts').find({ _id: { $in: set.map((t) => `${agent}|${t._id}`) } }, { projection: { task: 1, score: 1 } }).toArray()).map((x) => [x.task, x.score]));
  const answered = set.filter((t) => mine.has(t._id));
  const byLevel = [...new Set(set.map((t) => t.level))].map((l) => { const xs = answered.filter((t) => t.level === l); return { level: l, tasks: set.filter((t) => t.level === l).length, answered: xs.length, score: xs.length ? r3(xs.reduce((s, t) => s + mine.get(t._id), 0) / xs.length) : null }; });
  const done = answered.length === set.length;
  return { agent, track, tasks: set.length, answered: answered.length, done, score: answered.length ? r3(answered.reduce((s, t) => s + mine.get(t._id), 0) / answered.length) : null, by_level: byLevel,
    ...(done ? {} : { remaining: set.filter((t) => !mine.has(t._id)).map((t) => publicTask(t)) }) };
}

/** An agent's levels, pass rates per level, and its exam score (test tasks) per track. */
export async function progress(agentRaw) {
  const agent = checkAgent(agentRaw), a = await agentDoc(agent);
  const rows = await col('academy_attempts').aggregate([{ $match: { agent } }, { $group: { _id: { track: '$track', level: '$level', split: '$split' }, n: { $sum: 1 }, passed: { $sum: { $cond: [{ $gte: ['$score', PASS] }, 1, 0] } }, mean: { $avg: '$score' } } }]).toArray();
  return { agent, tracks: Object.keys(TRACKS).map((track) => {
    const mine = rows.filter((r) => r._id.track === track), test = mine.filter((r) => r._id.split === 'test');
    const tn = test.reduce((s, r) => s + r.n, 0);
    return { track, level: a.levels[track], by_level: mine.filter((r) => r._id.split === 'train').map((r) => ({ level: r._id.level, answered: r.n, pass_rate: Math.round((r.passed / r.n) * 100) / 100 })).sort((x, y) => x.level - y.level),
      exam: tn ? { answered: tn, score: r3(test.reduce((s, r) => s + r.mean * r.n, 0) / tn) } : null };
  }) };
}

/** The training set: training tasks with their answers and why (JSON lines for fine-tuning or as worked examples). Test tasks never leave. */
export async function dataset(trackRaw, { level = null, kind = null, limit = 100, offset = 0, agent = null } = {}) {
  const track = checkTrack(trackRaw);
  // the free tier: so many rows a day per agent when the Academy sells passes
  const B = await import('./business.js');
  const want = Math.min(500, Math.max(1, limit));
  limit = await B.datasetAllowance(agent ? checkAgent(agent) : null, want);
  if (limit <= 0) throw new Error(`the free tier's dataset rows for today are used. A dataset pass (academy_buy, product dataset_pass, $${B.rules().prices_usd.dataset_pass}) lifts the cap for ${B.rules().pass_days} days.`);
  const rows = await col('academy_tasks').find({ track, split: 'train', ...(level ? { level: Number(level) } : {}), ...(kind ? { kind: String(kind) } : {}) }).sort({ level: 1, _id: 1 }).skip(Math.max(0, offset)).limit(Math.min(500, Math.max(1, limit))).toArray();
  return { track, count: rows.length, items: rows.map((t) => ({ ...publicTask(t), answer: t.gold, why: t.rationale, label_source: t.label_source })) };
}

/** Agents ranked by their exam score on a track (at least `min` test tasks answered), with the reference baselines beside them. */
export async function leaderboard(trackRaw, { min = 10, limit = 20 } = {}) {
  const track = checkTrack(trackRaw);
  const rows = await col('academy_attempts').aggregate([{ $match: { track, split: 'test' } }, { $group: { _id: '$agent', n: { $sum: 1 }, score: { $avg: '$score' } } }, { $match: { n: { $gte: min } } }, { $sort: { score: -1, n: -1 } }, { $limit: limit }]).toArray();
  const lv = new Map((await col('academy_agents').find({ _id: { $in: rows.map((r) => r._id) } }, { projection: { levels: 1 } }).toArray()).map((a) => [a._id, a.levels?.[track] || 1]));
  const base = (await metaGet('academy_baselines', {}))?.[track] || [];
  return { track, min_test_tasks: min, agents: rows.map((r, i) => ({ rank: i + 1, agent: r._id, exam_score: r3(r.score), test_tasks: r.n, level: lv.get(r._id) })),
    baselines: base.map((b) => ({ agent: b.agent, what: b.what, exam_score: b.exam_score, test_tasks: b.tasks })) };
}
