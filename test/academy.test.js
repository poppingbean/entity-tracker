// Safe Near Academy (src/academy): the task format, the scorers, the split, anonymising, balancing, and the two generators' pure parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitOf, taskId, publicTask, revealed, setScore, scoreAnswer, nextLevel, anonymize, balance, brier, examSet, PASS } from '../src/academy/tasks.js';
import { outcomeClass, levelOf, snapshotOf, rugKindOf, groupedBuyers } from '../src/academy/memecoin.js';
import { powerfulMethods, openMethods, userPowerMethods, callingMethods, controlClass, originClass, contractTasks, upgradeTask, answerKey } from '../src/academy/contracts.js';
import { baselines, checkAgent } from '../src/academy/service.js';

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

test('contract tasks: the levels from one code, ids stable, the account named, no answer in the input', () => {
  const ts = contractTasks(CODE, 'tok.near');
  assert.deepEqual(ts.map((t) => [t.level, t.kind]), [[1, 'type'], [2, 'powers'], [2, 'calls'], [3, 'open_doors'], [4, 'user_powers']]);
  assert.deepEqual(ts[0].gold, { class: 'token', set: ['nep141', 'nep145'] });
  assert.deepEqual(ts[3].gold, { set: ['sweep'] });
  assert.deepEqual(ts[3].input.powerful_methods, ['sweep', 'upgrade', 'withdraw']);
  assert.ok(ts.every((t) => t.input.account === 'tok.near' && !JSON.stringify(publicTask(t)).includes('reads_caller')));
  assert.deepEqual(contractTasks(CODE, 'tok.near').map((t) => t._id), ts.map((t) => t._id));
  // an AI-typed or unknown contract gets no type task; one with no powerful method gets no open-doors task
  const plain = { ...CODE, role_source: 'ai', capabilities: { ft_transfer: { caps: ['reads_caller'] } }, powers: [] };
  assert.deepEqual(contractTasks(plain, 'p.near').map((t) => t.kind), ['powers', 'calls', 'user_powers']);
});

test('all the tasks of one contract share a split (a level-3 task carries the level-2 answer)', () => {
  for (let i = 0; i < 40; i++) assert.equal(new Set(contractTasks({ ...CODE, _id: `code:${i}` }, 'tok.near').map((t) => t.split)).size, 1);
});

test('odds are scored by Brier: sure and right is 1, a uniform guess does not pass, sure and wrong is 0', () => {
  const L = ['real', 'rug', 'dud'];
  assert.equal(brier({ rug: 1 }, 'rug', L).score, 1);
  assert.equal(brier({ real: 1 }, 'rug', L).score, 0);
  const u = brier({ real: 1, rug: 1, dud: 1 }, 'rug', L).score; // weights are normalised
  assert.ok(u > 0.66 && u < PASS, `uniform ${u}`);
  assert.throws(() => brier({ rug: -1 }, 'rug', L));
  const t = { answer_format: { type: 'class' }, options: { real: '', rug: '', dud: '' }, gold: { class: 'dud' } };
  assert.equal(scoreAnswer(t, { probs: { dud: 0.8, rug: 0.2 } }).score, 0.96);
});

test('a "sets" answer is the mean F1 of its parts; an empty list is right where nothing changed', () => {
  const t = { answer_format: { type: 'sets', parts: ['added_methods', 'removed_methods', 'added_powers'] }, gold: { added_methods: ['set_fee'], removed_methods: [], added_powers: ['set_fees'] } };
  assert.equal(scoreAnswer(t, { added_methods: ['set_fee'], removed_methods: [], added_powers: ['set_fees'] }).score, 1);
  assert.equal(scoreAnswer(t, { added_methods: ['set_fee'], removed_methods: [], added_powers: [] }).score, 0.667);
  assert.equal(scoreAnswer(t, {}).score, 0.333);
});

test('the exam is the same set for everyone, at most N per level', () => {
  const ts = Array.from({ length: 40 }, (_, i) => ({ _id: `t${i}`, level: 1 + (i % 3) }));
  const e = examSet(ts, 5);
  assert.equal(e.length, 15);
  assert.deepEqual(examSet([...ts].reverse(), 5).map((t) => t._id), e.map((t) => t._id));
  assert.deepEqual([...new Set(e.map((t) => t.level))], [1, 2, 3]);
});

test('a task shows how many agents answered it once someone has', () => {
  const t = { _id: 'x', track: 'memecoins', level: 1, kind: 'outcome', question: 'q', input: {}, answer_format: { type: 'class' }, split: 'train' };
  assert.equal(publicTask(t).solved_by, undefined);
  assert.deepEqual(publicTask(t, { answered: 4, passed: 1 }).solved_by, { agents: 4, pass_rate: 0.25 });
});

test('contract facts: calls to other contracts, who controls it, where its code comes from', () => {
  const code = { exports: ['swap', 'view'], capabilities: { swap: { caps: ['call_contracts'] }, internal: { caps: ['call_contracts'] }, view: { caps: [] } } };
  assert.deepEqual(callingMethods(code), ['swap']); // only exported methods
  assert.equal(controlClass({ summary: 'locked (no keys, no owner found)' }), 'locked');
  assert.equal(controlClass({ summary: 'owner: dao' }), 'dao');
  assert.equal(controlClass({ summary: 'owner: locked' }), 'locked_contract');
  assert.equal(controlClass({ summary: 'owner: contract / locked' }), 'contract');
  assert.equal(controlClass({ summary: '1 full-access key' }), 'full_access_key');
  assert.equal(controlClass({ summary: 'something else' }), null);
  assert.equal(originClass('meme-cooking', 400), 'meme-cooking');
  assert.equal(originClass(null, 5), 'copy');
  assert.equal(originClass(null, 1), 'own');
  assert.equal(originClass(null, 2), null);
});

test('contract tasks: origin and control come with the audit; a launchpad template is named', () => {
  const ts = contractTasks(CODE, 'tok.near', { audit: { auto: { family_n: 300, control: { summary: 'owner: wallet', full_keys: 0, keys_total: 0, controllers: [{ account: 'boss.near', kind: 'wallet', via: 'STATE' }] } } }, launchpad: 'justhoot', launchpads: ['justhoot', 'meme-cooking'] });
  const o = ts.find((t) => t.kind === 'origin'), c = ts.find((t) => t.kind === 'control');
  assert.equal(o.gold.class, 'justhoot'); assert.ok(o.options.justhoot && o.options.copy && o.options.own);
  assert.equal(c.gold.class, 'wallet'); assert.match(c.rationale, /boss\.near/);
  assert.ok(!JSON.stringify(publicTask(c)).includes('boss.near'), 'the controller is the answer, never in the task');
});

test('an upgrade task: added and removed methods, the powers gained, the block to read the old code at', () => {
  const t = upgradeTask('x.near', { from: 'code:a', to: 'code:b', ts: 1e12, added_powers: ['set_fees'], removed_powers: [] }, { exports: ['a', 'b'] }, { exports: ['b', 'c'] }, { height: 100 });
  assert.deepEqual(t.gold, { added_methods: ['c'], removed_methods: ['a'], added_powers: ['set_fees'] });
  assert.equal(t.level, 5); assert.equal(t.input.new_code_deployed_at_block, 100); assert.match(t.input.how_to_read_the_code, /block_id 99/);
  assert.equal(answerKey(t), t._id);
  const same = upgradeTask('x.near', { from: 'code:a', to: 'code:b', ts: 1e12 }, { exports: ['a'] }, { exports: ['a'] });
  assert.equal(answerKey(same), 'none');
});

test('memecoin investigations: the rug kind taught, and which buyers are grouped', () => {
  assert.equal(rugKindOf(['flagged', 'creator_exit']), 'creator_exit');
  assert.equal(rugKindOf(['creator_sold']), null);
  const clusterOf = new Map([['a', 'g1'], ['b', 'g1'], ['c', 'g2'], ['dev', 'g3'], ['d', 'g3']]);
  // a and b share a group; d shares the creator's; c is alone; e was funded by the creator
  assert.deepEqual(groupedBuyers(['a', 'b', 'c', 'd', 'e'], 'dev', clusterOf, ['e']), ['a', 'b', 'd', 'e']);
  assert.deepEqual(groupedBuyers(['c', 'x'], null, clusterOf), []);
});

test('the snapshot never shows the symbols of the creator\'s earlier rugs, or a dropped field', () => {
  const s = snapshotOf({ intel: { creator_prior_launches: 4, creator_prior_rug_symbols: ['OLD'] }, wallets: { topBuyers: [{ account: 'a.near', linked: true }] } }, { drop: /^linked$/ });
  assert.deepEqual(s, { intel: { creator_prior_launches: 4 }, wallets: { topBuyers: [{ account: 'W1' }] } });
});

test('baselines: the gates as odds, and the commonest answer every time', () => {
  const L = { real: '', rug: '', dud: '' };
  const mk = (cls, pass, i) => ({ _id: `m${i}`, track: 'memecoins', kind: 'outcome', split: 'test', answer_format: { type: 'class' }, options: L, gold: { class: cls }, meta: { gate_pass: pass } });
  const b = baselines([mk('real', true, 1), mk('rug', false, 2), mk('dud', false, 3), mk('rug', true, 4), { ...mk('rug', false, 5), split: 'train' }]);
  const g = b.memecoins.find((x) => x.agent === 'safe-near-gates');
  assert.equal(g.tasks, 4);
  assert.equal(g.exam_score, 0.625); // 1, 0.75, 0.75, and 0 for the rug the gates passed (sure and wrong)
  assert.equal(b.memecoins.find((x) => x.agent === 'always-the-commonest-answer').exam_score, 0.5);
  assert.equal(b.contracts, undefined);
});

test('agent names: the baselines\' names are reserved', () => {
  assert.equal(checkAgent('My-Auditor.near'), 'my-auditor.near');
  assert.throws(() => checkAgent('safe-near-gates'), /baseline/);
  assert.throws(() => checkAgent('Always-The-Commonest-Answer'), /baseline/);
  assert.throws(() => checkAgent('x'));
});
