// Exchange deposit addresses read from the chain (src/ontology/deposits.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepsInto, judgeDeposit, nearFlowsOfBlocks, isImplicit, DEPOSIT } from '../src/ontology/deposits.js';
import { cutsLinks, isClass } from '../src/ontology/classes.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), HOT = 'c'.repeat(64), HOT2 = 'd'.repeat(64), OTHER_HOT = 'e'.repeat(64);
const wallets = new Map([[HOT, { exchange: 'Bybit', kind: 'hot' }], [HOT2, { exchange: 'Bybit', kind: 'hot' }], [OTHER_HOT, { exchange: 'Coinbase', kind: 'hot' }], ['bybitcold.near', { exchange: 'Bybit', kind: 'cold' }]]);
const fl = (from, to, near, ts = 1) => ({ from, to, token: 'near', raw: String(BigInt(Math.round(near * 1000)) * 10n ** 21n), ts, tx: `${from.slice(0, 3)}${to.slice(0, 3)}${ts}` });
const customer = 'f'.repeat(64);

test('candidates: NEAR sent by an outside implicit account into a named exchange hot wallet', () => {
  const flows = [fl(A, HOT, 50), fl(B, HOT, 0.5), fl('alice.near', HOT, 80), fl(A, 'bybitcold.near', 90), fl(HOT2, HOT, 1000), { ...fl(A, HOT, 5), token: 'usdt' }];
  assert.deepEqual(sweepsInto(flows, wallets).map((s) => [s.account, s.hot, s.exchange, s.near]), [[A, HOT, 'Bybit', 50]]);
  assert.equal(sweepsInto([fl(A, HOT, 1)], wallets).length, 1, 'one NEAR is the minimum');
  assert.equal(isImplicit(A), true); assert.equal(isImplicit('alice.near'), false);
});

test('a deposit address: it receives from outside and passes everything on, over and over, to one exchange', () => {
  const flows = [fl(customer, A, 100, 1), fl(A, HOT, 99.9, 2), fl(customer, A, 40, 3), fl(A, HOT2, 39.9, 4), fl('someone.near', A, 7, 5), fl(A, HOT, 6.9, 6)];
  const j = judgeDeposit({ account: A, flows, wallets });
  assert.equal(j.ok, true, j.reasons.join('; '));
  assert.deepEqual([j.exchange, j.in_n, j.out_n, j.in_near, j.out_near], ['Bybit', 3, 3, 147, 147]);
  assert.deepEqual(j.hots.sort(), [HOT, HOT2].sort());
});

test('not a deposit address: a customer wallet that also pays others, one that deposited once, one that keeps its money', () => {
  const j = (flows) => judgeDeposit({ account: A, flows, wallets });
  assert.match(j([fl(customer, A, 100, 1), fl(A, HOT, 30, 2), fl(A, 'shop.near', 30, 3), fl(A, HOT, 30, 4), fl(customer, A, 5, 5)]).reasons.join(), /not an exchange's/);
  assert.match(j([fl(customer, A, 100, 1), fl(A, HOT, 99, 2)]).reasons.join(), /only 1 deposits|only 1 sends/);
  assert.match(j([fl(customer, A, 1000, 1), fl(customer, A, 1000, 2), fl(A, HOT, 10, 3), fl(A, HOT, 10, 4), fl(A, HOT, 10, 5)]).reasons.join(), /does not pass on/);
  assert.match(j([fl(customer, A, 100, 1), fl(customer, A, 100, 2), fl(A, HOT, 60, 3), fl(A, HOT, 70, 4), fl(A, OTHER_HOT, 70, 5)]).reasons.join(), /more than one exchange/);
  assert.match(j([fl(HOT, A, 100, 1), fl(HOT2, A, 100, 2), fl(A, HOT, 60, 3), fl(A, HOT, 70, 4), fl(A, HOT, 70, 5)]).reasons.join(), /only 0 deposits/, 'money from the exchange itself is not a deposit');
  assert.match(judgeDeposit({ account: 'alice.near', flows: [], wallets }).reasons.join(), /not an implicit account/);
  assert.match(judgeDeposit({ account: HOT, flows: [], wallets }).reasons.join(), /exchange wallet itself/);
  assert.equal(judgeDeposit({ account: A, flows: [], wallets }).ok, false);
});

test('only sends to a cold wallet are not enough: a deposit address sweeps into a hot wallet', () => {
  const j = judgeDeposit({ account: A, flows: [fl(customer, A, 100, 1), fl(customer, A, 100, 2), fl(A, 'bybitcold.near', 70, 3), fl(A, 'bybitcold.near', 70, 4), fl(A, 'bybitcold.near', 60, 5)], wallets });
  assert.equal(j.ok, false); assert.match(j.reasons.join(), /hot wallet/);
});

test('blocks: NEAR transfers are decoded from receipts, other tokens and failed receipts are not', () => {
  const rc = (pred, recv, dep, failed = false) => ({ receipt: { receipt_id: 'r', predecessor_id: pred, receiver_id: recv, receipt: { Action: { signer_id: pred, actions: [{ Transfer: { deposit: dep } }] } } }, execution_outcome: { block_height: 1, outcome: { logs: [], status: failed ? { Failure: {} } : { SuccessValue: '' } } }, tx_hash: 'T' });
  const b = { block: { header: { height: 5, timestamp_nanosec: '1000000000' } }, shards: [{ receipt_execution_outcomes: [rc(A, HOT, '5000000000000000000000000'), rc(A, HOT, '9000000000000000000000000', true)] }] };
  const f = nearFlowsOfBlocks([b]);
  assert.equal(f.length, 1); assert.deepEqual([f[0].from, f[0].to, f[0].token], [A, HOT, 'near']);
  assert.equal(sweepsInto(f, wallets)[0].near, 5);
});

test('classes: a deposit address is an exchange class that does not cut links; every other exchange class does', () => {
  assert.equal(isClass('exchange/deposit_address'), true);
  assert.equal(cutsLinks('exchange/deposit_address'), false);
  assert.equal(cutsLinks('exchange/hot_wallet'), true); assert.equal(cutsLinks('exchange'), true); assert.equal(cutsLinks('service/router'), true);
  assert.equal(cutsLinks('person/wallet'), false); assert.equal(cutsLinks('unknown'), false);
  assert.ok(DEPOSIT.minSweeps >= 3 && DEPOSIT.sweepShare >= 0.9);
});

test('names for exchange wallets nobody has named: "CEX user wallet" and "Unidentified exchange wallet"; a label or an operator wins', async () => {
  const { displayName } = await import('../src/ontology/index.js');
  assert.equal(displayName('exchange/deposit_address', null, null), 'CEX user wallet');
  assert.equal(displayName('exchange/deposit_address', null, 'org:bybit'), 'CEX user wallet (bybit)');
  assert.equal(displayName('exchange', null, null), 'Unidentified exchange wallet');
  assert.equal(displayName('exchange/hot_wallet', null, null), 'Unidentified exchange wallet');
  assert.equal(displayName('exchange/hot_wallet', null, 'org:binance'), 'binance wallet');
  assert.equal(displayName('exchange/hot_wallet', 'Binance hot wallet', 'org:binance'), 'Binance hot wallet', 'a label wins');
  assert.equal(displayName('person/wallet', null, null), null);
});

test('the tracer: a CEX user wallet is a user\'s wallet (not an exchange endpoint, not "busy"); a shared collection account keeps its name and stays neutral', async () => {
  const { fromOntology } = await import('../src/incident/origin.js');
  const dep = fromOntology({ class: 'exchange/deposit_address', top: 'exchange', source: 'behaviour', label: 'CEX user wallet', why: 'sweeps' });
  assert.deepEqual([dep.kind, dep.name, dep.busy], ['wallet', 'CEX user wallet', undefined]);
  const shared = fromOntology({ class: 'exchange', top: 'exchange', source: 'behaviour', label: 'Unidentified exchange wallet', why: 'sweeps' });
  assert.deepEqual([shared.kind, shared.name], ['wallet', 'Unidentified exchange wallet']);
  const busy = fromOntology({ class: 'exchange/hot_wallet', top: 'exchange', source: 'behaviour', label: null, why: 'busy' });
  assert.equal(busy.name, 'Busy account (unidentified)', 'a busy-only exchange fact keeps the old neutral name');
});

test('one customer or a shared collection account, from the number of depositors (the measured gap: 6 then 14)', async () => {
  const { depositKind } = await import('../src/ontology/deposits.js');
  assert.deepEqual(depositKind(1), { one: true, confidence: 0.7 }); assert.deepEqual(depositKind(2), { one: true, confidence: 0.7 });
  assert.deepEqual(depositKind(4), { one: true, confidence: 0.6 }); assert.deepEqual(depositKind(6), { one: true, confidence: 0.6 });
  assert.deepEqual(depositKind(7), { one: false, confidence: 0.5 }); assert.deepEqual(depositKind(18), { one: false, confidence: 0.5 });
  assert.deepEqual(depositKind(undefined), { one: false, confidence: 0.5 }, 'unknown: treated as shared, the cautious side (it cuts links)');
});
