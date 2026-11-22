import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgId, memberId, memberDoc, memberFact } from '../src/ontology/orgnet.js';
import { resolve } from '../src/ontology/resolve.js';

test('an organisation is named once however it is written; members are accounts or chain addresses', () => {
  for (const s of ['BitMine', 'bitmine', 'org:bitmine', ' Bit Mine ']) assert.match(orgId(s), /^org:bit-?mine$/);
  assert.equal(orgId(''), null);
  assert.equal(memberId('Alice.NEAR'), 'alice.near');
  assert.equal(memberId('a'.repeat(64)), 'a'.repeat(64), 'an implicit account');
  assert.ok(memberId('eth:0x' + 'ab'.repeat(20)), 'an Ethereum address');
  for (const bad of ['', 'not an account!', 'x'.repeat(70)]) assert.equal(memberId(bad), null, bad);
});

test('a member needs a reason; a public report needs its link; confidence follows the source', () => {
  assert.throws(() => memberDoc('org:bitmine', 'a.near', {}), /why/);
  assert.throws(() => memberDoc('org:bitmine', 'a.near', { why: 'paid by the treasury', source: 'rumour' }), /source/);
  assert.throws(() => memberDoc('org:bitmine', 'a.near', { why: 'named in a filing', source: 'public_report' }), /link/);
  assert.throws(() => memberDoc('org:bitmine', 'a.near', { why: 'paid by it', confidence: 2 }), /confidence/);
  assert.equal(memberDoc('org:bitmine', 'a.near', { why: 'paid by the treasury' }).confidence, 0.9, 'by hand');
  assert.equal(memberDoc('org:bitmine', 'a.near', { why: 'traced from the treasury', source: 'trace' }).confidence, 0.7);
  const d = memberDoc('org:bitmine', 'a.near', { why: 'named in a filing', source: 'public_report', link: 'https://example.com/filing' });
  assert.equal(d._id, 'org:bitmine|a.near');
  assert.equal(memberFact(d, 'BitMine').evidence, "in BitMine's network: named in a filing (https://example.com/filing)");
});

test('a wallet in two networks answers with both organisations', () => {
  const a = 'shared.near';
  const f1 = { ...memberFact(memberDoc('org:bitmine', a, { why: 'paid by the BitMine treasury', source: 'trace' }), 'BitMine'), by: 'writer/org_networks' };
  const f2 = { ...memberFact(memberDoc('org:other-fund', a, { why: 'signs for the fund' }), 'Other Fund'), by: 'writer/org_networks' };
  const r = resolve(a, [f1, f2]);
  assert.deepEqual(r.operators.map((o) => o.org), ['org:other-fund', 'org:bitmine'], 'by hand before an investigation');
  assert.match(r.operators[1].evidence, /BitMine's network/);
});
