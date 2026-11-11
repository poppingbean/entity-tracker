import test from 'node:test';
import assert from 'node:assert/strict';
import { paidBy, boughtBy, buyersOf, shareOf, pathTo, planFor } from '../src/incident/ring.js';
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

test('paidBy: payments from before the hack do not link anyone', () => {
  const txs = [{ hash: 'old', ts: 100, signer: 'att', events: [], calls: [], inflows: [{ from: 'att', to: 'friend', near: 900 }] },
    { hash: 'new', ts: 2000, signer: 'att', events: [], calls: [], inflows: [{ from: 'att', to: 'hub', near: 900 }] }];
  assert.deepEqual(paidBy(txs, new Set(['att']), { since: 1000 }).map((e) => e.to), ['hub']);
});

test('planFor: an approval carries the whole path back to the case, and a creator the case paid is never also "suspected"', () => {
  const inc = { _id: 'inc:abcdef1234567890', accounts: [{ account: 'att', role: 'attacker' }] };
  const edges = [{ from: 'att', to: 'hub', near: 1e5, tx: 't1' }, { from: 'hub', to: 'f1', near: 3e4, tx: 't2' }, { from: 'f1', to: 'b1', near: 2e3, tx: 't3' }, { from: 'f1', to: 'b2', near: 1e3, tx: 't4' }];
  const found = { edges, caseSet: ['att'] };
  const p = planFor(inc, { token: 'tok.near', creator: 'maker.near', share: 1, buyers: ['b1', 'b2'] }, found);
  assert.deepEqual(p.accounts.map((a) => a.account).sort(), ['b1', 'b2', 'f1', 'hub']);
  assert.deepEqual(p.edges.map((e) => e.tx).sort(), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(p.suspected.map((s) => s.account), ['maker.near']);
  assert.deepEqual(checkPlan(p).problems, []);
  const paidCreator = planFor(inc, { token: 'tok.near', creator: 'f1', share: 1, buyers: ['b1'] }, found);
  assert.deepEqual(paidCreator.suspected, []);
  assert.deepEqual(checkPlan(paidCreator).problems, []);
});

test('pathTo stops at the case and survives a loop', () => {
  const loop = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }];
  assert.ok(pathTo('a', loop, new Set()).length <= 2);
  assert.deepEqual(pathTo('x', [{ from: 'att', to: 'x' }], new Set(['att'])).map((e) => e.from), ['att']);
});

// ---- WP-12: one budget of accounts, not 40 per hop
import { pickFound, RING } from '../src/incident/ring.js';
test('a buyer that is the 60th largest receiver is reached while the budget allows', () => {
  const found = Array.from({ length: 100 }, (_, i) => ({ to: `w${i}`, near: 1000 - i }));
  assert.equal(pickFound(found, 0).length, 100);
  assert.ok(pickFound(found, 0).some((e) => e.to === 'w59'));
  assert.equal(pickFound(found, 150).length, RING.maxAccounts - 150, 'the budget is shared by all hops');
  assert.equal(pickFound(found, 250).length, 0);
});
