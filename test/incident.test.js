import test from 'node:test';
import assert from 'node:assert/strict';
import { flowsOfReceipt, netOf } from '../src/incident/flows.js';
import { assetChain } from '../src/incident/oneclick.js';
import { unverifiedAmounts } from '../src/incident/ai.js';
import { protocolOutflows } from '../src/incident/detect.js';
import { parseInvestigation } from '../src/incident/service.js';

const receipt = (pred, recv, logs, actions = [{ FunctionCall: { method_name: 'ft_transfer' } }], failed = false) => ({
  receipt: { receipt_id: 'r', predecessor_id: pred, receiver_id: recv, receipt: { Action: { signer_id: 'x.near', actions } } },
  execution_outcome: { block_height: 1, outcome: { logs, status: failed ? { Failure: {} } : { SuccessValue: '' } } },
});

test('flows: NEP-141 events, the old "Transfer" log, NEAR, intents withdrawals; failed receipts and gas refunds ignored', () => {
  const nep = receipt('veax.near', 'token.0xshitzu.near', ['EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"veax.near","new_owner_id":"evil.near","amount":"300"}]}']);
  assert.deepEqual(flowsOfReceipt(nep).map((f) => [f.token, f.from, f.to, f.raw]), [['token.0xshitzu.near', 'veax.near', 'evil.near', '300']]);
  const legacy = receipt('veax.near', 'wrap.near', ['Transfer 11889 from veax.near to evil.near']);
  assert.deepEqual(flowsOfReceipt(legacy).map((f) => [f.token, f.from, f.to, f.raw]), [['wrap.near', 'veax.near', 'evil.near', '11889']]);
  const near = receipt('evil.near', 'cash.near', [], [{ Transfer: { deposit: '377000000000000000000000000' } }]);
  assert.equal(flowsOfReceipt(near)[0].token, 'near');
  assert.equal(flowsOfReceipt(receipt('system', 'evil.near', [], [{ Transfer: { deposit: '5' } }])).length, 0, 'gas refund');
  assert.equal(flowsOfReceipt(receipt('veax.near', 'wrap.near', ['Transfer 5 from veax.near to evil.near'], undefined, true)).length, 0, 'failed');
  const w = receipt('intents.near', 'intents.near', ['EVENT_JSON:{"standard":"dip4","version":"0.4.3","event":"ft_withdraw","data":[{"account_id":"61c5","token":"token.0xshitzu.near","receiver_id":"evil.near","amount":"9"}]}']);
  assert.deepEqual(flowsOfReceipt(w).map((f) => [f.kind, f.from, f.to]), [['intents_out', '61c5', 'evil.near']]);
  const fl = [...flowsOfReceipt(nep), { token: 'token.0xshitzu.near', from: 'evil.near', to: 'veax.near', raw: '100' }];
  assert.equal(netOf('evil.near', fl)['token.0xshitzu.near'].net, '200');
});

test('1Click destination assets name their chain', () => {
  assert.deepEqual(assetChain('nep141:eth.omft.near'), { chain: 'Ethereum', asset: 'ETH' });
  assert.equal(assetChain('nep141:sol.omft.near').chain, 'Solana');
  assert.equal(assetChain('nep141:wrap.near').chain, 'NEAR');
});

test('AI write-up: dollar amounts must come from the evidence', () => {
  const p = { stolen_usd: 62815, exits: [{ usd: 51118 }, { usd: 2253 }] };
  assert.deepEqual(unverifiedAmounts({ s: 'took $62,815; about $53k went to Ethereum' }, p), []);
  assert.deepEqual(unverifiedAmounts({ s: 'took $90,000' }, p), ['$90,000']);
  assert.deepEqual(unverifiedAmounts({ s: 'still holds about $2,253, mostly SHITZU' }, p), [], 'a comma then a word is not a unit');
  assert.deepEqual(unverifiedAmounts({ s: 'about $2253 mostly in ETH' }, p), [], 'a word starting with m is not millions');
});

test('detector: outflows from protocols only, routers and protocol-to-protocol moves left out', () => {
  const b = { block: { header: { height: 5, timestamp_nanosec: '1000000000' } }, shards: [{ receipt_execution_outcomes: [
    { ...receipt('veax.near', 'wrap.near', ['Transfer 10 from veax.near to evil.near']), tx_hash: 'T1' },
    { ...receipt('veax.near', 'wrap.near', ['Transfer 10 from veax.near to intents.near']), tx_hash: 'T2' },
    { ...receipt('alice.near', 'wrap.near', ['Transfer 10 from alice.near to evil.near']), tx_hash: 'T3' },
  ] }] };
  const out = protocolOutflows(b, new Set(['veax.near']));
  assert.deepEqual(out.map((f) => [f.protocol, f.to, f.tx]), [['veax.near', 'evil.near', 'T1']]);
});

test('investigate: account, tx hash, NearBlocks link or target:<contract>', () => {
  assert.deepEqual(parseInvestigation('realkingdom9695.near'), { account: 'realkingdom9695.near' });
  assert.deepEqual(parseInvestigation('https://nearblocks.io/txns/BQkmuByxyoovFknaHCPjDFBWtXm3FkLSsNg6FS7e4vbV'), { tx: 'BQkmuByxyoovFknaHCPjDFBWtXm3FkLSsNg6FS7e4vbV' });
  assert.deepEqual(parseInvestigation('target:veax.near'), { target: 'veax.near' });
  assert.throws(() => parseInvestigation('not a thing!'));
});

test('AI write-up: thousands and millions read as such', () => {
  const p = { stolen_usd: 62815, exits: [{ usd: 51118 }] };
  assert.deepEqual(unverifiedAmounts({ s: 'about $63k was taken, $51k went to Ethereum' }, p), []);
  assert.deepEqual(unverifiedAmounts({ s: 'about $3 million was taken' }, p), ['$3 million']);
});

test('detector: large transfers out of exchange hot wallets, not to other exchange accounts', async () => {
  const { exchangeOutflows } = await import('../src/incident/detect.js');
  const nearTx = (from, to, tx) => ({ ...receipt(from, to, [], [{ Transfer: { deposit: '8091108600000000000000000000000' } }]), tx_hash: tx });
  const b = { block: { header: { height: 7, timestamp_nanosec: '1000000000' } }, shards: [{ receipt_execution_outcomes: [nearTx('hot1', 'fresh', 'T1'), nearTx('hot1', 'binancecold3.near', 'T2'), nearTx('alice.near', 'fresh', 'T3')] }] };
  assert.deepEqual(exchangeOutflows(b, new Set(['hot1'])).map((f) => [f.exchange, f.to, f.tx]), [['hot1', 'fresh', 'T1']]);
});

test('exchange baselines: a drain is unusual, a customer withdrawal is not', async () => {
  const { unusualOutflow } = await import('../src/incident/exchanges.js');
  const w = { baseline: { n: 175, median_near: 1058, p98_near: 86926 } };
  assert.equal(unusualOutflow(w, 1500, 400000).length, 0);
  assert.equal(unusualOutflow(w, 90000, 5000000).length, 0, 'a large but normal withdrawal');
  const r = unusualOutflow(w, 8091108, 3);
  assert.equal(r.length, 2);
  assert.match(r[0], /93x its usual large withdrawal/);
  assert.match(r[1], /100% of its balance/);
  assert.equal(unusualOutflow({ baseline: { n: 5 } }, 8091108, null).length, 0, 'no baseline, no balance: nothing to compare with');
});

test('exchange events: key changes on a hot wallet are seen, app keys are not', async () => {
  const { exchangeEvents } = await import('../src/incident/detect.js');
  const keyRc = (perm) => ({ receipt: { receipt_id: 'k', predecessor_id: 'hot1', receiver_id: 'hot1', receipt: { Action: { signer_id: 'hot1', actions: [{ AddKey: { public_key: 'ed25519:X', access_key: { permission: perm } } }] } } }, execution_outcome: { outcome: { logs: [], status: { SuccessValue: '' } } }, tx_hash: 'K' });
  const b = { block: { header: { height: 1, timestamp_nanosec: '1000000000' } }, shards: [{ receipt_execution_outcomes: [keyRc('FullAccess'), keyRc({ FunctionCall: { receiver_id: 'x' } })] }] };
  const { keys } = exchangeEvents(b, new Map([['hot1', { kind: 'hot', exchange: 'Binance' }]]));
  assert.deepEqual(keys.map((k) => [k.kind, k.full]), [['added', true], ['added', false]]);
});

test('news: NEAR crime stories and the accounts they name', async () => {
  const { parseFeed, newsSignal } = await import('../src/incident/signals.js');
  const xml = `<rss><channel><item><title>Binance hot wallets on NEAR drained</title><link>https://x.test/a</link><description><![CDATA[Funds moved to efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af and to evil.near]]></description><pubDate>Thu, 29 Oct 2026 21:00:00 GMT</pubDate></item>
    <item><title>Bitcoin hits a high</title><link>https://x.test/b</link><description>near the top</description></item></channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  const s = newsSignal(items[0]);
  assert.deepEqual(s.accounts.sort(), ['efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af', 'evil.near'].sort());
  assert.equal(s.exchange, 'Binance');
  assert.equal(newsSignal(items[1]), null, 'lower-case "near" is not NEAR, and no crime');
});

test('flows: NEAR attached to a call is paid in (a staked deposit nets out its withdrawal), 1 yocto is not', () => {
  const stake = receipt('whale.near', 'linear-protocol.near', [], [{ FunctionCall: { method_name: 'deposit_and_stake', deposit: '1430000000000000000000000000000' } }]);
  const sec = receipt('whale.near', 'usdt.tether-token.near', [], [{ FunctionCall: { method_name: 'ft_transfer', deposit: '1' } }]);
  assert.deepEqual(flowsOfReceipt(stake).map((f) => [f.kind, f.from, f.to]), [['call_deposit', 'whale.near', 'linear-protocol.near']]);
  assert.equal(flowsOfReceipt(sec).length, 0);
  const back = receipt('linear-protocol.near', 'whale.near', [], [{ Transfer: { deposit: '1430000000000000000000000000000' } }]);
  assert.equal(netOf('whale.near', [...flowsOfReceipt(stake), ...flowsOfReceipt(back)]).near.net, '0');
});
