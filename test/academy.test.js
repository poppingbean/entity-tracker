// Safe Near Academy (src/academy): the task format, the scorers, the split, anonymising, balancing, and the two generators' pure parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitOf, taskId, publicTask, revealed, setScore, scoreAnswer, nextLevel, anonymize, balance, PASS } from '../src/academy/tasks.js';
import { outcomeClass, levelOf, snapshotOf } from '../src/academy/memecoin.js';
import { powerfulMethods, openMethods, userPowerMethods, contractTasks } from '../src/academy/contracts.js';

test('the split is stable and about one in five is a test task', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => taskId('memecoins', 'outcome', `t${i}`));
  assert.deepEqual(ids.map(splitOf), ids.map(splitOf));
  const share = ids.filter((id) => splitOf(id) === 'test').length / ids.length;
  assert.ok(share > 0.15 && share < 0.25, `test share ${share}`);
  assert.match(ids[0], /^memecoins:outcome:[0-9a-f]{16}$/);
});

test('an agent never sees the answer, the reason or the references before answering', () => {
  const t = { _id: 'x', track: 'contracts', level: 2, kind: 'powers', question: 'q', input: { account: 'a.near' }, answer_format: { type: 'set' }, gold: { set: ['w'] }, rationale: 'r', label_source: 's', refs: { code: 'c' }, split: 'train', meta: { m: 1 } };
  const p = publicTask(t);
  for (const k of ['gold', 'rationale', 'refs', 'label_source', 'meta']) assert.equal(p[k], undefined, k);
  assert.deepEqual(revealed(t).answer, { set: ['w'] });
});

test('set answers are scored by F1, both empty is right, names are case-insensitive', () => {
  assert.equal(setScore([], []).score, 1);
  assert.equal(setScore(['a'], []).score, 0);
  assert.equal(setScore(['A', 'b'], ['a', 'b']).score, 1);
  const s = setScore(['a', 'c'], ['a', 'b']);
  assert.equal(s.score, 0.5); assert.deepEqual(s.missed, ['b']); assert.deepEqual(s.extra, ['c']);
  assert.equal(setScore('a, b', ['a', 'b']).score, 1); // a comma list is read as a set
});

test('scoreAnswer reads each answer format and its common shapes', () => {
  const cls = { answer_format: { type: 'class' }, gold: { class: 'rug' } };
  assert.equal(scoreAnswer(cls, 'Rug').score, 1);
  assert.equal(scoreAnswer(cls, { class: 'rug' }).score, 1);
  assert.equal(scoreAnswer(cls, { answer: 'real' }).score, 0);
  const set = { answer_format: { type: 'set' }, gold: { set: ['withdraw'] } };
  assert.equal(scoreAnswer(set, { set: ['withdraw'] }).score, 1);
  assert.equal(scoreAnswer(set, ['withdraw']).score, 1);
  assert.equal(scoreAnswer(set, { methods: [] }).score, 0);
  const both = { answer_format: { type: 'class+set' }, gold: { class: 'token', set: ['141', '145'] } };
  assert.equal(scoreAnswer(both, { class: 'token', set: ['141', '145'] }).score, 1);
  assert.equal(scoreAnswer(both, { class: 'nft', set: ['141', '145'] }).score, 0.5);
  assert.throws(() => scoreAnswer({ answer_format: { type: 'essay' } }, 'x'));
});

test('levelling up needs 10 answers at the level with 70% passed, and stops at the top', () => {
  const at = (n, pass) => Array.from({ length: n }, (_, i) => ({ score: i < pass ? 1 : 0 }));
  assert.equal(nextLevel(1, at(9, 9), 4), 1);
  assert.equal(nextLevel(1, at(10, 7), 4), 2);
  assert.equal(nextLevel(1, at(10, 6), 4), 1);
  assert.equal(nextLevel(4, at(20, 20), 4), 4);
  assert.equal(PASS, 0.7);
});

test('anonymize replaces accounts with stable placeholders and keeps infrastructure named', () => {
  const out = anonymize({ token: 'meme.v2-launchpad.justhoot.near', by: 'bob.near', buyers: ['a'.repeat(64), 'bob.near', 'carol.tg'], via: 'wrap.near', note: 'sold by bob.near to wrap.near', n: 5 },
    { token: 'meme.v2-launchpad.justhoot.near', creator: 'bob.near' });
  assert.deepEqual(out, { token: 'TOKEN', by: 'CREATOR', buyers: ['W1', 'CREATOR', 'W2'], via: 'wrap.near', note: 'sold by CREATOR to wrap.near', n: 5 });
});

test('balance: no single answer may be more than half a level, the same tasks are kept every time', () => {
  const mk = (cls, i) => ({ _id: `${cls}${i}`, track: 'memecoins', kind: 'outcome', level: 1, gold: { class: cls } });
  const tasks = [...Array.from({ length: 50 }, (_, i) => mk('rug', i)), ...Array.from({ length: 10 }, (_, i) => mk('real', i)), ...Array.from({ length: 5 }, (_, i) => mk('dud', i))];
  const kept = balance(tasks, (t) => t.gold.class);
  assert.equal(kept.filter((t) => t.gold.class === 'rug').length, 15);
  assert.equal(kept.length, 30);
  assert.deepEqual(balance(tasks, (t) => t.gold.class).map((t) => t._id), kept.map((t) => t._id));
  // levels are balanced apart
  const other = tasks.map((t) => ({ ...t, level: 2, _id: `L2${t._id}` }));
  assert.equal(balance([...tasks, ...other], (t) => t.gold.class).length, 60);
});

test('memecoin outcome classes: a doubling is real; a hard rug with no way out is a rug; the rest is a dud', () => {
  assert.equal(outcomeClass({ maxUp: 2.5, rugged: true, rugKinds: ['lp_pulled'] }), 'real');
  assert.equal(outcomeClass({ maxUp: 1.1, rugged: true, rugKinds: ['lp_pulled'] }), 'rug');
  assert.equal(outcomeClass({ maxUp: 1.1, rugged: true, rugKinds: ['creator_sold'] }), 'dud'); // the creator selling some is not a rug by itself
  assert.equal(outcomeClass({ maxUp: 1.5, rugged: true, rugKinds: ['lp_pulled'] }), 'dud');   // a buyer could get out ahead
  assert.equal(outcomeClass({ maxUp: 1, rugged: false }), 'dud');
});

test('memecoin levels: a rug that passed the gates or a winner they blocked is level 3', () => {
  const strong = { pool: { nearReserve: 200 }, trading: { uniqueBuyers: 30 } };
  assert.equal(levelOf('rug', strong, true), 3);
  assert.equal(levelOf('real', strong, false), 3);
  assert.equal(levelOf('dud', strong, true), 2);
  assert.equal(levelOf('real', strong, true), 1);
  assert.equal(levelOf('rug', { pool: { nearReserve: 5 }, trading: {} }, false), 1);
  assert.equal(levelOf('rug', { pool: { nearReserve: 80 }, trading: { creatorSold: false } }, false), 2);
});

test('a memecoin snapshot hides names, symbols, hashes, times and accounts, also inside free text', () => {
  const f = { token: 'zz.meme-cooking.near', symbol: 'ZZTOP', name: 'Zz Top', codeHash: 'h', created_ts: 1, pool: { nearReserve: 3 },
    audit: { headline: 'ZZTOP is a token; $zztop by Zz Top', quoteSymbol: 'wNEAR' }, launch: { creator: 'dev.near' }, wallets: [{ id: 'x.near' }] };
  const s = snapshotOf(f, { token: f.token, creator: 'dev.near' });
  assert.deepEqual(s, { pool: { nearReserve: 3 }, audit: { headline: 'TOKEN is a token; TOKEN by TOKEN', quoteSymbol: 'wNEAR' }, launch: { creator: 'CREATOR' }, wallets: [{ id: 'W1' }] });
  // a token called NEAR does not erase the chain's name from the text
  assert.equal(snapshotOf({ symbol: 'NEAR', note: 'paid in NEAR' }).note, 'paid in NEAR');
});

const CODE = {
  _id: 'code:abc', role: 'token', role_source: 'rules', label: 'Fungible token', standards: ['nep141', 'nep145'],
  exports: ['ft_transfer', 'withdraw', 'sweep', 'upgrade', 'set_blacklisted'],
  capabilities: { withdraw: { caps: ['send_near', 'reads_caller'] }, sweep: { caps: ['send_near'] }, upgrade: { caps: ['deploy_code', 'reads_caller'] }, ft_transfer: { caps: ['reads_caller', 'generic_promise'] } },
  powers: [{ power: 'upgrade', severity: 'high', label: 'Can replace the code', methods: ['upgrade'] }, { power: 'freeze', severity: 'medium', label: 'Can blacklist', methods: ['set_blacklisted'] }, { power: 'set_fees', severity: 'low', methods: ['set_fee'] }],
};

test('contract facts: powerful methods, the open ones, and powers over users', () => {
  assert.deepEqual(powerfulMethods(CODE), ['sweep', 'upgrade', 'withdraw']);
  assert.deepEqual(openMethods(CODE), ['sweep']);
  assert.deepEqual(userPowerMethods(CODE), ['set_blacklisted', 'upgrade']); // the low-severity fee power is left out
});

test('contract tasks: four levels from one code, ids stable, the account named, no answer in the input', () => {
  const ts = contractTasks(CODE, 'tok.near');
  assert.deepEqual(ts.map((t) => [t.level, t.kind]), [[1, 'type'], [2, 'powers'], [3, 'open_doors'], [4, 'user_powers']]);
  assert.deepEqual(ts[0].gold, { class: 'token', set: ['nep141', 'nep145'] });
  assert.deepEqual(ts[2].gold, { set: ['sweep'] });
  assert.deepEqual(ts[2].input.powerful_methods, ['sweep', 'upgrade', 'withdraw']);
  assert.ok(ts.every((t) => t.input.account === 'tok.near' && !JSON.stringify(publicTask(t)).includes('reads_caller')));
  assert.deepEqual(contractTasks(CODE, 'tok.near').map((t) => t._id), ts.map((t) => t._id));
  // an AI-typed or unknown contract gets no type task; one with no powerful method gets no open-doors task
  const plain = { ...CODE, role_source: 'ai', capabilities: { ft_transfer: { caps: ['reads_caller'] } }, powers: [] };
  assert.deepEqual(contractTasks(plain, 'p.near').map((t) => t.kind), ['powers', 'user_powers']);
});

test('all the tasks of one contract share a split (a level-3 task carries the level-2 answer)', () => {
  for (let i = 0; i < 40; i++) assert.equal(new Set(contractTasks({ ...CODE, _id: `code:${i}` }, 'tok.near').map((t) => t.split)).size, 1);
});
