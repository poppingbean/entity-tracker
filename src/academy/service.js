// Safe Near Academy: storage and the agent's side (next task, submit, progress, the training set, the leaderboard). Collections:
//   academy_tasks     the tasks (with their answers, which no agent sees before answering); rebuilt nightly from the audits and the checks
//   academy_attempts  one per agent and task (_id "<agent>|<task>": the first answer counts)
//   academy_agents    an agent's level per track
// The MCP server (academy/mcp.js) and the CLI call these. Nothing here reads production data while an agent waits: tasks are prebuilt.
import { col } from '../db.js';
import { info } from '../log.js';
import { TRACKS, publicTask, revealed, scoreAnswer, nextLevel, PASS } from './tasks.js';

const AGENT = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const maxLevel = (track) => Math.max(...Object.keys(TRACKS[track].levels).map(Number));
function checkAgent(agent) { const a = String(agent || '').trim(); if (!AGENT.test(a)) throw new Error('agent: a name for your agent, 2-64 letters, digits, dots, dashes or underscores (e.g. my-auditor.near)'); return a.toLowerCase(); }
function checkTrack(track) { if (!TRACKS[track]) throw new Error(`track: one of ${Object.keys(TRACKS).join(', ')}`); return track; }

/** Build every task and store it (a task keeps its id across rebuilds: ids come from what the task is about). `dry`: count only. */
export async function buildAcademy({ dry = false, log = info } = {}) {
  const [{ buildMemecoinTasks }, { buildContractTasks }] = await Promise.all([import('./memecoin.js'), import('./contracts.js')]);
  const tasks = [...await buildContractTasks({ log }), ...await buildMemecoinTasks({ log })];
  const version = Date.now(), counts = {};
  for (const t of tasks) { const k = `${t.track}|${t.level}|${t.split}`; counts[k] = (counts[k] || 0) + 1; }
  if (!dry && tasks.length) {
    for (let i = 0; i < tasks.length; i += 500) await col('academy_tasks').bulkWrite(tasks.slice(i, i + 500).map((t) => ({ replaceOne: { filter: { _id: t._id }, replacement: { ...t, version, built_ts: version }, upsert: true } })), { ordered: false });
    // a task no longer built (its contract's audit changed type, a check left the window) leaves the pool; attempts on it stay
    await col('academy_tasks').deleteMany({ version: { $ne: version } });
  }
  return { tasks: tasks.length, counts, version, dry };
}

/** The tracks, their levels and how many tasks each has (train / test). */
export async function tracks() {
  const rows = await col('academy_tasks').aggregate([{ $group: { _id: { track: '$track', level: '$level', split: '$split' }, n: { $sum: 1 } } }]).toArray();
  const n = (t, l, s) => rows.find((r) => r._id.track === t && r._id.level === l && r._id.split === s)?.n || 0;
  return Object.entries(TRACKS).map(([id, T]) => ({ track: id, title: T.title, for: T.for, levels: Object.entries(T.levels).map(([l, q]) => ({ level: Number(l), asks: q, train_tasks: n(id, Number(l), 'train'), test_tasks: n(id, Number(l), 'test') })) }));
}

async function agentDoc(agent) {
  await col('academy_agents').updateOne({ _id: agent }, { $setOnInsert: { _id: agent, levels: Object.fromEntries(Object.keys(TRACKS).map((t) => [t, 1])), created_ts: Date.now() } }, { upsert: true });
  return col('academy_agents').findOne({ _id: agent });
}

/**
 * The next task for an agent: at its level (or a lower level it asks for), one it has not answered. `mode`: 'train' (the answer is shown
 * after answering) or 'exam' (hidden test tasks: only the score is shown, so the exam measures what the agent learnt, not what it memorised).
 */
export async function nextTask(agentRaw, trackRaw, { level = null, mode = 'train' } = {}) {
  const agent = checkAgent(agentRaw), track = checkTrack(trackRaw), a = await agentDoc(agent);
  const lv = Math.min(Number(level) || a.levels[track] || 1, a.levels[track] || 1);
  const done = (await col('academy_attempts').find({ agent, track }, { projection: { task: 1 } }).toArray()).map((x) => x.task);
  const [t] = await col('academy_tasks').aggregate([{ $match: { track, level: lv, split: mode === 'exam' ? 'test' : 'train', _id: { $nin: done } } }, { $sample: { size: 1 } }]).toArray();
  if (!t) return { agent, track, level: lv, mode, task: null, note: `no unanswered ${mode === 'exam' ? 'test' : 'training'} task left at level ${lv}` };
  return { agent, track, level: lv, mode, task: publicTask(t) };
}

/** Score an answer. A training task shows the right answer and why; a test task only the score. The first answer to a task counts. */
export async function submit(agentRaw, taskIdRaw, answer) {
  const agent = checkAgent(agentRaw), t = await col('academy_tasks').findOne({ _id: String(taskIdRaw || '') });
  if (!t) throw new Error('no such task (task ids come from academy_next_task)');
  const prev = await col('academy_attempts').findOne({ _id: `${agent}|${t._id}` });
  if (prev) return { task: t._id, score: prev.score, passed: prev.score >= PASS, note: 'already answered: the first answer counts', ...(t.split === 'train' ? { reveal: revealed(t) } : {}) };
  const s = scoreAnswer(t, answer);
  await col('academy_attempts').insertOne({ _id: `${agent}|${t._id}`, agent, task: t._id, track: t.track, level: t.level, split: t.split, score: s.score, ts: Date.now() });
  const a = await agentDoc(agent), cur = a.levels[t.track] || 1;
  const atLevel = await col('academy_attempts').find({ agent, track: t.track, level: cur }, { projection: { score: 1 } }).toArray();
  const lv = nextLevel(cur, atLevel, maxLevel(t.track));
  if (lv !== cur) await col('academy_agents').updateOne({ _id: agent }, { $set: { [`levels.${t.track}`]: lv } });
  return { task: t._id, score: s.score, passed: s.score >= PASS, detail: s, level: lv, leveled_up: lv > cur, ...(t.split === 'train' ? { reveal: revealed(t) } : { note: 'a test task: the answer is not shown' }) };
}

/** An agent's levels, pass rates per level, and its exam score (test tasks) per track. */
export async function progress(agentRaw) {
  const agent = checkAgent(agentRaw), a = await agentDoc(agent);
  const rows = await col('academy_attempts').aggregate([{ $match: { agent } }, { $group: { _id: { track: '$track', level: '$level', split: '$split' }, n: { $sum: 1 }, passed: { $sum: { $cond: [{ $gte: ['$score', PASS] }, 1, 0] } }, mean: { $avg: '$score' } } }]).toArray();
  return { agent, tracks: Object.keys(TRACKS).map((track) => {
    const mine = rows.filter((r) => r._id.track === track), test = mine.filter((r) => r._id.split === 'test');
    const tn = test.reduce((s, r) => s + r.n, 0);
    return { track, level: a.levels[track] || 1, by_level: mine.filter((r) => r._id.split === 'train').map((r) => ({ level: r._id.level, answered: r.n, pass_rate: Math.round((r.passed / r.n) * 100) / 100 })).sort((x, y) => x.level - y.level),
      exam: tn ? { answered: tn, score: Math.round((test.reduce((s, r) => s + r.mean * r.n, 0) / tn) * 1000) / 1000 } : null };
  }) };
}

/** The training set: training tasks with their answers and why (JSON lines for fine-tuning or as worked examples). Test tasks never leave. */
export async function dataset(trackRaw, { level = null, limit = 100, offset = 0 } = {}) {
  const track = checkTrack(trackRaw);
  const rows = await col('academy_tasks').find({ track, split: 'train', ...(level ? { level: Number(level) } : {}) }).sort({ level: 1, _id: 1 }).skip(Math.max(0, offset)).limit(Math.min(500, Math.max(1, limit))).toArray();
  return { track, count: rows.length, items: rows.map((t) => ({ ...publicTask(t), answer: t.gold, why: t.rationale, label_source: t.label_source })) };
}

/** Agents ranked by their exam score on a track (at least `min` test tasks answered). */
export async function leaderboard(trackRaw, { min = 10, limit = 20 } = {}) {
  const track = checkTrack(trackRaw);
  const rows = await col('academy_attempts').aggregate([{ $match: { track, split: 'test' } }, { $group: { _id: '$agent', n: { $sum: 1 }, score: { $avg: '$score' } } }, { $match: { n: { $gte: min } } }, { $sort: { score: -1, n: -1 } }, { $limit: limit }]).toArray();
  const lv = new Map((await col('academy_agents').find({ _id: { $in: rows.map((r) => r._id) } }, { projection: { levels: 1 } }).toArray()).map((a) => [a._id, a.levels?.[track] || 1]));
  return { track, min_test_tasks: min, agents: rows.map((r, i) => ({ rank: i + 1, agent: r._id, exam_score: Math.round(r.score * 1000) / 1000, test_tasks: r.n, level: lv.get(r._id) })) };
}
