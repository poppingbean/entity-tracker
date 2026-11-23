// The 3D graph's network (src/ontology/graph3d.js buildGraph3d): hops, hubs shown but not walked through, every link between kept nodes, the cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addFact } from '../src/ontology/graph.js';
import { buildGraph3d, nodeKind } from '../src/ontology/graph3d.js';

const HUBS = new Set(['binance-hot.near']);
const cuts = (id) => HUBS.has(id);
function build() {
  const g = { out: new Map(), in: new Map(), bad: new Map(), loadedTs: 1, logV: 0 };
  const f = (subject, predicate, object, extra = {}) => addFact(g, { subject, predicate, object, source: 'trace', ...extra });
  f('binance-hot.near', 'funded', 'a.near');
  f('binance-hot.near', 'funded', 'honest.near');
  f('a.near', 'funded', 'b.near');
  f('b.near', 'funded', 'c.near');
  f('a.near', 'controls', 'b.near');
  f('a.near', 'member_of', 'grp:c_1'); f('d.near', 'member_of', 'grp:c_1');
  f('a.near', 'role_in', 'inc:x', { role: 'attacker', status: 'confirmed' }); f('v.near', 'role_in', 'inc:x', { role: 'victim', status: 'confirmed' });
  f('a.near', 'operated_by', 'org:acme'); f('other.near', 'operated_by', 'org:acme');
  return g;
}
const ids = (r) => r.nodes.map((x) => x.id).sort();

test('one hop: direct neighbours, the exchange marked as cut', () => {
  const r = buildGraph3d(build(), 'a.near', { hops: 1, cuts });
  assert.deepEqual(ids(r), ['a.near', 'b.near', 'binance-hot.near', 'grp:c_1', 'inc:x', 'org:acme'].sort());
  assert.equal(r.nodes.find((x) => x.id === 'binance-hot.near').cut, true);
  assert.equal(r.nodes.find((x) => x.id === 'a.near').hop, 0);
  assert.equal(r.capped, null);
});

test('two hops: through a wallet and a group, never through an exchange, a case or an organisation', () => {
  const r = buildGraph3d(build(), 'a.near', { hops: 2, cuts });
  const got = ids(r);
  assert.ok(got.includes('c.near') && got.includes('d.near'));
  assert.ok(!got.includes('honest.near'), 'the exchange is not walked through');
  assert.ok(!got.includes('v.near'), 'a case is not walked through');
  assert.ok(!got.includes('other.near'), 'an organisation is not walked through');
});

test('a case as the start is walked from', () => {
  const r = buildGraph3d(build(), 'inc:x', { hops: 1, cuts });
  assert.deepEqual(ids(r), ['a.near', 'inc:x', 'v.near']);
});

test('every link between kept nodes, once each, with predicate and source', () => {
  const r = buildGraph3d(build(), 'a.near', { hops: 1, cuts });
  const ab = r.links.filter((l) => l.source === 'a.near' && l.target === 'b.near').map((l) => l.p).sort();
  assert.deepEqual(ab, ['controls', 'funded']);
  assert.ok(r.links.every((l) => l.s === 'trace'));
  assert.equal(r.links.find((l) => l.target === 'inc:x').role, 'attacker');
  const keys = r.links.map((l) => `${l.source}|${l.p}|${l.target}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('capped at maxNodes, and says so', () => {
  const g = build();
  for (let i = 0; i < 50; i++) addFact(g, { subject: 'a.near', predicate: 'funded', object: `w${i}.near`, source: 'trace' });
  const r = buildGraph3d(g, 'a.near', { hops: 2, maxNodes: 20, cuts });
  assert.equal(r.nodes.length, 20);
  assert.match(r.capped, /20 nodes/);
});

test('node kinds', () => {
  assert.equal(nodeKind('grp:c_1'), 'group'); assert.equal(nodeKind('inc:x'), 'case'); assert.equal(nodeKind('org:acme'), 'org'); assert.equal(nodeKind('a.near'), 'account');
});

test('the whole layer: every node and link once, compact, islands largest first, the cap keeps the best-linked', async () => {
  const { buildOverview } = await import('../src/ontology/graph3d.js');
  const g = build();
  const cls = (id) => (id === 'binance-hot.near' ? { top: 'exchange', cuts_links: true, label: 'Binance' } : { top: 'person' });
  const o = buildOverview(g, { cls });
  const idOf = (i) => o.nodes[i][0];
  assert.equal(o.nodes.length, new Set(o.nodes.map((x) => x[0])).size, 'each node once');
  assert.equal(o.links.length, 11, 'each fact once (the in lists mirror the out lists)');
  const hot = o.nodes.find((x) => x[0] === 'binance-hot.near');
  assert.equal(o.tops[hot[1]], 'exchange'); assert.equal(hot[2] & 2, 2, 'cut'); assert.equal(hot[5], 'Binance');
  const a = o.nodes.find((x) => x[0] === 'a.near');
  assert.equal(a[2] & 1, 1, 'attacker in a confirmed case is bad');
  assert.equal(o.tops[o.nodes.find((x) => x[0] === 'inc:x')[1]], 'case');
  assert.ok(o.links.every(([s, t, p]) => idOf(s) && idOf(t) && o.predicates[p]));
  assert.deepEqual(o.islands, [...o.islands].sort((x, y) => y - x));
  assert.equal(o.islands.reduce((s, k) => s + k, 0), o.nodes.length);
  const c = buildOverview(g, { cls, maxNodes: 3 });
  assert.equal(c.nodes.length, 3); assert.match(c.capped, /3 best-linked/);
  assert.ok(c.nodes.some((x) => x[0] === 'a.near'), 'the best-linked node is kept');
});
