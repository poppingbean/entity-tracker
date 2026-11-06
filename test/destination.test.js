// Where withdrawals go (src/audit/destination.js): a method NAME says nothing about the destination; the code can bind it to a committed owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataStrings, guardsFromWat, applyOwnerBound } from '../src/audit/destination.js';
import { powerInventory } from '../src/audit/powers.js';
import { auditFindings } from '../src/audit/findings.js';
import { describeFunctions } from '../src/audit/functions.js';

// a tiny WAT module in the shape wabt prints: messages in data at fixed addresses, functions that load an address and call host functions
const MSG = { owner: "Not the owner's address", gate: 'Only the controller', plain: 'Amount too small' };
const OWNER_AT = 2000, GATE_AT = 2000 + MSG.owner.length, PLAIN_AT = GATE_AT + MSG.gate.length;
const wat = (fnsText) => `(module\n  (import "env" "sha256" (func $env.sha256 (param i64 i64 i64)))\n${fnsText}\n  (data $d0 (i32.const 2000) "${MSG.owner}${MSG.gate}${MSG.plain}")\n)`;
const fn = (name, { exp = null, calls = [], consts = [] } = {}) => `  (func $${name}${exp ? ` (export "${exp}")` : ''} (param i32)\n${calls.map((c) => `    call ${c}`).join('\n')}\n${consts.map((c) => `    i32.const ${c}`).join('\n')}\n  )`;

test('a method reaching "hash the receiver + owner-mismatch panic" is owner-bound; the same name without it is not', () => {
  const w = wat([
    fn('check_owner', { calls: ['$env.sha256'], consts: [OWNER_AT] }),    // hashes AND holds the owner-mismatch message
    fn('only_msg', { consts: [OWNER_AT] }),                                // the message but no hash: a caller check by another name
    fn('only_hash', { calls: ['$env.sha256'], consts: [PLAIN_AT] }),       // hashes something, but no owner message
    fn('gate', { consts: [GATE_AT] }),                                     // "only the controller"
    fn('via_helper', { calls: ['$check_owner'] }),
    fn('pay_owner_', { exp: 'pay_to_owner', calls: ['$check_owner'] }),
    fn('sweep_', { exp: 'sweep', calls: ['$via_helper'] }),                // reaches the check through a helper
    fn('rescue_', { exp: 'rescue_funds', calls: ['$only_msg'] }),          // no hash: not bound
    fn('digest_', { exp: 'withdraw_to', calls: ['$only_hash'] }),          // hash, wrong message: not bound
    fn('admin_', { exp: 'admin_withdraw', calls: ['$gate'] }),             // caller-checked, destination free
    fn('free_', { exp: 'drain', calls: [] }),                              // nothing at all
  ].join('\n'));
  const g = guardsFromWat(w);
  assert.deepEqual(g.owner_bound, ['pay_to_owner', 'sweep']);
  assert.deepEqual(g.caller_checked, ['admin_withdraw']);
  assert.deepEqual(guardsFromWat(w, ['sweep', 'drain']).owner_bound, ['sweep'], '`wanted` limits the exports looked at');
});

test('data strings decode hex escapes, and a message only counts at the address a function loads', () => {
  const segs = dataStrings('(module\n  (data $d0 (i32.const 16) "A\\0aB\\22C\\5cD")\n)');
  assert.equal(segs[0].off, 16);
  assert.equal(segs[0].text, 'A\nB"C\\D');
  const off = wat([fn('check', { calls: ['$env.sha256'], consts: [OWNER_AT + 1] }), fn('x', { exp: 'sweep', calls: ['$check'] })].join('\n'));
  assert.deepEqual(guardsFromWat(off).owner_bound, [], 'an address one byte off the message start is not that message');
});

test('owner-bound methods leave the "moves users\' funds" power; unbound ones stay at its severity', () => {
  const inv = powerInventory(['sweep', 'exit_to_owner', 'drain_all', 'new', 'get_state'], 'unknown');
  const mf = inv.find((p) => p.power === 'move_user_funds');
  assert.equal(mf.severity, 'critical');
  assert.ok(mf.methods.includes('sweep'), 'by name alone, sweep is a power');
  // every withdrawal-type method is bound: the power is gone
  const all = applyOwnerBound([{ power: 'move_user_funds', label: 'x', severity: 'critical', methods: ['sweep', 'rescue_x'] }], ['sweep', 'rescue_x', 'buy']);
  assert.deepEqual(all.powers, []);
  assert.deepEqual(all.bound, ['rescue_x', 'sweep'], 'only methods that were in the power count as bound');
  // one stays unbound: the power stays with the severity and only that method; other powers are untouched
  const r = applyOwnerBound([{ power: 'move_user_funds', label: 'x', severity: 'critical', methods: ['sweep', 'drain_all'] }, { power: 'upgrade', label: 'u', severity: 'medium', methods: ['upgrade'] }], ['sweep']);
  assert.deepEqual(r.powers.map((x) => [x.power, x.methods, x.severity]), [['move_user_funds', ['drain_all'], 'critical'], ['upgrade', ['upgrade'], 'medium']]);
  assert.deepEqual(r.bound, ['sweep']);
  assert.deepEqual(applyOwnerBound([{ power: 'upgrade', label: 'u', severity: 'medium', methods: ['sweep'] }], ['sweep']).powers[0].methods, ['sweep'], 'only the funds power is narrowed');
});

test('findings report owner-bound exits as info, and the level follows the methods that are not bound', () => {
  const base = { role: 'unknown', label: 'Unknown', fake_storage: [], source: { link: 'x' } };
  const bound = auditFindings({ code: { ...base, powers: [], owner_bound: ['sweep', 'exit_to_owner'] }, control: { controllers: [], full_keys: 0 } });
  assert.equal(bound.level, 'low');
  const f = bound.findings.find((x) => x.key === 'owner_bound_exit');
  assert.equal(f.severity, 'info');
  assert.match(f.title, /sweep, exit_to_owner can only pay the owner address/);
  const open = auditFindings({ code: { ...base, powers: [{ power: 'move_user_funds', label: "Moves or wipes users' balances", severity: 'critical', methods: ['drain_all'] }], owner_bound: ['sweep'] }, control: { controllers: [], full_keys: 0 } });
  assert.equal(open.level, 'critical');
  assert.ok(open.findings.some((x) => x.key === 'owner_bound_exit') && open.findings.some((x) => x.key === 'power_move_user_funds'));
  // without the evidence nothing is claimed
  assert.ok(!auditFindings({ code: { ...base, powers: [] }, control: { controllers: [], full_keys: 0 } }).findings.some((x) => x.key === 'owner_bound_exit'));
});

test('the function review says what a guarded method does, and claims nothing without guards', () => {
  const eff = { sweep: { effects: ['writes_state', 'generic_promise', 'hashes'], size: 9 }, other: { effects: ['writes_state', 'generic_promise'], size: 9 } };
  const rows = describeFunctions(['sweep', 'other'], eff, { owner_bound: ['sweep'], caller_checked: ['other'] });
  assert.ok(rows[0].does.includes('pays only the owner address committed at creation'));
  assert.ok(!rows[0].does.some((d) => /refuses callers/.test(d)));
  assert.ok(rows[1].does.some((d) => /refuses callers/.test(d)));
  assert.ok(!describeFunctions(['sweep'], eff)[0].does.some((d) => /committed/.test(d)));
});
