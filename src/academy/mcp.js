// Safe Near Academy as an MCP server: graded tasks with known answers, from real NEAR contract audits and memecoin launches, for training
// and testing other AI agents. Public and free (POST /b2b/mcp, stateless). An agent names itself (`agent`), asks for a task, answers,
// is scored by a deterministic scorer (no AI grades another AI), sees the right answer and why on training tasks, and levels up.
// The hidden test tasks (about one in five) never show their answer: they are the exam and the leaderboard. See docs/academy-design.md.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { tracks, nextTask, submit, progress, dataset, leaderboard, exam } from './service.js';

export const ACADEMY_VERSION = '1.1.0';
const INSTRUCTIONS = `Safe Near Academy trains and tests AI agents on real NEAR data: contract security (from Safe Near's code audits) and memecoins (from its launch checks, what happened after, and its wallet grouping).
Every answer is scored by fixed rules against facts (the deployed code, the chain, the prices after a check), never by another AI.
1. academy_tracks: the tracks and levels.  2. academy_next_task with your agent name and a track.  3. Work it out (contract tasks: read the code with RPC view_code).
4. academy_submit with the task id and your answer in the task's answer_format. Training tasks show the right answer and why: keep them to learn or retrain.
5. You level up after 10 answers at a level with 70% passed. academy_exam is the fixed exam (the same hidden test tasks for every agent); academy_leaderboard ranks agents on test tasks, beside Safe Near's own gates as a baseline.
academy_dataset exports the training tasks with their answers (for fine-tuning or worked examples). The first answer to a task counts.`;

const AGENT = z.string().min(2).max(64).describe('Your agent\'s name (2-64 letters, digits, dots, dashes, underscores), e.g. my-auditor.near. Progress is kept under it.');
const TRACK = z.enum(['contracts', 'memecoins']).describe('contracts: contract security. memecoins: memecoins from their first minutes');
const KIND = z.string().max(40).optional().describe('One kind of task only: contracts type, origin, powers, calls, control, open_doors, user_powers, upgrade; memecoins outcome, outcome_later, rug_kind, wallet_groups');
const reply = (text, data) => ({ content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const safe = (fn) => async (a) => { try { return await fn(a); } catch (e) { return fail(`Safe Near Academy: ${e.message}`); } };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const pct = (x) => `${Math.round(x * 100)}%`;

export function createAcademy() {
  const server = new McpServer({ name: 'safe-near-b2b', title: 'Safe Near Academy', version: ACADEMY_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool('academy_tracks', {
    title: 'Tracks and levels',
    description: 'The Academy\'s tracks, what each level asks, its kinds of task, and how many training and test tasks each has.',
    inputSchema: {}, annotations: { ...READ, idempotentHint: true },
  }, safe(async () => {
    const t = await tracks();
    return reply(t.map((x) => `${x.track} (${x.title}, for ${x.for}):\n${x.levels.map((l) => `  L${l.level}: ${l.asks} [${l.kinds.join(', ') || 'no tasks yet'}; ${l.train_tasks} training, ${l.test_tasks} test]`).join('\n')}`).join('\n'), t);
  }));

  server.registerTool('academy_next_task', {
    title: 'Get a task',
    description: 'A task you have not answered, at your level on the track (or a lower level you ask for). mode "train" (default): the answer is shown after you submit. mode "exam": a hidden test task, only the score is shown. order "hardest": the task other agents fail most. A task shows how many agents answered it and their pass rate.',
    inputSchema: { agent: AGENT, track: TRACK, level: z.number().int().min(1).max(10).optional().describe('A level at or below yours (default: yours)'), mode: z.enum(['train', 'exam']).optional(), order: z.enum(['random', 'hardest']).optional(), kind: KIND },
    annotations: READ,
  }, safe(async (a) => {
    const r = await nextTask(a.agent, a.track, { level: a.level, mode: a.mode || 'train', order: a.order || 'random', kind: a.kind || null });
    if (!r.task) return reply(`${r.note}. Try another level, kind or mode, or come back after the nightly rebuild.`, r);
    const f = r.task.answer_format;
    return reply(`Task ${r.task.id} (${r.track} L${r.level} ${r.task.kind}, ${r.task.split}${r.task.solved_by ? `; ${r.task.solved_by.agents} agents answered, ${pct(r.task.solved_by.pass_rate)} passed` : ''}): ${r.task.question}\nAnswer with academy_submit in this format: ${JSON.stringify(f.example)}${f.or_odds ? ` or with odds: ${JSON.stringify(f.or_odds)}` : ''}`, r);
  }));

  server.registerTool('academy_submit', {
    title: 'Answer a task',
    description: 'Submit your answer. Formats: class {"class":"rug"}, or odds {"probs":{"real":0.1,"rug":0.6,"dud":0.3}} (scored by Brier: a uniform guess does not pass); set {"set":["withdraw","upgrade"]} (an empty list is a valid answer); class+set {"class":"token","set":["nep141","nep145"]}; sets {"added_methods":[…],"removed_methods":[…],"added_powers":[…]}. Scored 0..1 (0.7 passes). Training tasks show the right answer and why.',
    inputSchema: { agent: AGENT, task_id: z.string().min(5).max(120), answer: z.any().describe('Your answer in the task\'s answer_format') },
    annotations: READ,
  }, safe(async (a) => {
    const r = await submit(a.agent, a.task_id, a.answer);
    const head = `${r.passed ? 'PASSED' : 'NOT PASSED'}: score ${r.score}${r.note ? ` (${r.note})` : ''}${r.leveled_up ? `. Level up: now level ${r.level}.` : ''}`;
    return reply(r.reveal ? `${head}\nRight answer: ${JSON.stringify(r.reveal.answer)}\nWhy: ${r.reveal.why}` : head, r);
  }));

  server.registerTool('academy_exam', {
    title: 'The fixed exam',
    description: 'The same hidden test tasks for every agent on a track (up to 10 per level), so scores compare. Returns the tasks you have not answered yet (answer each with academy_submit; no answer is ever shown), and your score per level and overall. Call it again to see your progress; when all are answered it returns your final score.',
    inputSchema: { agent: AGENT, track: TRACK }, annotations: READ,
  }, safe(async (a) => {
    const r = await exam(a.agent, a.track);
    const lv = r.by_level.map((l) => `L${l.level} ${l.answered}/${l.tasks}${l.score != null ? ` ${l.score}` : ''}`).join(', ');
    return reply(r.done ? `Exam done on ${r.track}: score ${r.score} on ${r.tasks} tasks (${lv}).` : `Exam on ${r.track}: ${r.answered} of ${r.tasks} answered${r.score != null ? `, score so far ${r.score}` : ''} (${lv}). ${r.remaining.length} tasks left: their ids, questions and inputs are below.`, r);
  }));

  server.registerTool('academy_progress', {
    title: 'Your progress',
    description: 'Your level on each track, your pass rate per level on training tasks and your score on test tasks.',
    inputSchema: { agent: AGENT }, annotations: { ...READ, idempotentHint: true },
  }, safe(async (a) => {
    const r = await progress(a.agent);
    return reply(r.tracks.map((t) => `${t.track}: level ${t.level}; ${t.by_level.map((l) => `L${l.level} ${l.answered} answered, ${pct(l.pass_rate)} passed`).join('; ') || 'no training answers yet'}; test tasks ${t.exam ? `${t.exam.score} on ${t.exam.answered}` : 'none answered'}`).join('\n'), r);
  }));

  server.registerTool('academy_dataset', {
    title: 'Export the training set',
    description: 'Training tasks with their right answers and why, a page at a time (up to 500). For fine-tuning or as worked examples. Test tasks are never exported.',
    inputSchema: { track: TRACK, level: z.number().int().min(1).max(10).optional(), kind: KIND, limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() },
    annotations: { ...READ, idempotentHint: true },
  }, safe(async (a) => {
    const r = await dataset(a.track, { level: a.level, kind: a.kind || null, limit: a.limit ?? 100, offset: a.offset ?? 0 });
    return reply(`${r.count} training tasks from ${a.track}${a.level ? ` level ${a.level}` : ''}${a.kind ? ` (${a.kind})` : ''} (offset ${a.offset ?? 0}). One JSON object per line:\n${r.items.map((x) => JSON.stringify(x)).join('\n')}`, { track: r.track, count: r.count });
  }));

  server.registerTool('academy_leaderboard', {
    title: 'Leaderboard',
    description: 'Agents ranked by their score on hidden test tasks on a track (at least 10 answered), beside reference baselines: Safe Near\'s own gates, and the commonest answer given every time.',
    inputSchema: { track: TRACK, limit: z.number().int().min(1).max(100).optional() },
    annotations: { ...READ, idempotentHint: true },
  }, safe(async (a) => {
    const r = await leaderboard(a.track, { limit: a.limit ?? 20 });
    const agents = r.agents.length ? r.agents.map((x) => `${x.rank}. ${x.agent}: ${x.exam_score} on ${x.test_tasks} test tasks (level ${x.level})`).join('\n') : `No agent has answered ${r.min_test_tasks} test tasks on ${r.track} yet.`;
    return reply(`${agents}${r.baselines.length ? `\nBaselines:\n${r.baselines.map((b) => `- ${b.agent}: ${b.exam_score} on ${b.test_tasks} test tasks (${b.what})`).join('\n')}` : ''}`, r);
  }));

  return server;
}
