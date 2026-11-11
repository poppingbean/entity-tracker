// The best-first money trail (WP-11) with an injected transaction source: no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { followMoneyBestFirst, coverageOf } from '../src/incident/trace.js';
import { config } from '../src/config.js';

const MIL = '1000000000000000000000000'; // 1 NEAR in yocto
// a transaction document the way the indexer returns it: one NEAR transfer receipt
const tx = (hash, from, to, near) => ({ transaction: { hash }, execution_outcome: { block_timestamp: String(2000n * 1000000n), block_height: 1 }, receipts: [{ receipt: { receipt_id: hash, predecessor_id: from, receiver_id: to, receipt: { Action: { actions: [{ Transfer: { deposit: `${near}${'0'.repeat(24)}` } }] } } }, execution_outcome: { block_height: 1, outcome: { logs: [], status: { SuccessValue: '' } } } }] });
const flow = (from, to, near, ts = 2000) => ({ tx: `${from}>${to}`, ts, token: 'near', from, to, raw: `${near}${'0'.repeat(24)}`, kind: 'transfer' });
// a stub chain: wallet → its outgoing transactions
const chain = (map) => ({ accountTxHashes: async (a) => ({ hashes: (map[a] || []).map((x) => x.transaction.hash) }), fetchTxs: async (hashes) => Object.values(map).flat().filter((t) => hashes.includes(t.transaction.hash)) });
const base = { since: 0, own: new Map(), fake: new Set(), payers: new Set() };
const price = async (token, raw) => ({ amount: Number(BigInt(raw) / 10n ** 24n), usd: Number(BigInt(raw) / 10n ** 24n), symbol: 'NEAR' }); // 1 USD per NEAR, no network

test('a 5-hop chain is followed to its exchange', async () => {
  const map = { w1: [tx('h1', 'w1', 'w2', 1000)], w2: [tx('h2', 'w2', 'w3', 1000)], w3: [tx('h3', 'w3', 'w4', 1000)], w4: [tx('h4', 'w4', 'binancecold3.near', 1000)] };
  const r = await followMoneyBestFirst(new Set(['atk']), [flow('atk', 'w1', 1000)], { ...base, source: { ...chain(map), valueOf: price } });
  assert.deepEqual(r.wallets.map((w) => w.account), ['w1', 'w2', 'w3', 'w4']);
  assert.ok(r.exits.some((e) => /exchange/.test(e.kind)), 'reaches the exchange');
});
test('a branch under the share of the loss is not expanded and is listed in stopped', async () => {
  const map = { big: [tx('b1', 'big', 'binancecold3.near', 100000)], tiny: [tx('t1', 'tiny', 'binancecold3.near', 300)] };
  // loss $100,000: the floor is $500 at 0.5 %; "tiny" received $300
  const r = await followMoneyBestFirst(new Set(['atk']), [flow('atk', 'big', 100000), flow('atk', 'tiny', 300)], { ...base, lossUsd: 100000, budget: { floorUsd: 0, shareFloor: 0.005 }, source: { ...chain(map), valueOf: price } });
  assert.deepEqual(r.wallets.map((w) => w.account), ['big']);
  assert.deepEqual(r.stopped, [{ account: 'tiny', usd: 300, why: 'below its share of the loss' }]);
  assert.match(r.capped, /not followed/);
});
test('maxWallets holds and the rest is reported as stopped', async () => {
  const flows = Array.from({ length: 6 }, (_, i) => flow('atk', `w${i}`, 1000 - i));
  const r = await followMoneyBestFirst(new Set(['atk']), flows, { ...base, budget: { maxWallets: 2, floorUsd: 0, shareFloor: 0 }, source: { ...chain({}), valueOf: price } });
  assert.equal(r.wallets.length, 2); assert.equal(r.stopped.filter((s) => s.why === 'wallet budget spent').length, 4);
});
test('a loop terminates', async () => {
  const map = { a: [tx('x1', 'a', 'b', 1000)], b: [tx('x2', 'b', 'a', 1000)] };
  const r = await followMoneyBestFirst(new Set(['atk']), [flow('atk', 'a', 1000)], { ...base, source: { ...chain(map), valueOf: price } });
  assert.deepEqual(r.wallets.map((w) => w.account).sort(), ['a', 'b']);
});
test('coverageOf: endpoints, held and what is left untraced', () => {
  assert.deepEqual(coverageOf({ exits: [{ usd: 600 }, { usd: 100 }], held_usd: 200, stolen_usd: 1000, stopped: [{ account: 'x', usd: 5, why: 'below the USD floor' }] }),
    { stolen_usd: 1000, to_endpoints_usd: 700, still_held_usd: 200, untraced_usd: 100, untraced_share: 0.1, stopped: [{ account: 'x', usd: 5, why: 'below the USD floor' }] });
  assert.equal(coverageOf({ exits: [{ usd: 5000 }], stolen_usd: 1000 }).untraced_usd, 0);
  assert.equal(coverageOf({}).untraced_share, null);
});
test('the old search stays behind TRAIL_SEARCH=bfs', () => { assert.ok(['best_first', 'bfs'].includes(config.incidents.trail.search)); });
