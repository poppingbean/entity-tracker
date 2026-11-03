// Agent Guard: the policy (pure) and the MCP tools end to end over an in-memory link, with a fake Safe Near API (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { transactionsOf, policyViolations, decide, scopedKeyPlan, findSecret, normalizePolicy } from '../src/agent/policy.js';
import { createAgentGuard } from '../src/agent/mcp.js';

const NEAR = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();
const transfer = (to, n, from = 'agent.near') => ({ transaction: { signerId: from, receiverId: to, actions: [{ type: 'Transfer', params: { deposit: NEAR(n) } }] } });
const KEY = 'ed25519:9eGvRzTYB1Hf6nPWkwq7YPU4Dx5K6TpGCmVBrSsWsfWJ';

test('policy: spending limits per transaction, per request and per day', () => {
  const txs = transactionsOf({ transactions: [transfer('a.near', 0.6).transaction, transfer('b.near', 0.6).transaction] });
  assert.deepEqual(policyViolations(txs, { max_near_per_tx: 1 }).violations, []);
  assert.deepEqual(policyViolations(txs, { max_near_per_request: 1 }).violations.map((v) => v.code), ['over_request_limit']);
  assert.deepEqual(policyViolations(txs, { max_near_per_day: 2 }, { spentToday: 1 }).violations.map((v) => v.code), ['over_daily_limit']);
  assert.equal(policyViolations(txs, {}).near_total, 1.2);
});

test('policy: allowed receivers (with *.sub-accounts), allowed methods, forbidden actions', () => {
  const call = transactionsOf({ transaction: { signerId: 'agent.near', receiverId: 'pool.ref-finance.near', actions: [{ type: 'FunctionCall', params: { methodName: 'withdraw', args: {}, gas: '1', deposit: '0' } }] } });
  assert.deepEqual(policyViolations(call, { allowed_receivers: ['*.ref-finance.near'] }).violations, []);
  assert.deepEqual(policyViolations(call, { allowed_receivers: ['wrap.near'] }).violations.map((v) => v.code), ['receiver_not_allowed']);
  assert.deepEqual(policyViolations(call, { allowed_methods: ['swap'] }).violations.map((v) => v.code), ['method_not_allowed']);
  const fullKey = transactionsOf({ transaction: { signerId: 'agent.near', receiverId: 'agent.near', actions: [{ type: 'AddKey', params: { publicKey: KEY, accessKey: { permission: 'FullAccess' } } }] } });
  // the agent's own account needs no allow-listing; the full-access key is forbidden by default
  assert.deepEqual(policyViolations(fullKey, { allowed_receivers: ['wrap.near'] }).violations.map((v) => v.code), ['forbidden_action']);
  assert.deepEqual(policyViolations(fullKey, { forbidden_actions: [] }).violations, []);
  assert.deepEqual(normalizePolicy({}).block_on, ['block']);
});

test('decide: a policy violation or a "block" verdict blocks, "warn" asks a human, the rest is allowed', () => {
  const none = { violations: [], near_total: 0 }, one = { violations: [{ code: 'x', detail: 'over' }], near_total: 2 };
  assert.equal(decide({ verdict: 'ok' }, none, {}).decision, 'allow');
  assert.equal(decide({ verdict: 'caution' }, none, {}).decision, 'allow');
  assert.equal(decide({ verdict: 'warn' }, none, {}).decision, 'ask_human');
  assert.equal(decide({ verdict: 'warn' }, none, { block_on: ['block', 'warn'] }).decision, 'block');
  assert.equal(decide({ verdict: 'block' }, none, {}).decision, 'block');
  assert.equal(decide({ verdict: 'ok' }, one, {}).decision, 'block');
});

test('scoped key: a function-call key for one contract, and refusals', () => {
  const p = scopedKeyPlan({ owner: 'me.near', contract: 'v2.ref-finance.near', methods: ['swap'], public_key: KEY, allowance_near: 0.5 });
  const perm = p.transaction.actions[0].params.accessKey.permission;
  assert.deepEqual([p.transaction.signerId, p.transaction.receiverId, perm.receiverId, perm.methodNames, perm.allowance], ['me.near', 'me.near', 'v2.ref-finance.near', ['swap'], '500000000000000000000000']);
  assert.equal(p.revoke.actions[0].type, 'DeleteKey');
  assert.throws(() => scopedKeyPlan({ owner: 'me.near', contract: 'x.near', public_key: 'ed25519:' + '3'.repeat(88) }), /PUBLIC key/);
  assert.throws(() => scopedKeyPlan({ owner: 'me.near', contract: 'x.near', methods: ['bad method'], public_key: KEY }), /not a method name/);
  assert.throws(() => scopedKeyPlan({ owner: 'me.near', contract: 'x.near', public_key: KEY, allowance_near: 50 }), /allowance/);
});

test('secrets: private keys and seed phrases are found, ordinary text is not', () => {
  assert.equal(findSecret({ k: 'ed25519:' + '3'.repeat(88) }), 'a private key');
  assert.equal(findSecret({ private_key: 'x' }), 'a private key or seed phrase field');
  assert.equal(findSecret({ q: 'abandon ability able about above absent absorb abstract absurd abuse access accident' }), 'what looks like a seed phrase');
  assert.equal(findSecret({ memo: 'please send all the money back into main wallet after done with this swap thanks' }), null);
  assert.equal(findSecret({ public_key: KEY }), null);
});

// ---- the MCP tools, end to end over an in-memory link, with a fake API
const HACKER = 'efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af';
const fakeApi = {
  checkTx: async (body) => {
    const bad = JSON.stringify(body).includes(HACKER);
    return { verdict: bad ? 'block' : 'ok', summary: bad ? 'received drained funds' : 'No known risk', findings: bad ? [{ severity: 'critical', code: 'flagged_receiver', title: 'Flagged receiver' }] : [],
      transactions: [{ actions: [{ text: 'Send NEAR' }] }] };
  },
  inspect: async (q) => ({ verdict: q === HACKER ? 'danger' : 'safe', headline: q === HACKER ? 'Part of a hack' : 'Nothing known against it', points: [] }),
  contract: async (id) => ({ account: id, status: 'ok', level: id === 'risky.near' ? 'high' : 'low', type: { label: 'Token' }, findings: [] }),
  account: async () => ({}),
};
async function connected() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createAgentGuard(fakeApi), client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const json = (r) => JSON.parse(r.content[1].text);

test('MCP: the five tools are listed, with instructions', async () => {
  const c = await connected();
  assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ['check_account', 'check_contract', 'check_transaction', 'guard_transaction', 'plan_scoped_key']);
  assert.match(c.getInstructions(), /guard_transaction/);
  await c.close();
});

test('MCP: guard_transaction blocks a flagged receiver and a policy breach, allows the rest', async () => {
  const c = await connected();
  const g = (args) => c.callTool({ name: 'guard_transaction', arguments: args });
  assert.equal(json(await g(transfer(HACKER, 0.1))).decision, 'block');
  assert.equal(json(await g({ ...transfer('alice.near', 2), policy: { max_near_per_tx: 1 } })).decision, 'block');
  const ok = json(await g({ ...transfer('alice.near', 0.5), policy: { max_near_per_tx: 1 } }));
  assert.equal(ok.decision, 'allow');
  assert.equal(ok.near_total, 0.5);
  const bad = await g({ transaction: { signerId: 'a.near', actions: [] } });
  assert.equal(bad.isError, true);
  await c.close();
});

test('MCP: account, contract and scoped-key tools; secrets refused', async () => {
  const c = await connected();
  assert.equal(json(await c.callTool({ name: 'check_account', arguments: { query: HACKER } })).verdict, 'danger');
  assert.equal(json(await c.callTool({ name: 'check_contract', arguments: { account: 'risky.near' } })).level, 'high');
  const plan = await c.callTool({ name: 'plan_scoped_key', arguments: { owner: 'me.near', contract: 'risky.near', public_key: KEY } });
  assert.match(plan.content[0].text, /Careful: Safe Near rates risky\.near HIGH/);
  const secret = await c.callTool({ name: 'check_account', arguments: { query: 'ed25519:' + '3'.repeat(88) } });
  assert.equal(secret.isError, true);
  assert.match(secret.content[0].text, /Refused/);
  await c.close();
});
