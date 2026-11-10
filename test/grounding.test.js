// Grounding checks (src/ai/tools/verify.js): an invented account or number in a write-up is caught; what the evidence has passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsIn, unverifiedAccounts, unverifiedNumbers, groundingReport } from '../src/ai/tools/verify.js';

const HEX = 'efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af';
const EV = { attacker: HEX, funders: ['binancecold3.near', 'x.trade.unrlzd.near'], stolen_usd: 1200000, exits: [{ usd: 45000, amount: 12410000 }], share: 0.05, multiple: 171.4 };

test('accountsIn finds named, sub-account, implicit and shortened ids', () => {
  const a = accountsIn(`Paid from Bob.near and x.trade.unrlzd.near, then ${HEX} and efd22425… (also a.tg).`);
  assert.deepEqual(a.sort(), [HEX, 'a.tg', 'bob.near', 'efd22425…', 'x.trade.unrlzd.near'].sort());
  assert.deepEqual(accountsIn('no accounts here. nearly.trade is not one'), []);
});

test('an invented account is caught; accounts from the evidence pass', () => {
  assert.deepEqual(unverifiedAccounts({ s: 'It went to fake-wallet.near' }, EV), ['fake-wallet.near']);
  assert.deepEqual(unverifiedAccounts({ s: 'It came from binancecold3.near' }, EV), []);
  assert.deepEqual(unverifiedAccounts({ s: `the attacker ${HEX}` }, EV), []);
});

test('a shortened id matches the evidence id with that prefix; a wrong prefix does not', () => {
  assert.deepEqual(unverifiedAccounts({ s: 'attacker efd22425…' }, EV), []);
  assert.deepEqual(unverifiedAccounts({ s: 'attacker 00000000…' }, EV), ['00000000…']);
});

test('a parent of an evidence account, and allow-listed accounts, pass', () => {
  assert.deepEqual(unverifiedAccounts({ s: 'a bot under trade.unrlzd.near' }, EV), []);
  assert.deepEqual(unverifiedAccounts({ s: 'swapped on wrap.near' }, EV, { allow: ['wrap.near'] }), []);
});

test('quantities with a unit: 6 % tolerance, M and k, percent vs fraction', () => {
  assert.deepEqual(unverifiedNumbers({ s: 'about 12.4M NEAR left' }, EV), []);
  assert.deepEqual(unverifiedNumbers({ s: 'about 30M NEAR left' }, EV), ['30M NEAR']);
  assert.deepEqual(unverifiedNumbers({ s: '5% of the supply' }, EV), []);
  assert.deepEqual(unverifiedNumbers({ s: '40% of the supply' }, EV), ['40%']);
  assert.deepEqual(unverifiedNumbers({ s: 'up 171x' }, EV), []);
  assert.deepEqual(unverifiedNumbers({ s: 'up 900x' }, EV), ['900x']);
  assert.deepEqual(unverifiedNumbers({ s: 'sent 3 NEAR' }, EV), []); // too small to check
});

test('groundingReport combines accounts, dollars and quantities', () => {
  assert.equal(groundingReport({ s: `$1.2M taken by ${HEX}` }, EV).ok, true);
  const r = groundingReport({ s: '$9,000,000 taken by ghost.near' }, EV);
  assert.equal(r.ok, false);
  assert.deepEqual(r.accounts, ['ghost.near']);
  assert.equal(r.amounts.length, 1);
});

// ---- the wrapper: ask again once, then keep the text and mark it
import { grounded } from '../src/ai/tools/grounding.js';
const ask = (answers) => { const seen = []; return { run: async (extra) => { seen.push(extra); return { json: { summary: answers[Math.min(seen.length - 1, answers.length - 1)] }, model: 'm' }; }, seen }; };

test('grounded: a clean first answer is kept, no retry', async () => {
  const a = ask([`taken by ${HEX}`]);
  const r = await grounded({ path: 't', evidence: EV, run: a.run });
  assert.equal(a.seen.length, 1); assert.equal(r.unverified, null);
});

test('grounded: an invented account is asked again once, with what to remove; the corrected answer wins', async () => {
  const a = ask(['taken by ghost.near', `taken by ${HEX}`]);
  const r = await grounded({ path: 't', evidence: EV, run: a.run });
  assert.equal(a.seen.length, 2); assert.match(a.seen[1], /not in the evidence.*ghost\.near/);
  assert.equal(r.unverified, null); assert.match(r.json.summary, new RegExp(HEX));
});

test('grounded: still invented after the retry → the text is kept and marked, with one retry only', async () => {
  const a = ask(['taken by ghost.near']);
  const r = await grounded({ path: 't', evidence: EV, run: a.run });
  assert.equal(a.seen.length, 2);
  assert.deepEqual(r.unverified.accounts, ['ghost.near']);
  assert.match(r.json.summary, /ghost\.near/);
});

test('grounded: a failed model call passes through untouched', async () => {
  const r = await grounded({ path: 't', evidence: EV, run: async () => ({ json: null }) });
  assert.equal(r.json, null);
});
