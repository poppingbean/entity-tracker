import test from 'node:test';
import assert from 'node:assert/strict';
import { allTx, loadTx } from './helpers/fixtures.js';
import { shrinkTx, fixtureDoc } from '../src/near/fixture.js';
import { tradesFromDecoded, tradesFromTxs } from '../src/collect/trades.js';
import { poolHit } from '../src/collect/launches.js';
import { adapters } from '../src/launchpads.js';
import { flowsOfTx } from '../src/incident/flows.js';
import { nftEventsOf } from '../src/nft/decode.js';

const TOK = 'blackdragon.tkn.near', W = 'wrap.near';
const NT = 'bonk-123456.nearlytrade.near';
const REFV2_POOL = { dex: 'refv2', poolId: 4276, quote: W };
const DEC = { dec: 24, qDec: 24, qPx: 1 };
const near = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();

test('every fixture decodes: hash, signer, millisecond timestamp, call / event / log arrays', () => {
  const names = allTx();
  assert.ok(names.length >= 15, `expected the minimum set of 15 fixtures, found ${names.length}`);
  const synthetic = [];
  for (const n of names) {
    const f = loadTx(n), d = f.decoded;
    assert.equal(f.name, n, `${n}: name matches the file`);
    assert.equal(typeof d.hash, 'string', n); assert.ok(d.hash.length > 30, `${n}: hash`);
    assert.equal(d.hash, f.hash, `${n}: stored hash is the transaction's`);
    assert.ok(d.signer, `${n}: signer`);
    assert.ok(Number.isFinite(d.ts) && d.ts > 1.5e12 && d.ts < 1e13, `${n}: ts is in milliseconds`);
    for (const k of ['calls', 'events', 'logs']) assert.ok(Array.isArray(d[k]), `${n}: ${k} is an array`);
    if (f.synthetic) synthetic.push(n);
  }
  if (synthetic.length) console.warn(`WARNING: ${synthetic.length} of ${names.length} fixtures are SYNTHETIC (hand-built, not captured): ${synthetic.join(', ')}`);
});

test('refv2-sell-wnear: the log tail ", total fee N, admin fee N" does not break the swap pattern', () => {
  const { trades, transfers } = tradesFromDecoded(TOK, REFV2_POOL, [loadTx('refv2-sell-wnear').decoded], DEC);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].buy, false); assert.equal(trades[0].trader, 'trader1.near');
  assert.equal(trades[0].near, 2.5); assert.equal(trades[0].tokens, 1);
  assert.equal(transfers.length, 0, 'the hand-off to the Ref contract is infrastructure, not a transfer');
});

test('refv2-buy-wnear: a buy with wNEAR', () => {
  const { trades } = tradesFromDecoded(TOK, REFV2_POOL, [loadTx('refv2-buy-wnear').decoded], DEC);
  assert.equal(trades.length, 1); assert.equal(trades[0].buy, true); assert.equal(trades[0].near, 2.5);
});

test('refv2-swap-msg-poolid: the pool id comes from the ft_transfer_call message', () => {
  const hit = poolHit('newcoin.tkn.near', [loadTx('refv2-swap-msg-poolid').decoded]);
  assert.deepEqual(hit.pool, { dex: 'refv2', poolId: 9999, quote: W });
});

test('dcl-swap: the swapper is the trader', () => {
  const { trades } = tradesFromDecoded(NT, { dex: 'dcl', poolId: `${NT}|${W}|10000`, quote: W }, [loadTx('dcl-swap').decoded], DEC);
  assert.equal(trades.length, 1); assert.equal(trades[0].trader, 'trader2.near'); assert.equal(trades[0].buy, true); assert.equal(trades[0].near, 3);
});

test('dcl-swap-via-aggregator: the trader is the transaction signer, not aggregatedex.near', () => {
  const { trades } = tradesFromDecoded(NT, { dex: 'dcl', poolId: `${NT}|${W}|10000`, quote: W }, [loadTx('dcl-swap-via-aggregator').decoded], DEC);
  assert.equal(trades.length, 1); assert.equal(trades[0].trader, 'trader3.near');
});

test('launch adapters read the launch events', () => {
  const nt = adapters.nearlytrade.parse(loadTx('launch-nearlytrade').decoded);
  assert.equal(nt.length, 1); assert.equal(nt[0].token, NT); assert.equal(nt[0].creator, 'creator1.near'); assert.deepEqual(nt[0].pool, { dex: 'dcl', poolId: `${NT}|${W}|10000`, quote: W });
  const jh = adapters.justhoot.parse(loadTx('launch-justhoot').decoded);
  assert.equal(jh.length, 1); assert.equal(jh[0].token, 'hoot-aaaa11.launchpad.justhoot.near'); assert.equal(jh[0].creator, 'creator2.near'); assert.equal(jh[0].symbol, 'HOOTT');
  assert.equal(jh[0].pool.dex, 'dcl'); assert.equal(jh[0].pool.quote, W); assert.equal(jh[0].devBuyNear, 1);
  const mc = adapters.memecooking.parse(loadTx('launch-memecooking').decoded);
  assert.equal(mc.length, 1); assert.equal(mc[0].token, 'cook-55.meme-cooking.near'); assert.deepEqual(mc[0].pool, { dex: 'refv2', poolId: 777, quote: W }); assert.equal(mc[0].liquidityNear, 10);
  const tk = adapters.tkn.parse(loadTx('launch-tkn').decoded);
  assert.equal(tk.length, 1); assert.equal(tk[0].token, 'doge.tkn.near'); assert.equal(tk[0].awaitingPool, true); assert.equal(tk[0].creator, 'creator3.near');
});

test('ft-transfer-wallet-to-wallet: one transfer, no trade', () => {
  const { trades, transfers } = tradesFromDecoded(NT, { dex: 'dcl', poolId: `${NT}|${W}|10000`, quote: W }, [loadTx('ft-transfer-wallet-to-wallet').decoded], DEC);
  assert.equal(trades.length, 0); assert.equal(transfers.length, 1);
  assert.deepEqual([transfers[0].from, transfers[0].to, transfers[0].tokens], ['alice.near', 'bob.near', 5000]);
});

test('flows: intents withdrawal, 1Click deposit address, large NEAR transfer', () => {
  const w = flowsOfTx(loadTx('intents-native-withdraw').raw).filter((f) => f.kind === 'intents_out');
  assert.equal(w.length, 1); assert.equal(w[0].to, 'bob.near'); assert.equal(w[0].raw, near(5));
  const dep = 'd3'.repeat(32);
  const o = flowsOfTx(loadTx('oneclick-deposit').raw);
  assert.equal(o.length, 1); assert.equal(o[0].to, dep); assert.equal(o[0].raw, '1000000'); assert.match(o[0].to, /^[0-9a-f]{64}$/);
  const n = flowsOfTx(loadTx('near-transfer-large').raw);
  assert.equal(n.length, 1); assert.equal(n[0].token, 'near'); assert.equal(n[0].raw, '8091108600000000000000000000000'); assert.equal(n[0].from, 'hotwallet.near');
});

test('failed-tx: failed, and no flow (the plain "Transfer" log of a failed receipt moves nothing)', () => {
  const f = loadTx('failed-tx');
  assert.equal(f.decoded.failed, true); assert.deepEqual(flowsOfTx(f.raw), []);
  assert.deepEqual(tradesFromDecoded(NT, { dex: 'dcl', poolId: `${NT}|${W}|10000`, quote: W }, [f.decoded], DEC), { trades: [], transfers: [] });
});

test('nft-transfer: NEP-171 transfer decoded', () => {
  const ev = nftEventsOf(loadTx('nft-transfer').decoded, 'nft.collection.near');
  assert.equal(ev.length, 1); assert.deepEqual([ev[0].kind, ev[0].from, ev[0].to, ev[0].token_ids], ['transfer', 'alice.near', 'bob.near', ['42']]);
});

test('tradesFromTxs (reads decimals and price) gives the same output as tradesFromDecoded with the same inputs', async () => {
  const real = globalThis.fetch;
  // decimals() asks the RPC for ft_metadata: answer 24 for every token, offline
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: { result: [...Buffer.from(JSON.stringify({ decimals: 24 }))] } }) });
  try {
    const txs = ['refv2-sell-wnear', 'refv2-buy-wnear'].map((n) => loadTx(n).decoded);
    assert.deepEqual(await tradesFromTxs(TOK, REFV2_POOL, txs), tradesFromDecoded(TOK, REFV2_POOL, txs, DEC));
  } finally { globalThis.fetch = real; }
});

test('shrinkTx: long DeployContract code is replaced everywhere, nothing else changes, input untouched', () => {
  const long = 'A'.repeat(5000), short = 'B'.repeat(100);
  const t = { transaction: { hash: 'H', actions: [{ DeployContract: { code: long } }, { DeployContract: { code: short } }, { Transfer: { deposit: '1' } }] },
    receipts: [{ receipt: { receipt: { Action: { actions: [{ DeployContract: { code: long } }] } } } }] };
  const copy = JSON.parse(JSON.stringify(t));
  const s = shrinkTx(t);
  assert.equal(s.transaction.actions[0].DeployContract.code, '<omitted 5000 chars>');
  assert.equal(s.transaction.actions[1].DeployContract.code, short, 'short code kept');
  assert.deepEqual(s.transaction.actions[2], { Transfer: { deposit: '1' } });
  assert.equal(s.receipts[0].receipt.receipt.Action.actions[0].DeployContract.code, '<omitted 5000 chars>');
  assert.deepEqual(t, copy, 'the input is not modified');
  assert.deepEqual(shrinkTx({ a: [1, 'x', null] }), { a: [1, 'x', null] });
});

test('fixtureDoc: shape, name check, hash required', () => {
  const t = { transaction: { hash: 'H1', actions: [] }, receipts: [] };
  assert.deepEqual(fixtureDoc({ name: 'x-1', note: 'n', tx: t, captured_ts: 5 }), { name: 'x-1', note: 'n', hash: 'H1', captured_ts: 5, synthetic: false, tx: t });
  assert.throws(() => fixtureDoc({ name: '../evil', tx: t, captured_ts: 1 }), /name/);
  assert.throws(() => fixtureDoc({ name: 'ok', tx: {}, captured_ts: 1 }), /hash/);
});
