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

// ---- review fixes (2026-11-11)
const WC = { ...W, followCapUsd: 100000 };
test('follow floor: a share of what the SENDER received, capped, so the splits of a big drain are followed', () => {
  // a $45M drain: the attacker sends $430k to a hub. Old rule: 10% of the $45M trigger = $4.5M floor, not followed
  assert.equal(followStep({ in_usd: 45e6, out_usd: 0, depth: 0 }, { usd: 430000 }, { triggerUsd: 45e6, W: WC }).follow, true, 'over the cap: always followed');
  // the hub (received $430k) pays $50k: its own 10% is $43k, so it is followed, whatever the trigger was
  assert.equal(followStep({ in_usd: 430000, out_usd: 0, depth: 1 }, { usd: 50000 }, { triggerUsd: 45e6, W: WC }).follow, true);
  assert.equal(followStep({ in_usd: 430000, out_usd: 0, depth: 1 }, { usd: 30000 }, { triggerUsd: 45e6, W: WC }).follow, false, 'under its branch floor');
});
test('splits to one receiver are summed: the part that reaches the floor is followed', () => {
  const ent = { in_usd: 200000, out_usd: 0, depth: 0 };
  assert.equal(followStep(ent, { usd: 6000 }, { triggerUsd: 200000, W: WC }).follow, false);
  const r = followStep(ent, { usd: 6000 }, { triggerUsd: 200000, pendingUsd: 18000, W: WC });
  assert.equal(r.follow, true, '6k after 18k already sent to the same receiver: 24k, over the 20k floor');
});
test('a sender emptied by small transfers is dropped, not watched forever', () => {
  const r = followStep({ in_usd: 200000, out_usd: 196000, depth: 0 }, { usd: 3000 }, { triggerUsd: 200000, W: WC });
  assert.equal(r.follow, false);
  assert.equal(r.sender, 'drop', 'below the follow floor, but it has sent everything');
});
test('swap legs: a different token back is a trade; the same token passed on in one transaction is a movement', () => {
  const fwd = [f({ tx: 'x', from: 'a.near', to: 'b.near', token: 'near', raw: '1', usd: 2e6 }), f({ tx: 'x', from: 'b.near', to: 'c.near', token: 'near', raw: '2', usd: 1.5e6 })];
  assert.deepEqual(movementsOf(fwd, { min: 100000 }).map((m) => m.to), ['b.near', 'c.near'], 'receive-and-forward is not a swap');
  const swap = [f({ tx: 'y', from: 'pool.near', to: 'b.near', token: 'near', raw: '1', usd: 2e6 }), f({ tx: 'y', from: 'b.near', to: 'pool.near', token: 'usdc.near', raw: '2', usd: 2e6 })];
  assert.equal(movementsOf(swap, { min: 100000 }).filter((m) => m.to === 'b.near').length, 0, 'b traded: it gave usdc back');
});
test('the AI alone never closes a watch whose origin the rules found suspicious', async () => {
  const { decide } = await import('../src/watch/rules.js');
  const high = { class: 'exchange_to_new_account', lean: 'high', reasons: [] };
  assert.equal(decide({ status: 'watching' }, high, { verdict: 'normal', confidence: 'high', what_it_is: 'withdrawal' }).action, 'keep');
  assert.equal(decide({ status: 'watching' }, high, { verdict: 'suspicious', confidence: 'medium' }).action, 'suspicious', 'it can still escalate');
  assert.equal(decide({ status: 'watching' }, { class: 'no_history', lean: 'low', reasons: [] }, { verdict: 'normal', confidence: 'medium' }).action, 'normal');
});
test('money watch accuracy: a watch closed as normal and later shown to be a hack is counted', async () => {
  const { watchAccuracy } = await import('../src/accuracy/security.js');
  const rows = [
    { status: 'normal', closed_ts: 10, status_history: [{ status: 'watching', by: 'rules' }, { status: 'normal', by: 'ai' }], reports: [{ ts: 20 }], accounts: [{ account: 'x.near' }] },
    { status: 'normal', closed_ts: 10, status_history: [{ status: 'normal', by: 'rules' }], accounts: [{ account: 'bad.near' }] },
    { status: 'normal', closed_ts: 10, status_history: [{ status: 'normal', by: 'rules' }], reports: [{ ts: 5 }], accounts: [{ account: 'ok.near' }] },
    { status: 'confirmed', status_history: [{ status: 'suspicious', by: 'ai' }, { status: 'confirmed', by: 'operator' }], accounts: [] },
    { status: 'suspicious', status_history: [{ status: 'suspicious', by: 'ai' }], accounts: [] },
    { status: 'watching', status_history: [], accounts: [] },
  ];
  const a = watchAccuracy(rows, new Set(['bad.near']));
  assert.equal(a.closed_normal, 3);
  assert.equal(a.normal_later_bad, 2, 'a report after the close, and an account of a bad case; a report before the close does not count');
  assert.equal(a.escalated, 2);
  assert.equal(a.escalated_confirmed, 1);
  assert.equal(a.open, 2);
});
test('busy-only exchanges are not endpoints for the money watch (WP-08)', async () => {
  const { busyOnly, notAPerson } = await import('../src/watch/scan.js');
  assert.equal(busyOnly({ top: 'exchange', source: 'behaviour', operator: null }), true);
  assert.equal(notAPerson({ top: 'exchange', source: 'behaviour', operator: null }), false, 'followed like a person');
  assert.equal(notAPerson({ top: 'exchange', source: 'registry', operator: 'org:binance' }), true);
  assert.equal(notAPerson({ top: 'exchange', source: 'behaviour', operator: 'org:binance' }), true, 'named: proven');
  assert.equal(notAPerson({ top: 'contract', source: 'audit' }), true);
});

// ---- custody flows: money that ends inside an exchange's or custodian's wallets is not layering
const { custodyKind, custodyPattern } = await import('../src/watch/rules.js');
const facts = (o) => new Map(Object.entries(o));
const watch = (o = {}) => ({
  trigger: { usd: 100000 }, reports: [], origin: { class: 'established_accounts', lean: 'low' },
  accounts: [{ account: 'r.near', in_usd: 100000, out_usd: 100000 }, { account: 'dep1', in_usd: 100000, out_usd: 99000 }],
  moves: [{ from: 'r.near', to: 'dep1', usd: 100000 }, { from: 'dep1', to: 'hot', usd: 99000 }], ...o,
});

test('custody wallets: busy hot wallets, large holders that rarely sign, known exchange wallets', () => {
  assert.equal(custodyKind({ txs: 79329 }), 'hot');
  assert.equal(custodyKind({ txs: 456, balance_near: 20357509, sign_share: 0 }), 'cold');
  assert.equal(custodyKind({ txs: 218, balance_near: 2725590, sign_share: 0.4 }), null); // big but signs a lot: not cold
  assert.equal(custodyKind({ exchange: 'OKX' }), 'exchange');
  assert.equal(custodyKind({ txs: 50, balance_near: 10 }), null);
  assert.equal(custodyKind(undefined), null);
});

test('money that ends in a hot wallet, with nothing left in ordinary accounts, is a custody flow', () => {
  const r = custodyPattern(watch(), facts({ hot: { txs: 80000 } }));
  assert.equal(r.custody, true);
  assert.match(r.why, /custody flow/); assert.match(r.why, /80,000 transactions/);
  assert.deepEqual(r.wallets, [{ account: 'hot', kind: 'hot' }]);
});

test('not a custody flow: reported, a suspicious origin, money left NEAR, or an ordinary account still holds it', () => {
  const F = facts({ hot: { txs: 80000 } });
  assert.equal(custodyPattern(watch({ reports: [{ by: 'x' }] }), F).custody, false);
  assert.equal(custodyPattern(watch({ origin: { class: 'fresh_receiver', lean: 'high' } }), F).custody, false);
  assert.equal(custodyPattern(watch({ moves: [...watch().moves, { from: 'hot', to: 'x', usd: 5000, exit: { kind: 'swap_out' } }] }), F).custody, false);
  const kept = custodyPattern(watch({ accounts: [...watch().accounts, { account: 'holder', in_usd: 60000, out_usd: 0 }] }), F);
  assert.equal(kept.custody, false); assert.match(kept.why, /ordinary accounts still hold/);
  const little = custodyPattern(watch({ moves: [{ from: 'r.near', to: 'hot', usd: 20000 }] }), F);
  assert.equal(little.custody, false); assert.match(little.why, /reached custody-like wallets/);
  assert.equal(custodyPattern(watch({ moves: [] }), F).custody, false);
});

test('an exit to a known exchange counts as reaching custody', () => {
  const w = watch({ moves: [{ from: 'r.near', to: 'binance.near', usd: 95000, exit: { kind: 'exchange' } }], accounts: [{ account: 'r.near', in_usd: 100000, out_usd: 95000 }] });
  assert.equal(custodyPattern(w, facts({})).custody, true);
});

test('a validator staking pool is classed as staking by its name (only the pool factories create those names)', async () => {
  const { virtualFacts } = await import('../src/ontology/known.js');
  const cls = (a) => virtualFacts(a).find((f) => f.predicate === 'is_a')?.object || null;
  assert.equal(cls('twinstake.poolv1.near'), 'contract/staking');
  assert.equal(cls('aurora.pool.near'), 'contract/staking');
  assert.equal(cls('evilpoolv1.near'), null);
  assert.equal(cls('poolv1.near'), null);
  const { STAKING_POOL } = await import('../src/watch/review.js');
  assert.ok(STAKING_POOL.test('twinstake.poolv1.near') && !STAKING_POOL.test('pool.near'));
});

test('a busy contract (a bridge, a router) is never a custody wallet', () => {
  assert.equal(custodyKind({ txs: 3735995, contract: true }), null);
  assert.equal(custodyKind({ exchange: 'Binance', contract: true }), 'exchange'); // a named exchange wallet still counts
});
