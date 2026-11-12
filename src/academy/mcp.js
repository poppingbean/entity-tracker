// Safe Near Academy as an MCP server: graded tasks with known answers, from real NEAR contract audits and memecoin launches, for training
// and testing other AI agents. Public and free (POST /b2b/mcp, stateless). An agent names itself (`agent`), asks for a task, answers,
// is scored by a deterministic scorer (no AI grades another AI), sees the right answer and why on training tasks, and levels up.
// The hidden test tasks (about one in five) never show their answer: they are the exam and the leaderboard. See docs/academy-design.md.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { tracks, nextTask, submit, progress, dataset, leaderboard } from './service.js';

export const ACADEMY_VERSION = '1.0.0';
const INSTRUCTIONS = `Safe Near Academy trains and tests AI agents on real NEAR data: contract security (from Safe Near's code audits) and memecoins at minute 2 (from its launch checks and what happened after).
Every answer is scored by fixed rules against facts (the deployed code, the prices after a check), never by another AI.
1. academy_tracks: the tracks and levels.  2. academy_next_task with your agent name and a track.  3. Work it out (contract tasks: read the code with RPC view_code).
4. academy_submit with the task id and your answer in the task's answer_format. Training tasks show the right answer and why: keep them to learn or retrain.
5. You level up after 10 answers at a level with 70% passed. mode "exam" serves hidden test tasks (score only): academy_leaderboard ranks agents on them.
academy_dataset exports the training tasks with their answers (for fine-tuning or worked examples). The first answer to a task counts.`;

const AGENT = z.string().min(2).max(64).describe('Your agent\'s name (2-64 letters, digits, dots, dashes, underscores), e.g. my-auditor.near. Progress is kept under it.');
const TRACK = z.enum(['contracts', 'memecoins']).describe('contracts: contract security. memecoins: memecoins at minute 2');
const reply = (text, data) => ({ content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const safe = (fn) => async (a) => { try { return await fn(a); } catch (e) { return fail(`Safe Near Academy: ${e.message}`); } };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function createAcademy() {
  const server = new McpServer({ name: 'safe-near-b2b', title: 'Safe Near Academy', version: ACADEMY_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool('academy_tracks', {
    title: 'Tracks and levels',
    description: 'The Academy\'s tracks, what each level asks and how many training and test tasks each has.',
    inputSchema: {}, annotations: { ...READ, idempotentHint: true },
  }, safe(async () => {
    const t = await tracks();
    return reply(t.map((x) => `${x.track} (${x.title}, for ${x.for}):\n${x.levels.map((l) => `  L${l.level}: ${l.asks} [${l.train_tasks} training, ${l.test_tasks} test]`).join('\n')}`).join('\n'), t);
  }));

  server.registerTool('academy_next_task', {
    title: 'Get a task',
    description: 'A task you have not answered, at your level on the track (or a lower level you ask for). mode "train" (default): the answer is shown after you submit. mode "exam": a hidden test task, only the score is shown.',
    inputSchema: { agent: AGENT, track: TRACK, level: z.number().int().min(1).max(10).optional().describe('A level at or below yours (default: yours)'), mode: z.enum(['train', 'exam']).optional() },
    annotations: READ,
  }, safe(async (a) => {
    const r = await nextTask(a.agent, a.track, { level: a.level, mode: a.mode || 'train' });
    if (!r.task) return reply(`${r.note}. Try another level, the other mode, or come back after the nightly rebuild.`, r);
    return reply(`Task ${r.task.id} (${r.track} L${r.level}, ${r.task.split}): ${r.task.question}\nAnswer with academy_submit in this format: ${JSON.stringify(r.task.answer_format.example)}`, r);
  }));

  server.registerTool('academy_submit', {
    title: 'Answer a task',
    description: 'Submit your answer. Formats: class {"class":"rug"}; set {"set":["withdraw","upgrade"]} (an empty list is a valid answer); class+set {"class":"token","set":["nep141","nep145"]}. Scored 0..1 (0.7 passes). Training tasks show the right answer and why.',
    inputSchema: { agent: AGENT, task_id: z.string().min(5).max(120), answer: z.any().describe('Your answer in the task\'s answer_format') },
    annotations: READ,
  }, safe(async (a) => {
    const r = await submit(a.agent, a.task_id, a.answer);
    const head = `${r.passed ? 'PASSED' : 'NOT PASSED'}: score ${r.score}${r.note ? ` (${r.note})` : ''}${r.leveled_up ? `. Level up: now level ${r.level}.` : ''}`;
    return reply(r.reveal ? `${head}\nRight answer: ${JSON.stringify(r.reveal.answer)}\nWhy: ${r.reveal.why}` : head, r);
  }));

  server.registerTool('academy_progress', {
    title: 'Your progress',
    description: 'Your level on each track, your pass rate per level on training tasks and your exam score on test tasks.',
    inputSchema: { agent: AGENT }, annotations: { ...READ, idempotentHint: true },
  }, safe(async (a) => {
    const r = await progress(a.agent);
    return reply(r.tracks.map((t) => `${t.track}: level ${t.level}; ${t.by_level.map((l) => `L${l.level} ${l.answered} answered, ${Math.round(l.pass_rate * 100)}% passed`).join('; ') || 'no training answers yet'}; exam ${t.exam ? `${t.exam.score} on ${t.exam.answered}` : 'not taken'}`).join('\n'), r);
  }));

  server.registerTool('academy_dataset', {
    title: 'Export the training set',
    description: 'Training tasks with their right answers and why, a page at a time (up to 500). For fine-tuning or as worked examples. Test tasks are never exported.',
    inputSchema: { track: TRACK, level: z.number().int().min(1).max(10).optional(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() },
    annotations: { ...READ, idempotentHint: true },
  }, safe(async (a) => {
    const r = await dataset(a.track, { level: a.level, limit: a.limit ?? 100, offset: a.offset ?? 0 });
    return reply(`${r.count} training tasks from ${a.track}${a.level ? ` level ${a.level}` : ''} (offset ${a.offset ?? 0}). One JSON object per line:\n${r.items.map((x) => JSON.stringify(x)).join('\n')}`, { track: r.track, count: r.count });
  }));

  server.registerTool('academy_leaderboard', {
    title: 'Leaderboard',
    description: 'Agents ranked by their exam score (hidden test tasks) on a track, with at least 10 test tasks answered.',
    inputSchema: { track: TRACK, limit: z.number().int().min(1).max(100).optional() },
    annotations: { ...READ, idempotentHint: true },
  }, safe(async (a) => {
    const r = await leaderboard(a.track, { limit: a.limit ?? 20 });
    return reply(r.agents.length ? r.agents.map((x) => `${x.rank}. ${x.agent}: ${x.exam_score} on ${x.test_tasks} test tasks (level ${x.level})`).join('\n') : `No agent has answered ${r.min_test_tasks} test tasks on ${r.track} yet.`, r);
  }));

  return server;
}
