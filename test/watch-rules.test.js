// Money watch: the pure rules (src/watch/rules.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { movementsOf, classifyOrigin, rulesVerdict, followStep, isIdle, reviewDue } from '../src/watch/rules.js';

const f = (o) => ({ tx: 't1', from: 'a.near', to: 'b.near', token: 'near', raw: '1', usd: 200000, ...o });
const W = { followMinUsd: 10000, followShare: 0.1, dustUsd: 1000, dustShare: 0.05, maxDepth: 3, reviewGapMinutes: 60, reviewMinUsd: 10000, maxIdleDays: 30 };

test('movements: only transfers worth the minimum, between accounts that hold people\'s money', () => {
  const flows = [f({ usd: 99999, raw: '1' }), f({ usd: 150000, raw: '2', to: 'c.near' }), f({ raw: '3', token: 'mint:x', to: 'd.near' }), f({ raw: '4', token: 'nft:y', to: 'e.near' })];
  assert.deepEqual(movementsOf(flows, { min: 100000 }).map((x) => x.to), ['c.near']);
});
test('movements: pass-through and protocol receivers are not movements', () => {
  const flows = [f({ from: 'wrap.near', to: 'x.near' }), f({ from: 'x.near', to: 'pool.near', raw: '2' }), f({ from: 'x.near', to: 'y.near', raw: '3' })];
  const r = movementsOf(flows, { min: 100000, skipFrom: (a) => a === 'wrap.near', skipTo: (a) => a === 'pool.near' });
  assert.deepEqual(r.map((x) => x.to), ['y.near']);
});
test('movements: a swap is not a movement (the receiver gave away something comparable in the same transaction)', () => {
  const flows = [f({ from: 'pool.near', to: 'user.near', token: 'usdt', usd: 300000 }), f({ from: 'user.near', to: 'router.near', token: 'near', usd: 295000, raw: '9' })];
  assert.equal(movementsOf(flows, { min: 100000, skipTo: (a) => a === 'router.near' }).length, 0, 'the router does not hold anybody money');
  const lone = [f({ from: 'pool.near', to: 'user.near', token: 'usdt', usd: 300000 }), f({ from: 'user.near', to: 'router.near', token: 'near', usd: 5000, raw: '9' })];
  assert.equal(movementsOf(lone, { min: 100000 }).length, 1, 'a small gift in return is not a swap');
});
test('movements: the same transfer seen twice is one', () => {
  assert.equal(movementsOf([f({}), f({})], { min: 100000 }).length, 1);
});

test('origin: a withdrawal of its own deposit, or a routine relationship, is closed by the rules', () => {
  assert.equal(classifyOrigin({ payer: 'staking', own_funds: true }).lean, 'normal');
  assert.equal(classifyOrigin({ payer: 'wallet', earlier_transfers: 3 }).lean, 'normal');
  assert.equal(classifyOrigin({ payer: 'wallet', earlier_transfers: 2, receiver_age_days: 400 }).lean, 'low');
});
test('origin: an exchange paying an old account in an ordinary amount is normal; a new account or an unusual amount is not', () => {
  assert.equal(classifyOrigin({ payer: 'exchange', receiver_age_days: 100 }).lean, 'normal');
  assert.equal(classifyOrigin({ payer: 'exchange', receiver_age_days: 1 }).class, 'exchange_to_new_account');
  assert.equal(classifyOrigin({ payer: 'exchange', receiver_age_days: 400, exchange_unusual: true }).lean, 'high');
});
test('origin: a fresh receiver is a high lean; old active accounts a low one', () => {
  assert.equal(classifyOrigin({ payer: 'wallet', receiver_age_days: 0.5 }, { freshHours: 72 }).class, 'fresh_receiver');
  assert.equal(classifyOrigin({ payer: 'wallet', receiver_age_days: 400, payer_age_days: 500, receiver_txs: 900 }).class, 'established_accounts');
  assert.equal(classifyOrigin({ payer: 'unknown' }).class, 'no_history');
});
test('rules verdict: only a normal lean is a verdict', () => {
  assert.equal(rulesVerdict({ lean: 'normal', class: 'own_funds_withdrawal', reasons: ['x'] }).verdict, 'normal');
  assert.equal(rulesVerdict({ lean: 'high', class: 'fresh_receiver', reasons: [] }), null);
});

test('follow: a partial send keeps the sender and watches the receiver', () => {
  const r = followStep({ in_usd: 200000, out_usd: 0, depth: 0 }, { usd: 80000 }, { triggerUsd: 200000, W });
  assert.deepEqual([r.follow, r.sender, r.depth], [true, 'keep', 1]);
});
test('follow: a full send drops the sender (all but the dust has gone)', () => {
  assert.equal(followStep({ in_usd: 200000, out_usd: 0, depth: 0 }, { usd: 195000 }, { triggerUsd: 200000, W }).sender, 'drop');
  assert.equal(followStep({ in_usd: 200000, out_usd: 100000, depth: 1 }, { usd: 95000 }, { triggerUsd: 200000, W }).sender, 'drop', 'the second send finishes it');
  assert.equal(followStep({ in_usd: 200000, out_usd: 0, depth: 0 }, { usd: 150000 }, { triggerUsd: 200000, W }).sender, 'keep');
});
test('follow: small moves, the depth limit and a full case are recorded but not followed', () => {
  assert.equal(followStep({ in_usd: 200000, out_usd: 0, depth: 0 }, { usd: 5000 }, { triggerUsd: 200000, W }).follow, false);
  assert.equal(followStep({ in_usd: 200000, out_usd: 0, depth: 0 }, { usd: 15000 }, { triggerUsd: 200000, W }).follow, false, 'under 10 % of the trigger');
  assert.equal(followStep({ in_usd: 90000, out_usd: 0, depth: 3 }, { usd: 50000 }, { triggerUsd: 200000, W }).why, 'depth limit');
  assert.equal(followStep({ in_usd: 90000, out_usd: 0, depth: 1 }, { usd: 50000 }, { triggerUsd: 200000, hasRoom: false, W }).why, 'account limit');
});

test('idle: a watch with no move for 30 days is idle', () => {
  const now = 100 * 86400e3;
  assert.equal(isIdle({ last_move_ts: now - 31 * 86400e3 }, now, W), true);
  assert.equal(isIdle({ last_move_ts: now - 2 * 86400e3 }, now, W), false);
  assert.equal(isIdle({ opened_ts: now - 40 * 86400e3 }, now, W), true, 'never moved: counted from when it opened');
});
test('review due: first time always; then only after the gap and enough new money or a new exit', () => {
  const now = 1e12;
  assert.equal(reviewDue({ status: 'watching' }, now, W), true);
  assert.equal(reviewDue({ status: 'normal' }, now, W), false);
  assert.equal(reviewDue({ status: 'watching', last_review_ts: now - 10 * 60e3, moved_since_review_usd: 90000 }, now, W), false, 'too soon');
  assert.equal(reviewDue({ status: 'watching', last_review_ts: now - 120 * 60e3, moved_since_review_usd: 500 }, now, W), false, 'too little');
  assert.equal(reviewDue({ status: 'watching', last_review_ts: now - 120 * 60e3, moved_since_review_usd: 50000 }, now, W), true);
  assert.equal(reviewDue({ status: 'watching', last_review_ts: now - 120 * 60e3, new_exit: true }, now, W), true);
});

test('decide: the rules close routine origins, the AI needs confidence, a person\'s report blocks both', async () => {
  const { decide } = await import('../src/watch/rules.js');
  const routine = { lean: 'normal', class: 'own_funds_withdrawal', reasons: ['x'] }, open = { lean: 'low', class: 'no_history', reasons: [] };
  assert.deepEqual(decide({ status: 'watching' }, routine, null), { action: 'normal', by: 'rules', why: 'own funds withdrawal' });
  assert.equal(decide({ status: 'watching', reports: [{ ts: 1 }] }, routine, null).action, 'keep', 'a reported address is not closed by the rules');
  assert.equal(decide({ status: 'watching' }, open, null).action, 'keep', 'no AI: the watch goes on');
  assert.equal(decide({ status: 'watching' }, open, { verdict: 'normal', confidence: 'high', what_it_is: 'staking' }).action, 'normal');
  assert.equal(decide({ status: 'watching' }, open, { verdict: 'normal', confidence: 'low' }).action, 'keep', 'low confidence does not close');
  assert.equal(decide({ status: 'watching', reports: [{ ts: 1, source: 'https://x.test/a' }] }, open, { verdict: 'normal', confidence: 'high' }).action, 'keep', 'a sourced report is not closed by the AI');
  assert.equal(decide({ status: 'suspicious' }, open, { verdict: 'normal', confidence: 'high' }, { incidentOpen: true }).action, 'keep', 'an open incident is not closed by the AI');
  assert.equal(decide({ status: 'watching' }, open, { verdict: 'suspicious', confidence: 'medium', what_it_is: 'splitting' }).action, 'suspicious');
  assert.equal(decide({ status: 'watching' }, open, { verdict: 'suspicious', confidence: 'low' }).action, 'keep');
});

test('look back: the first account of a case within the hops, with the path', async () => {
  const { lookBack } = await import('../src/watch/report.js');
  const payers = { z: ['y'], y: ['x', 'w'], x: ['case-account'], w: [] };
  const opts = { payersOf: async (a) => payers[a] || [], isKnown: async (a) => (a === 'case-account' ? { kind: 'watch', id: 'w:1' } : null) };
  assert.deepEqual(await lookBack('z', { hops: 3, ...opts }), { kind: 'watch', id: 'w:1', account: 'case-account', path: ['z', 'y', 'x', 'case-account'] });
  assert.equal(await lookBack('z', { hops: 2, ...opts }), null, 'out of hops');
  assert.equal(await lookBack('nobody', { hops: 3, ...opts }), null);
});

test('review due: a watch whose AI verdict was missing is retried after the gap', () => {
  const now = 1e12;
  assert.equal(reviewDue({ status: 'watching', last_review_ts: now - 120 * 60e3, ai_missing: true }, now, W), true);
  assert.equal(reviewDue({ status: 'watching', last_review_ts: now - 10 * 60e3, ai_missing: true }, now, W), false, 'not before the gap');
});
