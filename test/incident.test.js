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
