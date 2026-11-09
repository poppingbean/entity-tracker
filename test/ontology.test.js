import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../src/ontology/resolve.js';
import { virtualFacts } from '../src/ontology/known.js';
import { invalid, factId } from '../src/ontology/index.js';
import { cutsLinks, fromAuditRole, isA } from '../src/ontology/classes.js';
import { compareIdentify, comparePass, compareCuts, compareFirewall } from '../src/ontology/shadow.js';
import { checkGolden, GOLDEN } from '../src/ontology/golden.js';
import { config } from '../src/config.js';
import { classOf, passThrough, groupingKind, reads, setReads, confident } from '../src/ontology/sync.js';
import { diff } from '../src/ontology/replay.js';

const F = (subject, object, source, confidence, extra = {}) => ({ subject, predicate: 'is_a', object, source, confidence, evidence: `${source} ${object}`, ...extra });
const solve = (a, facts = []) => resolve(a, [...virtualFacts(a), ...facts]);

test('the 2026-11-04 mistake: a busy account that settles through intents.near is a solver, not an exchange', () => {
  const e = resolve('x.near', [F('x.near', 'exchange/hot_wallet', 'behaviour', 0.4), F('x.near', 'service/intents_solver', 'behaviour', 0.8)]);
  assert.equal(e.class, 'service/intents_solver');
  assert.equal(e.conflicts.length, 1);
  assert.equal(e.conflicts[0].object, 'exchange/hot_wallet');
  assert.equal(e.cuts_links, true);
});

test('source rank beats confidence: a registry sweep outranks any behaviour', () => {
  const e = resolve('x.near', [F('x.near', 'service/intents_solver', 'behaviour', 0.99), F('x.near', 'exchange/hot_wallet', 'registry', 0.6)]);
  assert.equal(e.class, 'exchange/hot_wallet');
  assert.equal(e.source, 'registry');
});

test('a weaker fact that refines the winner gives the subclass; why carries both', () => {
  const e = resolve('h', [F('h', 'exchange', 'manual', 0.6, { evidence: 'hub' }), F('h', 'exchange/hot_wallet', 'registry', 0.9, { evidence: 'sweeps to cold' })]);
  assert.equal(e.class, 'exchange/hot_wallet');
  assert.equal(e.conflicts.length, 0);
  assert.match(e.why, /hub; sweeps to cold/);
});

test('facts past valid_to no longer count (a cleared case)', () => {
  const now = Date.now();
  const e = resolve('a', [{ subject: 'a', predicate: 'role_in', object: 'inc:1', role: 'attacker', source: 'trace', valid_to: now - 1 }, { subject: 'a', predicate: 'role_in', object: 'inc:2', role: 'accomplice', source: 'trace' }], now);
  assert.deepEqual(e.roles.map((r) => r.case), ['inc:2']);
});

test('worst flag wins; unknown accounts say so', () => {
  const e = resolve('a', [{ subject: 'a', predicate: 'flagged', object: 'medium', source: 'manual' }, { subject: 'a', predicate: 'flagged', object: 'critical', source: 'trace', evidence: 'drain' }]);
  assert.equal(e.flagged.severity, 'critical');
  const u = resolve('nobody.near', []);
  assert.equal(u.class, 'unknown');
  assert.equal(u.cuts_links, false);
});

test('one pass-through answer for the accounts the three lists disagree on', () => {
  for (const a of ['wrap.near', 'intents.near', 'aggregatedex.near', 'dex.intear.near', 'meteor-relayer.near', 'relay.aurora', 'near', 'system', 'v2.ref-finance.near', 'dclv2.ref-labs.near']) assert.equal(solve(a).pass_through, true, a);
  for (const a of ['alice.near', 'contract.main.burrow.near', 'nearlytrade.near']) assert.equal(solve(a).pass_through, false, a);
});

test('names: app users are people, solvers and relayers are services, exchange names are exchanges', () => {
  assert.equal(solve('bob.user.intear.near').class, 'person/app_user');
  assert.equal(solve('5115501476.tg').class, 'person/app_user');
  assert.equal(solve('solver-priv-liq.near').class, 'service/intents_solver');
  assert.equal(solve('foo-relayer.near').class, 'service/relayer');
  assert.equal(solve('binancecold3.near').top, 'exchange');
  assert.equal(solve('binancecold3.near').operator, 'org:binance');
  assert.equal(solve('ni-7.nearlytrade.near').class, 'contract/token');
});

test('KNOWN_ACTORS prefixes match implicit accounts only', () => {
  assert.equal(solve('51e8f94d' + '0'.repeat(56)).class, 'service/intents_solver');
  assert.equal(solve('9c484fa5' + 'a'.repeat(56)).top, 'exchange');
  assert.equal(solve('51e8f94d.near').class, 'unknown');
});

test('trusted dapps carry the trusted fact', () => {
  assert.equal(solve('contract.main.burrow.near').trusted, true);
  assert.equal(solve('alice.near').trusted, false);
});

test('fact checks', () => {
  assert.equal(invalid({ subject: 'a', predicate: 'is_a', object: 'exchange/hot_wallet', source: 'registry', by: 't' }), null);
  assert.match(invalid({ subject: 'a', predicate: 'is_a', object: 'exchange/hot', source: 'registry', by: 't' }), /unknown class/);
  assert.match(invalid({ subject: 'a', predicate: 'likes', object: 'b', source: 'registry', by: 't' }), /unknown predicate/);
  assert.match(invalid({ subject: 'a', predicate: 'label', object: 'b', source: 'gossip', by: 't' }), /unknown source/);
  assert.equal(factId({ subject: 'a', predicate: 'label', object: 'x', by: 't' }), factId({ subject: 'a', predicate: 'label', object: 'x', by: 't', source: 'manual' }));
});

test('classes', () => {
  assert.equal(fromAuditRole('lending'), 'contract/lending');
  assert.equal(fromAuditRole('account'), 'person/smart_wallet');
  assert.equal(fromAuditRole('unknown'), null);
  assert.equal(fromAuditRole('something_new'), 'contract/other');
  assert.equal(cutsLinks('person/wallet'), false);
  assert.equal(cutsLinks('exchange/hot_wallet'), true);
  assert.ok(isA('service/router', 'service') && !isA('service', 'service/router'));
});

test('shadow comparisons', () => {
  const ex = { class: 'exchange/hot_wallet', top: 'exchange', pass_through: false, cuts_links: true, flagged: null };
  const solver = { class: 'service/intents_solver', top: 'service', pass_through: false, cuts_links: true, flagged: null };
  const router = { class: 'service/router', top: 'service', pass_through: true, cuts_links: true, flagged: null };
  const unknown = { class: 'unknown', top: 'unknown', pass_through: false, cuts_links: false, flagged: null };
  assert.equal(compareIdentify('exchange')(ex).agree, true);
  assert.equal(compareIdentify('exchange')(solver).agree, false); // exactly the 2026-11-04 disagreement
  assert.equal(compareIdentify('contract')(router).agree, true);
  assert.equal(compareIdentify('wallet')(unknown).missing, true);
  assert.equal(comparePass(false)(router).agree, false);
  assert.equal(compareCuts(true)(solver).agree, true);
  assert.equal(compareFirewall({ severity: 'high', exchange: false })({ ...unknown, flagged: { severity: 'high' } }).agree, true);
});

test('golden set check', () => {
  const ents = new Map(GOLDEN.map(([a]) => [a, solve(a)]));
  const r = checkGolden(ents);
  assert.equal(r.length, GOLDEN.length);
  // without stored facts the code-level facts already get these right
  for (const a of ['intents.near', 'wrap.near', 'nearlytrade.near', 'meteor-relayer.near', '5115501476.tg', 'contract.main.burrow.near', 'near', 'solver-priv-liq.near']) assert.ok(r.find((x) => x.account === a).ok, a);
});

// ---- migration steps C-F: the ontology decides (ONTOLOGY_READ)

test('one pass-through rule: what the three old lists named, plus relayers and the system', () => {
  for (const a of ['wrap.near', 'intents.near', 'aggregatedex.near', 'v2.ref-finance.near', 'dclv2.ref-labs.near', 'dex.intear.near', 'meteor-relayer.near', 'relay.aurora', 'aurora', 'near', 'system']) assert.equal(passThrough(a), true, a);
  for (const a of ['alice.near', 'binancecold3.near', 'contract.main.burrow.near', 'solver-priv-liq.near', 'bob.tg']) assert.equal(passThrough(a), false, a);
});

test('grouping kinds from the ontology; no answer keeps the old rules', () => {
  assert.equal(groupingKind('bob.user.intear.near', 50), 'wallet'); // an app user is a person: links owners
  assert.equal(groupingKind('bob.tg', 20000), 'hub');               // ... unless it is busy like a hub
  assert.equal(groupingKind('intents.near'), 'intents');
  assert.equal(groupingKind('solver-priv-liq.near'), 'intents');
  assert.equal(groupingKind('meteor-relayer.near'), 'relayer');
  assert.equal(groupingKind('binancecold3.near'), 'hub');
  assert.equal(groupingKind('nearlytrade.near'), 'protocol');
  assert.equal(groupingKind('alice.near'), null);
  assert.equal(confident(classOf('alice.near')), false);
});

test('ONTOLOGY_READ switches modules; none is the rollback', () => {
  const was = config.ontology.read;
  setReads('pass_through,grouping'); assert.ok(reads('grouping') && !reads('tracer'));
  setReads('none'); assert.ok(!reads('pass_through'));
  setReads(was);
});

test('replay diff: same case, small price moves ignored, status changes reported', () => {
  const a = { status: 'confirmed', kind: 'exchange_drain', attacker: 'x', target: null, accounts: ['attacker:x'], sources: ['h:exchange'], exits: ['an exchange'], stolen_usd: 1000 };
  assert.deepEqual(diff(a, { ...a, stolen_usd: 1010 }), []);
  assert.deepEqual(diff(a, { ...a, status: 'suspected' }), ['status: confirmed → suspected']);
  assert.match(diff(a, { ...a, sources: ['h:service'] })[0], /^sources: −h:exchange \+h:service/);
});

test('the firewall hook passes compareFirewall(old), not the factory', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/firewall/context.js', import.meta.url), 'utf8');
  assert.match(src, /compareFirewall\(\{ severity/);
  const r = compareFirewall({ severity: 'critical', exchange: false })({ class: 'unknown', top: 'unknown', flagged: { severity: 'critical' } });
  assert.equal(r.agree, true);
});
