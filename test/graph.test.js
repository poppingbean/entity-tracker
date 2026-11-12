// The ontology's graph in memory (src/ontology/graph.js): loading facts, walking, and "near a bad account" with hubs cut.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addFact, walk, nearBad, pathText } from '../src/ontology/graph.js';

const G = () => ({ out: new Map(), in: new Map(), bad: new Map(), loadedTs: 1, logV: 0 });
const HUBS = new Set(['binance-hot.near', 'solver.near']);
const cuts = (id) => HUBS.has(id);
function build() {
  const g = G();
  const f = (subject, predicate, object, extra = {}) => addFact(g, { subject, predicate, object, source: 'trace', ...extra });
  f('binance-hot.near', 'funded', 'attacker.near');              // an exchange paid the attacker
  f('attacker.near', 'role_in', 'inc:x', { role: 'attacker', status: 'confirmed' });
  f('attacker.near', 'funded', 'hub-wallet.near');               // the attacker's hub
  f('hub-wallet.near', 'funded', 'buyer.near');                  // a wallet the hub paid
  f('binance-hot.near', 'funded', 'honest.near');                // another exchange customer
  f('solver.near', 'funded', 'other.near');
  f('flagged.near', 'flagged', 'high', { evidence: 'drainer' });
  f('flagged.near', 'member_of', 'grp:1'); f('sibling.near', 'member_of', 'grp:1'); // same wallet group
  f('victim.near', 'role_in', 'inc:x', { role: 'victim', status: 'confirmed' });
  f('suspect.near', 'role_in', 'inc:y', { role: 'attacker', status: 'suspected' });
  return g;
}

test('bad accounts: flagged critical / high, or on the attacker\'s side of a confirmed case', () => {
  const g = build();
  assert.ok(g.bad.has('attacker.near'));
  assert.ok(g.bad.has('flagged.near'));
  assert.ok(!g.bad.has('victim.near'), 'a victim is not bad');
  assert.ok(!g.bad.has('suspect.near'), 'a suspected case is not proof');
});

test('walk goes both ways, never through an exchange or a service', () => {
  const g = build();
  const fromBuyer = walk(g, 'buyer.near', { maxHops: 3, cuts }).map((x) => x.node);
  assert.ok(fromBuyer.includes('hub-wallet.near') && fromBuyer.includes('attacker.near'));
  assert.ok(fromBuyer.includes('binance-hot.near'), 'the exchange is reached (recorded) …');
  assert.ok(!fromBuyer.includes('honest.near'), '… but never walked through: its other customer is not linked');
});

test('near a bad account: within the hops, with the path; exchanges themselves are never checked', () => {
  const g = build();
  const n = nearBad(g, 'buyer.near', { maxHops: 2, cuts });
  assert.equal(n.account, 'attacker.near'); assert.equal(n.hop, 2);
  assert.match(pathText(n.path), /hub-wallet\.near funded buyer\.near, attacker\.near funded hub-wallet\.near/);
  assert.equal(nearBad(g, 'buyer.near', { maxHops: 1, cuts }), null, 'one hop is not enough');
  assert.equal(nearBad(g, 'honest.near', { maxHops: 2, cuts }), null, 'an exchange customer is not linked to the attacker');
  assert.equal(nearBad(g, 'binance-hot.near', { maxHops: 2, cuts }), null, 'an exchange is one hop from everyone: not checked');
  const s = nearBad(g, 'sibling.near', { maxHops: 2, cuts });
  assert.equal(s.account, 'flagged.near', 'the same wallet group as a flagged account (two hops through the group)');
});

test('a group or case node is walked through even when its name looks like an exchange', () => {
  const g = G();
  addFact(g, { subject: 'hub.near', predicate: 'flagged', object: 'high' });
  addFact(g, { subject: 'hub.near', predicate: 'member_of', object: 'grp:binance-hack-ring', source: 'trace' });
  addFact(g, { subject: 'signer.near', predicate: 'member_of', object: 'grp:binance-hack-ring', source: 'trace' });
  // a cut that says "binance" is an exchange, as a name pattern would: it must not apply to the group node
  const nameCut = (id) => /binance/.test(id);
  assert.equal(nearBad(g, 'signer.near', { maxHops: 2, cuts: (id) => !/^(grp|inc):/.test(id) && nameCut(id) })?.account, 'hub.near');
});
test('account-name patterns never class a group, a case or a chain address', async () => {
  const { virtualFacts } = await import('../src/ontology/known.js');
  for (const id of ['grp:binance-hack-ring', 'inc:binancecold3.near', 'eth:0xabc']) assert.deepEqual(virtualFacts(id), [], id);
});
