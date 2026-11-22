// Operator mode (NEAR_AI_OPERATOR_DIR): AI requests go to a folder and are answered by hand; and the watch evidence's exit count no longer
// crashes the grounding check (it threw "exits.reduce is not a function" and every watch review's answer was lost).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { chatJSON, aiEnabled, operatorKey } from '../src/ai/tools/nearai.js';
import { aiBudget } from '../src/ai/tools/budget.js';
import { unverifiedNumbers, unverifiedAmounts } from '../src/ai/tools/verify.js';

test('operator mode: a request is written and queued, then its answer is returned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opai-')), keep = config.ai.operatorDir;
  config.ai.operatorDir = dir;
  try {
    assert.equal(aiEnabled(), true);
    assert.equal(await aiBudget('watch'), true, 'no NEAR AI budget is spent');
    const req = { system: 'sys', user: 'evidence', model: 'm', maxTokens: 100 };
    await assert.rejects(chatJSON(req), (e) => e.queued === true);
    const key = operatorKey('sys', 'evidence');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'requests', `${key}.json`), 'utf8'));
    assert.equal(saved.user, 'evidence');
    fs.mkdirSync(path.join(dir, 'answers'));
    fs.writeFileSync(path.join(dir, 'answers', `${key}.json`), '{"verdict":"normal"}');
    const r = await chatJSON(req);
    assert.deepEqual(r.json, { verdict: 'normal' });
    assert.match(r.model, /operator/);
    fs.writeFileSync(path.join(dir, 'answers', `${key}.json`), 'not json');
    await assert.rejects(chatJSON(req), /not a JSON object/);
  } finally { config.ai.operatorDir = keep; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grounding checks accept a count of exits (watch evidence) as well as a list (incident evidence)', () => {
  assert.doesNotThrow(() => unverifiedNumbers({ reasons: ['moved 5000 NEAR'] }, { exits: 3, moves: [{ near: 5000 }] }));
  assert.deepEqual(unverifiedNumbers({ reasons: ['moved 5000 NEAR'] }, { exits: 3, moves: [{ near: 5000 }] }), []);
  assert.doesNotThrow(() => unverifiedAmounts({ s: '$12,000' }, { exits: 2 }));
  assert.deepEqual(unverifiedAmounts({ s: '$300' }, { exits: [{ usd: 100 }, { usd: 200 }] }), []);
});

test('operator mode: a request about an item is named after it, so its answer still fits when live numbers in the prompt move; it expires after two days', async () => {
  const { operatorSubject, subjectKey } = await import('../src/ai/tools/nearai.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opai-')), keep = config.ai.operatorDir;
  config.ai.operatorDir = dir;
  try {
    const ask = (user) => operatorSubject.run({ kind: 'watch', id: 'w:abc' }, () => chatJSON({ system: 'watch prompt', user, model: 'm', maxTokens: 10 }));
    await assert.rejects(ask('sent on $40,700'), (e) => e.queued === true);
    const key = subjectKey('watch', 'w:abc', 'watch prompt');
    const req = JSON.parse(fs.readFileSync(path.join(dir, 'requests', `${key}.json`), 'utf8'));
    assert.deepEqual(req.subject, { kind: 'watch', id: 'w:abc' }, 'the request says which item it is for');
    fs.mkdirSync(path.join(dir, 'answers'));
    const ans = path.join(dir, 'answers', `${key}.json`);
    fs.writeFileSync(ans, '{"verdict":"normal"}');
    assert.deepEqual((await ask('sent on $40,817')).json, { verdict: 'normal' }, 'the price moved, the answer still fits');
    assert.notEqual(subjectKey('watch', 'w:abc', 'another prompt'), key, 'another kind of question about the same item is another request');
    const old = (Date.now() - 3 * 86400e3) / 1000; fs.utimesSync(ans, old, old);
    await assert.rejects(ask('a week later'), (e) => e.queued === true, 'an answer older than two days is not reused');
  } finally { config.ai.operatorDir = keep; fs.rmSync(dir, { recursive: true, force: true }); }
});
