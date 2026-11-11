// Tokens from deploys (src/collect/liquidity.js): a token is found from its first liquidity, whatever factory made it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liquidityAdds, tokenOfAdd, tokenDoc } from '../src/collect/liquidity.js';
import { poolHit } from '../src/collect/launches.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const block = (receipts, ts = 1794268377000) => ({ block: { header: { height: 100, timestamp_nanosec: String(ts * 1e6) } }, shards: [{ receipt_execution_outcomes: receipts }] });
// the FUK launch, 2026-11-05 01:12:57 UTC: add_liquidity on Ref v2 pool 9005 (2.5M FUK against 40 wNEAR), as the block feed shows it
const refAdd = (o = {}) => ({
  tx_hash: 'HkAdYztcWvyDxgTvsfzQMz6BKg76pV1VjYBaPnRQECCT',
  receipt: { receipt_id: 'r1', predecessor_id: 'smoothward1740.near', receiver_id: 'v2.ref-finance.near', receipt: { Action: { signer_id: 'smoothward1740.near', actions: [{ FunctionCall: { method_name: 'add_liquidity', args: b64({ pool_id: 9005, amounts: ['2500000000000000000000000', '40000000000000000000000000'] }), deposit: '10000000000000000000000' } }] } } },
  execution_outcome: { outcome: { executor_id: 'v2.ref-finance.near', logs: ['Liquidity added ["2500000000000000000000000 fuk-3.smithii.near", "40000000000000000000000000 wrap.near"], minted 1000000000000000000000000 shares'], status: { SuccessValue: '' } } },
  ...o,
});

test('a Ref v2 add_liquidity in a block is found, with its pool id and both sides', () => {
  const [a] = liquidityAdds(block([refAdd()]));
  assert.equal(a.dex, 'refv2');
  assert.equal(a.poolId, 9005);
  assert.equal(a.provider, 'smoothward1740.near');
  assert.equal(a.tx, 'HkAdYztcWvyDxgTvsfzQMz6BKg76pV1VjYBaPnRQECCT');
  assert.deepEqual(a.tokens.map((x) => x.token), ['fuk-3.smithii.near', 'wrap.near']);
  assert.equal(a.ts, 1794268377000);
});

test('a failed add, or a swap on Ref, is not a liquidity add', () => {
  assert.equal(liquidityAdds(block([refAdd({ execution_outcome: { outcome: { logs: [], status: { Failure: {} } } } })])).length, 0);
  const swap = refAdd();
  swap.receipt.receipt.Action.actions[0].FunctionCall.method_name = 'swap';
  swap.execution_outcome.outcome.logs = ['Swapped 1 wrap.near for 2 fuk-3.smithii.near'];
  assert.equal(liquidityAdds(block([swap])).length, 0);
});

test('a Ref DCL liquidity_added event is found', () => {
  const dcl = { tx_hash: 'T2', receipt: { receipt_id: 'r2', predecessor_id: 'x.near', receiver_id: 'dclv2.ref-labs.near', receipt: { Action: { actions: [] } } },
    execution_outcome: { outcome: { logs: ['EVENT_JSON:' + JSON.stringify({ standard: 'dcl.ref', event: 'liquidity_added', data: [{ pool_id: 'abc.near|wrap.near|2000', owner_id: 'lp.near', amount_x: '5', amount_y: '7' }] })], status: { SuccessValue: '' } } } };
  const [a] = liquidityAdds(block([dcl]));
  assert.equal(a.dex, 'dcl');
  assert.equal(a.provider, 'lp.near');
  assert.deepEqual(tokenOfAdd(a, (t) => t === 'wrap.near'), { token: 'abc.near', quote: 'wrap.near', quoteRaw: '7', pool: { dex: 'dcl', poolId: 'abc.near|wrap.near|2000', quote: 'wrap.near' } });
});

test('only a pool of one token against one quote is a launch', () => {
  const q = (t) => ['wrap.near', 'usdt.tether-token.near'].includes(t);
  assert.equal(tokenOfAdd({ tokens: [{ token: 'wrap.near' }, { token: 'usdt.tether-token.near' }] }, q), null, 'two quotes');
  assert.equal(tokenOfAdd({ tokens: [{ token: 'a.near' }, { token: 'b.near' }] }, q), null, 'two memecoins');
  assert.equal(tokenOfAdd({ dex: 'refv2', poolId: 1, tokens: [{ token: 'wrap.near', raw: '1' }, { token: 'a.near', raw: '2' }] }, q).token, 'a.near', 'either order');
});

test('a token made by a factory is filed under the factory, its creator the account that signed the deploy', () => {
  const dep = { ts: 1, height: 2, kind: 'UseGlobalContract', by: 'smithii.near', signer: 'smoothward1740.near' };
  const d = tokenDoc('fuk-3.smithii.near', dep, { symbol: 'FUK', name: 'FUK' }, { pool: { dex: 'refv2', poolId: 9005, quote: 'wrap.near' }, live_ts: 10, status: 'new' }, { provider: 'smoothward1740.near' });
  assert.equal(d.launchpad, 'smithii.near');
  assert.equal(d.factory, 'smithii.near');
  assert.equal(d.creator, 'smoothward1740.near');
  assert.equal(d.source, 'deploy');
  assert.equal(d.status, 'new');
  assert.equal(tokenDoc('mytoken.near', { by: 'mytoken.near', signer: 'mytoken.near' }, { symbol: 'X' }, { pool: { quote: 'wrap.near' } }).launchpad, 'direct', 'self-deployed');
});

test('poolHit: a Ref v2 "Liquidity added" log is the first pool event of a token history (before any swap)', () => {
  const tx = { failed: false, ts: 5, height: 6, hash: 'H', events: [], calls: [{ method: 'add_liquidity', args: { pool_id: 9005 } }],
    logs: [{ executor: 'v2.ref-finance.near', text: 'Liquidity added ["2500 fuk-3.smithii.near", "40 wrap.near"], minted 1 shares' }] };
  const hit = poolHit('fuk-3.smithii.near', [tx]);
  assert.deepEqual(hit.pool, { dex: 'refv2', poolId: 9005, quote: 'wrap.near' });
  assert.equal(poolHit('other.near', [tx]), null);
});

test('only a plain NEP-141 token is opened: not an NFT, a multi-token or a look-alike', async () => {
  const { fungibleFrom } = await import('../src/collect/liquidity.js');
  const ft = { spec: 'ft-1.0.0', name: 'FUK', symbol: 'FUK', decimals: 18 };
  assert.equal(fungibleFrom({ ft, supply: '1000000000000000000000000000' }).ok, true);
  assert.equal(fungibleFrom({ ft, supply: '1', role: 'token' }).ok, true, 'audited as a token');
  assert.equal(fungibleFrom({ ft, supply: '1', nft: { spec: 'nft-2.0.0', name: 'X', symbol: 'X' } }).ok, false, 'also answers nft_metadata: an NFT contract');
  assert.equal(fungibleFrom({ ft, supply: '1', role: 'nft' }).ok, false, 'the audit says NFT');
  assert.equal(fungibleFrom({ ft, supply: '1', role: 'multi_token' }).ok, false, 'NEP-245 is not NEP-141');
  assert.equal(fungibleFrom({ ft: { ...ft, spec: 'nft-1.0.0' }, supply: '1' }).ok, false, 'wrong spec');
  assert.equal(fungibleFrom({ ft: { ...ft, decimals: '18' }, supply: '1' }).ok, false, 'decimals must be an integer');
  assert.equal(fungibleFrom({ ft: { ...ft, symbol: '' }, supply: '1' }).ok, false, 'no symbol');
  assert.equal(fungibleFrom({ ft, supply: null }).ok, false, 'no ft_total_supply');
  assert.equal(fungibleFrom({ ft: null, supply: null }).ok, false, 'a wallet or a DAO');
});
