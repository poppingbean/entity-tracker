// Where withdrawals go (src/audit/destination.js). A method NAME says nothing about the destination; a code pattern is only a hint (the
// deployer writes the code, a decoy is easy); only the chain (payouts matching a commitment made at creation) may lower a rating, one step.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { dataStrings, guardsFromWat, ownerCheckHints, commitmentsOf, argStrings, payoutsOf, corroborateOwnerChecks } from '../src/audit/destination.js';
import { auditFindings } from '../src/audit/findings.js';
import { describeFunctions } from '../src/audit/functions.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const borshStr = (s) => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
const borshBytes = (b) => { const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };

// a tiny WAT module in the shape wabt prints: messages in data at fixed addresses, functions that load an address and call host functions
const MSG = { owner: "Not the owner's address", gate: 'Only the controller', plain: 'Amount too small' };
const OWNER_AT = 2000, GATE_AT = 2000 + MSG.owner.length, PLAIN_AT = GATE_AT + MSG.gate.length;
const wat = (fnsText, data = `${MSG.owner}${MSG.gate}${MSG.plain}`) => `(module\n  (import "env" "sha256" (func $env.sha256 (param i64 i64 i64)))\n${fnsText}\n  (data $d0 (i32.const 2000) "${data}")\n)`;
const fn = (name, { exp = null, calls = [], consts = [] } = {}) => `  (func $${name}${exp ? ` (export "${exp}")` : ''} (param i32)\n${calls.map((c) => `    call ${c}`).join('\n')}\n${consts.map((c) => `    i32.const ${c}`).join('\n')}\n  )`;
const FUNDS = (methods) => [{ power: 'move_user_funds', label: "Moves or wipes users' balances", severity: 'critical', methods }];
const BASE = { role: 'unknown', label: 'Unknown', fake_storage: [], source: { link: 'x' } };
const WALLET = { controllers: [{ account: 'dev.near', kind: 'wallet', via: 'STATE', flags: [] }], full_keys: 0 };

test('code hints: a method reaching "hash + owner-mismatch message" gets an owner_check hint; messages alone or hashes alone do not', () => {
  const w = wat([
    fn('check_owner', { calls: ['$env.sha256'], consts: [OWNER_AT] }),
    fn('only_msg', { consts: [OWNER_AT] }),
    fn('only_hash', { calls: ['$env.sha256'], consts: [PLAIN_AT] }),
    fn('gate', { consts: [GATE_AT] }),
    fn('via_helper', { calls: ['$check_owner'] }),
    fn('pay_owner_', { exp: 'pay_to_owner', calls: ['$check_owner'] }),
    fn('sweep_', { exp: 'sweep', calls: ['$via_helper'] }),
    fn('rescue_', { exp: 'rescue_funds', calls: ['$only_msg'] }),
    fn('digest_', { exp: 'withdraw_to', calls: ['$only_hash'] }),
    fn('admin_', { exp: 'admin_withdraw', calls: ['$gate'] }),
    fn('free_', { exp: 'drain', calls: [] }),
  ].join('\n'));
  const g = guardsFromWat(w);
  assert.deepEqual(g.owner_check, ['pay_to_owner', 'sweep']);
  assert.deepEqual(g.caller_check, ['admin_withdraw']);
  assert.deepEqual(guardsFromWat(w, ['sweep', 'drain']).owner_check, ['sweep'], '`wanted` limits the exports looked at');
  // only "moves users' funds" methods are reported as hinted
  assert.deepEqual(ownerCheckHints([...FUNDS(['sweep', 'drain']), { power: 'upgrade', methods: ['pay_to_owner'] }], g), ['sweep']);
});

test('data strings decode hex escapes, and a message only counts at the address a function loads', () => {
  const segs = dataStrings('(module\n  (data $d0 (i32.const 16) "A\\0aB\\22C\\5cD")\n)');
  assert.equal(segs[0].off, 16);
  assert.equal(segs[0].text, 'A\nB"C\\D');
  const off = wat([fn('check', { calls: ['$env.sha256'], consts: [OWNER_AT + 1] }), fn('x', { exp: 'sweep', calls: ['$check'] })].join('\n'));
  assert.deepEqual(guardsFromWat(off).owner_check, []);
});

test('a code hint never lowers the rating: a decoy check and an owner-only rug sweep both stay critical', () => {
  // A) a drainer plants a decoy (hash + "Not the owner's address", result ignored); sweep pays anywhere
  const decoy = guardsFromWat(wat([fn('decoy', { calls: ['$env.sha256'], consts: [OWNER_AT] }), fn('s', { exp: 'sweep', calls: ['$decoy'] })].join('\n')));
  // B) an owner-only sweep that pays any address: its guard says "Not owner" and an inlined storage-key hash sits in the same function
  const rug = guardsFromWat(wat([fn('assert_owner', { calls: ['$env.sha256'], consts: [2000] }), fn('s', { exp: 'sweep', calls: ['$assert_owner'] })].join('\n'), 'Not owner'));
  for (const g of [decoy, rug]) {
    assert.deepEqual(g.owner_check, ['sweep'], 'the pattern is there (that is why it is only a hint)');
    const powers = FUNDS(['sweep']);
    const r = auditFindings({ code: { ...BASE, powers, owner_check: ownerCheckHints(powers, g) }, control: WALLET });
    assert.equal(r.level, 'critical');
    assert.match(r.findings.find((f) => f.key === 'power_move_user_funds').detail, /not proof: it does not lower the risk on its own/);
  }
});

test('chain: a payout to the address committed at init (salted hash, borsh) is corroborated', () => {
  const owner = 'alice.near', salt = '4baa89191c4ed1859278b01b10a04dcd';
  const init = [Buffer.concat([borshStr('controller.near'), borshBytes(sha(salt + owner))])];
  const args = Buffer.concat([borshStr(owner), borshStr(salt)]);
  const r = corroborateOwnerChecks({ init, calls: [{ method: 'exit_to_owner', args, payouts: [owner] }, { method: 'exit_to_owner', args, payouts: [owner] }], exclude: ['controller.near'] });
  assert.deepEqual(r.corroborated, ['exit_to_owner']);
  assert.deepEqual(r.seen.exit_to_owner, { calls: 2, paying: 2, matched: 2 });
});

test('chain: JSON init with a hex hash of the plain receiver is corroborated too', () => {
  const init = [Buffer.from(JSON.stringify({ owner_hash: sha('bob.near').toString('hex') }))];
  const r = corroborateOwnerChecks({ init, calls: [{ method: 'sweep', args: Buffer.from(JSON.stringify({ receiver_id: 'bob.near' })), payouts: ['bob.near'] }] });
  assert.deepEqual(r.corroborated, ['sweep']);
});

test('chain: nothing is corroborated without proof that the money went to the committed address, and not to an insider', () => {
  const owner = 'alice.near', salt = 's4lt';
  const init = [borshBytes(sha(salt + owner))];
  const call = (payouts, a = owner) => ({ method: 'sweep', args: Buffer.concat([borshStr(a), borshStr(salt)]), payouts });
  const no = (calls, exclude = []) => assert.deepEqual(corroborateOwnerChecks({ init, calls, exclude }).corroborated, []);
  no([call(['mallory.near'], 'mallory.near')]);                    // paid an address that is not the commitment
  no([call([owner]), call(['mallory.near'], 'mallory.near')]);      // one bad payout among good ones
  no([call([owner, 'treasury.near'])]);                             // a second payee in the same call
  no([{ method: 'sweep', args: borshStr(salt), payouts: [owner] }]); // the receiver was not passed in the call: the contract chose it
  no([call([owner])], [owner]);                                      // committed, but the payee is the deployer / controller / caller
  no([call([])]);                                                    // never paid anything: nothing to confirm
  assert.deepEqual(corroborateOwnerChecks({ init: [], calls: [call([owner])] }).corroborated, [], 'no init call found: no commitment');
});

test('chain: argument strings and 32-byte commitments are read from borsh and JSON', () => {
  assert.deepEqual([...argStrings(Buffer.concat([borshStr('a.near'), Buffer.from([1, 2]), borshStr('xy')]))].sort(), ['a.near', 'xy']);
  assert.ok(argStrings(Buffer.from('{"a":{"b":"c.near"}}')).has('c.near'));
  const h = sha('x');
  assert.ok(commitmentsOf([Buffer.concat([Buffer.from([9, 9, 9]), h])]).has(h.toString('hex')), 'a raw 32-byte window');
  assert.ok(commitmentsOf([Buffer.from(JSON.stringify({ h: h.toString('base64') }))]).has(h.toString('hex')), 'base64');
  assert.ok(commitmentsOf([Buffer.from(JSON.stringify({ h: [...h] }))]).has(h.toString('hex')), 'byte array');
});

test('chain: payouts are native transfers out of the account and token transfers from it; refunds and self-transfers are not', () => {
  const t = { receipts: [
    { receipt: { predecessor_id: 'c.near', receiver_id: 'alice.near', receipt: { Action: { actions: [{ Transfer: { deposit: '5' } }] } } }, execution_outcome: { outcome: { logs: [] } } },
    { receipt: { predecessor_id: 'system', receiver_id: 'relayer.near', receipt: { Action: { actions: [{ Transfer: { deposit: '1' } }] } } }, execution_outcome: { outcome: { logs: [] } } },
    { receipt: { predecessor_id: 'c.near', receiver_id: 'c.near', receipt: { Action: { actions: [{ Transfer: { deposit: '1' } }] } } }, execution_outcome: { outcome: { logs: [
      'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"c.near","new_owner_id":"bob.near","amount":"1"}]}',
      'Transfer 7 from c.near to carol.near', 'Transfer 7 from x.near to dave.near'] } } },
  ] };
  assert.deepEqual(payoutsOf(t, 'c.near').sort(), ['alice.near', 'bob.near', 'carol.near']);
});

test('findings: the chain confirming EVERY funds method lowers the power one step; partly confirmed or hint-only changes nothing', () => {
  const powers = FUNDS(['exit_to_owner', 'exit_to_other']);
  const all = auditFindings({ code: { ...BASE, powers }, control: WALLET, corroborated: ['exit_to_owner', 'exit_to_other'] });
  assert.equal(all.level, 'high', 'critical -> high: one step, never more');
  const part = auditFindings({ code: { ...BASE, powers, owner_check: ['exit_to_owner'] }, control: WALLET, corroborated: ['exit_to_owner'] });
  assert.equal(part.level, 'critical');
  assert.match(part.findings.find((f) => f.key === 'power_move_user_funds').detail, /every payout of exit_to_owner went to the address committed .*; the other methods are not confirmed/);
  assert.equal(auditFindings({ code: { ...BASE, powers, owner_check: ['exit_to_owner', 'exit_to_other'] }, control: WALLET }).level, 'critical', 'hints alone');
});

test('function review: hedged wording for hints, nothing without them', () => {
  const eff = { sweep: { effects: ['writes_state', 'generic_promise', 'hashes'], size: 9 }, other: { effects: ['writes_state', 'generic_promise'], size: 9 } };
  const rows = describeFunctions(['sweep', 'other'], eff, { owner_check: ['sweep'], caller_check: ['other'] });
  assert.ok(rows[0].does.includes('appears to check the receiver against a stored owner hash (code pattern, not proof)'));
  assert.ok(rows[1].does.some((d) => /appears to refuse callers/.test(d)));
  assert.ok(!describeFunctions(['sweep'], eff)[0].does.some((d) => /owner hash/.test(d)));
});
