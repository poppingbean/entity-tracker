// NEAR AI calls: an answer cut off by max_tokens is retried with more room, and an unreadable answer is not reported as an outage.
// fetch is replaced by a fake NEAR AI; nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NEAR_AI_API_KEY ||= 'test-key';
const { chatJSON, aiStatus } = await import('../src/ai/tools/nearai.js');

const realFetch = globalThis.fetch;
/** A fake NEAR AI: `answers` are [content, finish_reason] in order; records the max_tokens of each request. */
function fakeAi(answers) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body).max_tokens);
    const [content, finish] = answers[Math.min(seen.length - 1, answers.length - 1)];
    return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content }, finish_reason: finish }], usage: {} }), { status: 200 });
  };
  return seen;
}
test.after(() => { globalThis.fetch = realFetch; });

test('a cut-off answer is retried with twice the room, and then read', async () => {
  const seen = fakeAi([['{"verdict": "ok", "reasons": ["a', 'length'], ['{"verdict": "ok"}', 'stop']]);
  const { json } = await chatJSON({ system: 's', user: 'u', maxTokens: 700 });
  assert.deepEqual(json, { verdict: 'ok' });
  assert.deepEqual(seen, [700, 1400]);
  assert.equal(aiStatus.ok, true);
});

test('the room grows up to 4x (max 16,000), and an answer that never fits is not an outage', async () => {
  aiStatus.ok = true; aiStatus.error = null;
  const before = aiStatus.badAnswers;
  const seen = fakeAi([['{"cut": "off', 'length']]);
  await assert.rejects(chatJSON({ system: 's', user: 'u', maxTokens: 6000, attempts: 3 }), /finish_reason length, max_tokens 16000/);
  assert.deepEqual(seen, [6000, 12000, 16000]);
  assert.equal(aiStatus.ok, true, 'NEAR AI answered: it is reachable');
  assert.equal(aiStatus.badAnswers, before + 1);
  assert.match(aiStatus.lastBad.error, /no JSON/);
});

test('a server error is an outage', async () => {
  globalThis.fetch = async () => new Response('bad key', { status: 401 });
  await assert.rejects(chatJSON({ system: 's', user: 'u', maxTokens: 500 }), /NEAR AI 401/);
  assert.equal(aiStatus.ok, false);
  assert.match(aiStatus.error, /401/);
});

// ---- several NEAR AI keys (NEAR_AI_API_KEY="k1;k2"): a key out of credits or refused is set aside, the next key answers
const { keyProblem, pickKey } = await import('../src/ai/tools/nearai.js');
const { config: cfg } = await import('../src/config.js');

test('which failures mean the key is the problem', () => {
  assert.equal(keyProblem(402, ''), 'credits');
  assert.equal(keyProblem(429, '{"error":"Insufficient credits"}'), 'credits');
  assert.equal(keyProblem(400, 'monthly quota exceeded'), 'credits');
  assert.equal(keyProblem(401, 'bad key'), 'refused');
  assert.equal(keyProblem(403, 'forbidden'), 'refused');
  assert.equal(keyProblem(429, 'rate limit, slow down'), null); // a plain rate limit: wait, do not drop the key
  assert.equal(keyProblem(500, 'oops'), null);
  const parked = new Map([['a', 2e12]]);
  assert.equal(pickKey(['a', 'b'], parked, 1e12), 'b');
  assert.equal(pickKey(['a'], parked, 1e12), null);
  assert.equal(pickKey(['a'], parked, 3e12), 'a'); // set aside only for a while
});

test('a key out of credits is set aside and the next key answers, in the same call; the next call starts with that key', async () => {
  const saved = cfg.ai.keys.slice();
  cfg.ai.keys.splice(0, cfg.ai.keys.length, 'key-one-empty', 'key-two-ok');
  const used = [];
  globalThis.fetch = async (url, init) => {
    const k = init.headers.authorization.replace('Bearer ', ''); used.push(k);
    if (k === 'key-one-empty') return new Response('{"error":"insufficient credits on key-one-empty"}', { status: 402 });
    return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: '{"ok": true}' }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
  };
  try {
    const { json } = await chatJSON({ system: 's', user: 'u', maxTokens: 300, attempts: 1 }); // one attempt is enough: switching keys is not an attempt
    assert.deepEqual(json, { ok: true });
    assert.deepEqual(used, ['key-one-empty', 'key-two-ok']);
    await chatJSON({ system: 's', user: 'u', maxTokens: 300 });
    assert.equal(used.at(-1), 'key-two-ok');
    assert.equal(used.filter((k) => k === 'key-one-empty').length, 1, 'the empty key is not asked again while set aside');
    assert.deepEqual(aiStatus.keysSetAside.map((x) => x.key), [1]);
    assert.ok(!JSON.stringify(aiStatus).includes('key-one-empty'), 'a key never shows in the status');
  } finally { cfg.ai.keys.splice(0, cfg.ai.keys.length, ...saved); }
});

test('when every key is out of credits the call fails with the server\'s reason, and no key is printed', async () => {
  const saved = cfg.ai.keys.slice();
  cfg.ai.keys.splice(0, cfg.ai.keys.length, 'key-a-empty', 'key-b-empty');
  globalThis.fetch = async (url, init) => new Response(`{"error":"insufficient credits for ${init.headers.authorization}"}`, { status: 402 });
  try {
    const e = await chatJSON({ system: 's', user: 'u', maxTokens: 300 }).catch((x) => x);
    assert.match(e.message, /NEAR AI 402/);
    assert.match(e.message, /every key \(2\) is out of credits or refused/);
    assert.ok(!/key-a-empty|key-b-empty/.test(e.message), 'the keys are redacted');
  } finally { cfg.ai.keys.splice(0, cfg.ai.keys.length, ...saved); }
});

// ---- answer guards (2026-11-25)
const { placeholdersOut, thoughtFirst, firstBudget, THINK_ROOM } = await import('../src/ai/tools/nearai.js');
/** A fake NEAR AI with usage: `answers` are [content, finish_reason, completion_tokens]; records each request's max_tokens. */
function fakeAiUsage(answers) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body).max_tokens);
    const [content, finish, out = 0] = answers[Math.min(seen.length - 1, answers.length - 1)];
    return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: out } }), { status: 200 });
  };
  return seen;
}

test('placeholders: a list loses its stand-ins, a field with nothing real left is a hole', () => {
  assert.deepEqual(placeholdersOut({ how: ['step one', 'step two', '...'], note: '' }), { json: { how: ['step one', 'step two'], note: '' }, holes: [] });
  assert.deepEqual(placeholdersOut({ verdict: 'hack', reasons: ['...'] }).holes, ['reasons']);
  assert.deepEqual(placeholdersOut({ summary: '…', a: { b: ['<reason>', '  '] } }).holes, ['summary', 'a.b']);
  assert.deepEqual(placeholdersOut({ reasons: [], n: 3, ok: true, text: 'The payer is a solver... and it bridged out.' }).holes, [], 'an empty list, numbers and real text with dots are fine');
  for (const s of ['...', '…', 'TBD', 'N/A', 'todo', '[explanation]', '{x}', '--', '??']) assert.equal(placeholdersOut({ s }).holes.length, 1, s);
});

test('an answer with placeholders is retried, never returned; stand-in list items are dropped', async () => {
  aiStatus.ok = true;
  let seen = fakeAiUsage([['{"verdict": "hack", "confidence": "high", "reasons": ["..."]}', 'stop'], ['{"verdict": "not_hack", "reasons": ["routine withdrawal"]}', 'stop']]);
  const { json } = await chatJSON({ system: 's', user: 'u', maxTokens: 700, model: 'guard-model' });
  assert.deepEqual(json, { verdict: 'not_hack', reasons: ['routine withdrawal'] });
  assert.equal(seen.length, 2);
  seen = fakeAiUsage([['{"reasons": ["..."]}', 'stop']]);
  const before = aiStatus.badAnswers;
  await assert.rejects(chatJSON({ system: 's', user: 'u', maxTokens: 700, attempts: 2, model: 'guard-model' }), /placeholders instead of content \(reasons\)/);
  assert.equal(aiStatus.badAnswers, before + 1, 'a bad answer, not an outage');
  assert.equal(aiStatus.ok, true);
  fakeAiUsage([['{"how_it_worked": ["step 1", "step 2", "..."]}', 'stop']]);
  assert.deepEqual((await chatJSON({ system: 's', user: 'u', model: 'guard-model' })).json, { how_it_worked: ['step 1', 'step 2'] });
});

test('a model that thinks first: a cut-off answer goes to the ceiling, and its next call starts with more room', async () => {
  assert.equal(thoughtFirst({ completion_tokens: 2500 }, '{"verdict": "ok"'), true, 'billed far more than it wrote');
  assert.equal(thoughtFirst({ completion_tokens: 300 }, '{"verdict": "ok", "reasons": ["a"]}'), false);
  assert.equal(thoughtFirst({ completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 40 } }, '{}'), true);
  assert.equal(thoughtFirst({}, '{}', 'let me think'), true);
  const seen = fakeAiUsage([['{"verdict": "ok", "rea', 'length', 2500], ['{"verdict": "ok"}', 'stop', 3000]]);
  const { json } = await chatJSON({ system: 's', user: 'u', maxTokens: 2500, attempts: 2, model: 'thinker-model' });
  assert.deepEqual(json, { verdict: 'ok' });
  assert.deepEqual(seen, [2500, 10000], 'straight to the ceiling (4x), not 2x');
  const again = fakeAiUsage([['{"verdict": "ok"}', 'stop', 3000]]);
  await chatJSON({ system: 's', user: 'u', maxTokens: 2500, model: 'thinker-model' });
  assert.deepEqual(again, [2500 * THINK_ROOM], 'remembered: it starts with more room');
  assert.equal(firstBudget('never-seen', 2500, 10000), 2500);
});
