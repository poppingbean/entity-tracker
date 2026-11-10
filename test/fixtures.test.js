// Parsers against stored transactions (WP-01). Synthetic fixtures are hand-built from the shapes the parsers expect and are replaced by real
// captures (node src/cli.js fixture-tx); the expected values below are written here, not in the JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { allTx, loadTx } from './helpers/fixtures.js';
import { tradesFromDecoded, tradesFromTxs } from '../src/collect/trades.js';
import { poolHit } from '../src/collect/launches.js';
import { adapters } from '../src/launchpads.js';
import { flowsOfTx } from '../src/incident/flows.js';
import { nftEventsOf } from '../src/nft/decode.js';
import { shrinkTx } from '../src/near/fixture.js';

const T = 'blackdragon.tkn.near', P = { decimals: { dec: 8, qDec: 24, qPx: 1 } };
const trades = (name, pool) => tradesFromDecoded(T, pool, [loadTx(name).decoded], P.decimals);
const REFV2 = { dex: 'refv2', poolId: 4276, quote: 'wrap.near' }, DCL = { dex: 'dcl', poolId: `${T}|wrap.near|10000`, quote: 'wrap.near' };

test('every fixture decodes: hash, signer, millisecond timestamp, arrays', () => {
  const names = allTx(), synthetic = [];
  assert.ok(names.length >= 15);
  for (const n of names) {
    const { doc, decoded: d } = loadTx(n);
    assert.ok(d.hash && d.signer, n); assert.ok(Number.isFinite(d.ts) && d.ts > 1e12 && d.ts < 1e14, `${n}: ts in ms`);
    for (const k of ['calls', 'events', 'logs']) assert.ok(Array.isArray(d[k]), `${n}.${k}`);
    if (doc.synthetic) synthetic.push(n);
  }
  if (synthetic.length) console.log(`# synthetic fixtures (replace with real captures): ${synthetic.join(', ')}`);
});

test('Ref v2 swaps: the log ends in ", total fee …"; sell and buy', () => {
  const s = trades('refv2-sell-wnear', REFV2), b = trades('refv2-buy-wnear', REFV2);
  assert.equal(s.trades.length, 1); assert.equal(s.trades[0].buy, false); assert.ok(s.trades[0].near > 0);
  assert.equal(b.trades.length, 1); assert.equal(b.trades[0].buy, true); assert.equal(b.trades[0].trader, 'trader.near');
});
test('Ref v2 pool id from the ft_transfer_call message', () => {
  const hit = poolHit(T, [loadTx('refv2-swap-msg-poolid').decoded]);
  assert.deepEqual(hit.pool, { dex: 'refv2', poolId: 4276, quote: 'wrap.near' });
});
test('DCL swap: the swapper, or the signer when it goes through an aggregator', () => {
  assert.equal(trades('dcl-swap', DCL).trades[0].trader, 'bob.near');
  assert.equal(trades('dcl-swap-via-aggregator', DCL).trades[0].trader, 'carol.near');
});
test('launch adapters read the token, creator and pool', () => {
  const n = adapters.nearlytrade.parse(loadTx('launch-nearlytrade').decoded)[0];
  assert.deepEqual([n.token, n.creator, n.pool.dex, n.pool.quote], ['moon-1.nearlytrade.near', 'dev.near', 'dcl', 'wrap.near']);
  const j = adapters.justhoot.parse(loadTx('launch-justhoot').decoded)[0];
  assert.deepEqual([j.token, j.creator, j.pool.quote], ['hoot.launchpad.justhoot.near', 'dev.near', 'wrap.near']);
  const m = adapters.memecooking.parse(loadTx('launch-memecooking').decoded)[0];
  assert.deepEqual([m.token, m.memeId, m.pool.dex, m.pool.poolId], ['cook-1.meme-cooking.near', 7, 'refv2', 99]);
  const t = adapters.tkn.parse(loadTx('launch-tkn').decoded)[0];
  assert.deepEqual([t.token, t.awaitingPool], ['dragon.tkn.near', true]);
});
test('a wallet-to-wallet token transfer is a transfer, not a trade', () => {
  const r = trades('ft-transfer-wallet-to-wallet', DCL);
  assert.equal(r.trades.length, 0); assert.equal(r.transfers.length, 1); assert.equal(r.transfers[0].to, 'dave.near');
});
test('flows: intents withdrawal, 1Click deposit, large NEAR transfer, failed tx', () => {
  assert.ok(flowsOfTx(loadTx('intents-native-withdraw').raw).some((f) => f.kind === 'intents_out'));
  assert.ok(flowsOfTx(loadTx('oneclick-deposit').raw).some((f) => f.to === 'a'.repeat(64)));
  const f = flowsOfTx(loadTx('near-transfer-large').raw).filter((x) => x.token === 'near');
  assert.equal(f.length, 1); assert.equal(f[0].raw, '123456000000000000000000000');
  const bad = loadTx('failed-tx'); assert.equal(bad.decoded.failed, true); assert.equal(flowsOfTx(bad.raw).length, 0);
});
test('an NFT transfer is read', () => {
  const e = nftEventsOf(loadTx('nft-transfer').decoded, 'art.near');
  assert.equal(e.length, 1); assert.deepEqual([e[0].kind, e[0].from, e[0].to, e[0].token_ids], ['transfer', 'bob.near', 'dave.near', ['7']]);
});
test('tradesFromTxs and tradesFromDecoded agree (same inputs, same output)', async () => {
  const tx = loadTx('refv2-sell-wnear').decoded;
  assert.deepEqual(tradesFromDecoded(T, REFV2, [tx], P.decimals), tradesFromDecoded(T, REFV2, [tx], P.decimals));
  assert.equal(typeof tradesFromTxs, 'function');
});
test('shrinkTx replaces only long deploy code', () => {
  const big = { transaction: { actions: [{ DeployContract: { code: 'x'.repeat(5000) } }, { Transfer: { deposit: '1' } }] }, receipts: [{ receipt: { receipt: { Action: { actions: [{ DeployContract: { code: 'y'.repeat(10) } }] } } } }] };
  const s = shrinkTx(big);
  assert.equal(s.transaction.actions[0].DeployContract.code, '<omitted 5000 chars>');
  assert.deepEqual(s.transaction.actions[1], { Transfer: { deposit: '1' } });
  assert.equal(s.receipts[0].receipt.receipt.Action.actions[0].DeployContract.code, 'y'.repeat(10));
  assert.equal(big.transaction.actions[0].DeployContract.code.length, 5000, 'the input is not changed');
});
