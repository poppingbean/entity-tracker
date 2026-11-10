// Holder candidates (src/analysis/holders.js): traders, transfer-only holders, the creator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { holderCandidates, transferOnlyNote } from '../src/analysis/holders.js';

const traders = new Map([['buyer', { account: 'buyer', buy_tokens: 1000, sell_tokens: 200 }], ['flipper', { account: 'flipper', buy_tokens: 500, sell_tokens: 500 }], ['router.near', { account: 'router.near', buy_tokens: 9999, sell_tokens: 0 }]]);
const skip = (a) => a === 'router.near';
test('a wallet that only received a transfer is a candidate, marked via transfers', () => {
  const c = holderCandidates(traders, [{ from: 'creator', to: 'dumper', tokens: 5000 }], { creator: 'creator', skip });
  const by = Object.fromEntries(c.map((x) => [x.account, x]));
  assert.deepEqual([by.dumper.est_tokens, by.dumper.via], [5000, 'transfers']);
  assert.equal(by.buyer.via, 'trades'); assert.equal(by.buyer.est_tokens, 800);
  assert.equal(by.creator.est_tokens, -5000, 'the creator is always listed (the dev buy is not in the trades)');
  assert.equal(by['router.near'], undefined, 'infrastructure is skipped'); assert.equal(by.flipper, undefined, 'a zero balance is not a holder');
  assert.equal(c[0].account, 'dumper', 'largest first');
});
test('trades and transfers add up; via both', () => {
  const c = holderCandidates(traders, [{ from: 'x', to: 'buyer', tokens: 200 }, { from: 'buyer', to: 'y', tokens: 50 }]);
  assert.deepEqual(c.find((x) => x.account === 'buyer'), { account: 'buyer', est_tokens: 950, via: 'both' });
});
test('risk note: a top holder that never traded and got its tokens from the creator or an early buyer', () => {
  const rows = [{ account: 'dumper', via: 'transfers' }, { account: 'buyer', via: 'trades' }];
  assert.match(transferOnlyNote(rows, [{ from: 'creator', to: 'dumper', tokens: 1 }], { creator: 'creator' }), /^1 of the 10 largest holders never traded/);
  assert.equal(transferOnlyNote(rows, [{ from: 'stranger', to: 'dumper', tokens: 1 }], { creator: 'creator' }), null);
});
