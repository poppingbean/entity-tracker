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
