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
  incidents: async () => ({ incidents: [{ _id: 'inc:x', kind: 'exchange_drain', stolen_usd: 45669049, held_usd: 1000, started_ts: Date.parse('2026-10-29'), ai: { headline: 'Binance hot wallets drained' } }] }),
  incident: async (q) => (q === HACKER ? { incident: { _id: 'inc:x', kind: 'exchange_drain', stolen_usd: 45669049, attacker: { account: HACKER }, trail: { exit_usd: { 'swapped to Bitcoin': 107453 } } }, role: 'attacker' } : {}),
  whatIs: async (id) => ({ account: id, class: 'service/intents_solver', is: 'a NEAR Intents solver (fills swaps for many users)', label: null, operator: null, why: 'its name says it is a NEAR Intents solver', pass_through: false, flagged: null, cases: [], overruled: [{ is: 'an exchange hot wallet', source: 'behaviour', evidence: 'busy' }], edges: [] }),
};
async function connected() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createAgentGuard(fakeApi), client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const json = (r) => JSON.parse(r.content[1].text);

test('MCP: the eight tools are listed, with instructions', async () => {
  const c = await connected();
  assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ['check_account', 'check_contract', 'check_transaction', 'get_incident', 'guard_transaction', 'plan_scoped_key', 'recent_hacks', 'what_is']);
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

test('MCP: what_is says what an account is and what it overruled', async () => {
  const c = await connected();
  const r = await c.callTool({ name: 'what_is', arguments: { account: 'Solver-Priv-Liq.near' } });
  assert.match(r.content[0].text, /^solver-priv-liq\.near is a NEAR Intents solver/);
  assert.match(r.content[0].text, /overruled: an exchange hot wallet/);
  assert.equal(json(r).class, 'service/intents_solver');
});


// ---- spending counts tokens, an unfinished check is not a pass, a failed guard says do not sign (2026-11-11)
const ftTx = (token, amount, to = 'bob.near') => [{ signer: 'agent.near', receiver: token, actions: [{ index: 0, kind: 'function_call', method: 'ft_transfer', args: { receiver_id: to, amount }, deposit: '1' }] }];
test('policy: tokens sent with ft_transfer count toward USD limits; wNEAR counts as NEAR', () => {
  const usdc = ftTx('usdc.near', '500000000');
  const value = { near_usd: 3.7, moves: [{ tx: 0, token: 'usdc.near', raw: '500000000', to: 'bob.near', symbol: 'USDC', amount: 500, usd: 500 }] };
  assert.deepEqual(policyViolations(usdc, { max_near_per_day: 5 }, { value }).violations, [], 'a NEAR limit alone does not see USDC');
  assert.deepEqual(policyViolations(usdc, { max_usd_per_tx: 100 }, { value }).violations.map((v) => v.code), ['over_tx_usd_limit']);
  assert.deepEqual(policyViolations(usdc, { max_usd_per_day: 600 }, { value, spentUsdToday: 200 }).violations.map((v) => v.code), ['over_daily_usd_limit']);
  const wnear = ftTx('wrap.near', '20000000000000000000000000'); // 20 wNEAR
  const wv = { near_usd: 3.7, moves: [{ tx: 0, token: 'wrap.near', raw: '20000000000000000000000000', to: 'bob.near', amount: 20, usd: 74 }] };
  assert.deepEqual(policyViolations(wnear, { max_near_per_tx: 5 }, { value: wv }).violations.map((v) => v.code), ['over_tx_limit'], '20 wNEAR is over 5 NEAR');
  const self = [{ ...wnear[0], actions: [{ ...wnear[0].actions[0], args: { receiver_id: 'agent.near', amount: '20000000000000000000000000' } }] }];
  assert.deepEqual(policyViolations(self, { max_near_per_tx: 5 }, { value: { ...wv, moves: [{ ...wv.moves[0], to: 'agent.near' }] } }).violations, [], 'to its own account is not spending');
});
test('policy: an unpriced token under a USD limit asks a human', () => {
  const r = policyViolations(ftTx('meme.near', '1000'), { max_usd_per_tx: 100 }, { value: { near_usd: 3.7, moves: [{ tx: 0, token: 'meme.near', raw: '1000', to: 'bob.near', symbol: 'MEME', amount: 1000, usd: null }] } });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.asks.map((a) => a.code), ['unpriced_token']);
  assert.equal(decide({ verdict: 'ok', findings: [] }, r, { max_usd_per_tx: 100 }).decision, 'ask_human');
});
test('decide: a check that could not finish is never an allow', () => {
  const clean = { violations: [], asks: [], near_total: 0 };
  assert.equal(decide({ verdict: 'ok', findings: [], context: { complete: true } }, clean, {}).decision, 'allow');
  const d = decide({ verdict: 'ok', findings: [], context: { complete: false } }, clean, {});
  assert.equal(d.decision, 'ask_human');
  assert.equal(d.complete, false);
  assert.equal(decide({ verdict: 'block', findings: [], context: { complete: false } }, clean, {}).decision, 'block', 'a block stays a block');
});
test('MCP: a guard that fails tells the agent not to sign', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createAgentGuard({ ...fakeApi, checkTx: async () => { throw new Error('timeout'); } }), client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = await client.callTool({ name: 'guard_transaction', arguments: { transaction: { signerId: 'agent.near', receiverId: 'bob.near', actions: [{ type: 'Transfer', params: { deposit: '1' } }] } } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Do NOT sign/);
  await client.close();
});
test('MCP: recent_hacks and get_incident', async () => {
  const c = await connected();
  const list = await c.callTool({ name: 'recent_hacks', arguments: {} });
  assert.match(list.content[0].text, /inc:x: exchange_drain, \$45,669,049 taken/);
  const hit = await c.callTool({ name: 'get_incident', arguments: { query: HACKER } });
  assert.match(hit.content[0].text, /attacker in a confirmed hack \(inc:x\)/);
  assert.match(hit.content[0].text, /swapped to Bitcoin: \$107,453/);
  const none = await c.callTool({ name: 'get_incident', arguments: { query: 'alice.near' } });
  assert.match(none.content[0].text, /No hack is linked/);
  await c.close();
});
test('token moves: ft_transfer, ft_transfer_call and NEAR Intents transfers are read from the actions', async () => {
  const { tokenMoves } = await import('../src/firewall/moves.js');
  const txs = [
    { signer: 'a.near', receiver: 'usdc.near', actions: [{ index: 0, kind: 'function_call', method: 'ft_transfer_call', args: { receiver_id: 'v2.ref-finance.near', amount: '5' } }] },
    { signer: 'a.near', receiver: 'intents.near', actions: [{ index: 0, kind: 'function_call', method: 'ft_withdraw', args: { token: 'usdt.tether-token.near', receiver_id: 'b.near', amount: '7' } },
      { index: 1, kind: 'function_call', method: 'mt_batch_transfer', args: { receiver_id: 'c.near', token_ids: ['nep141:wrap.near', 'nep141:x.near'], amounts: ['1', '2'] } }] },
    { signer: 'a.near', receiver: 'wrap.near', actions: [{ index: 0, kind: 'function_call', method: 'near_withdraw', args: { amount: '9' } }] },
  ];
  assert.deepEqual(tokenMoves(txs).map((m) => `${m.tx}:${m.token}:${m.raw}:${m.to}`), ['0:usdc.near:5:v2.ref-finance.near', '1:usdt.tether-token.near:7:b.near', '1:wrap.near:1:c.near', '1:x.near:2:c.near']);
});
