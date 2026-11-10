import test from 'node:test';
import assert from 'node:assert/strict';
import { paidBy, boughtBy, buyersOf, shareOf } from '../src/incident/ring.js';
import { checkPlan } from '../src/incident/caseadd.js';

const tx = (hash, signer, inflows = [], events = []) => ({ hash, ts: 1, signer, inflows, events, calls: [] });
const ft = (executor, from, to) => ({ standard: 'nep141', event: 'ft_transfer', executor, data: [{ old_owner_id: from, new_owner_id: to, amount: '1' }] });

test('paidBy: the biggest payments out of the case, never dust, never accounts already in the case', () => {
  const txs = [tx('a', 'att', [{ from: 'att', to: 'hub', near: 500 }, { from: 'att', to: 'dust', near: 2 }, { from: 'att', to: 'own', near: 900 }])];
  const r = paidBy(txs, new Set(['att']), { exclude: new Set(['own']) });
  assert.deepEqual(r.map((e) => e.to), ['hub']);
  assert.equal(r[0].tx, 'a');
});

test('boughtBy: a signer paid a token by a pool; wNEAR and mints sent to others do not count', () => {
  const txs = [tx('b', 'w1', [], [ft('tok.near', 'pool', 'w1'), ft('wrap.near', 'pool', 'w1'), ft('other.near', 'pool', 'w2')])];
  assert.deepEqual([...boughtBy(txs, 'w1')], ['tok.near']);
});

test('buyersOf and shareOf: the creator is left out, the share is of distinct buyers', () => {
  const txs = [tx('c', 'b1', [], [ft('tok.near', 'pool', 'b1')]), tx('d', 'b2', [], [ft('tok.near', 'pool', 'b2')]), tx('e', 'b3', [], [ft('tok.near', 'pool', 'b3')]), tx('f', 'creator', [], [ft('tok.near', 'mint', 'creator')])];
  const s = shareOf(buyersOf('tok.near', txs), new Set(['b1', 'b2']), 'creator');
  assert.deepEqual([s.linked, s.total, +s.share.toFixed(2)], [2, 3, 0.67]);
});

test('case-add plans: a name is required, a trading-only link is "suspected" and never also a flagged account', () => {
  assert.ok(checkPlan({ accounts: [] }).problems.includes('name missing'));
  assert.ok(checkPlan({ name: 'x', accounts: [{ account: 'a.near', role: 'accomplice' }] }).problems.some((p) => /role accomplice/.test(p)));
  assert.ok(checkPlan({ name: 'x', accounts: [{ account: 'a.near' }], suspected: [{ account: 'a.near', why: 'w' }] }).problems.some((p) => /both a case account and suspected/.test(p)));
  const ok = checkPlan({ name: 'My Ring 1', accounts: [{ account: 'A.near' }], edges: [['a.near', 'b.near']], suspected: [{ account: 'C.near', why: 'made it' }] });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.plan.name, 'my-ring-1');
  assert.equal(ok.plan.accounts[0].account, 'a.near');
});
