// Data health (src/near/health.js): gap runs and the indexer-vs-RPC comparison. No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gapRuns, sameOutcome } from '../src/near/health.js';
import { loadTx } from './helpers/fixtures.js';

test('gap runs: only more than max empty heights in a row; the edges count', () => {
  assert.deepEqual(gapRuns([1, 2, 10, 11], 1, 11, 5), [{ from: 3, to: 9 }]);
  assert.deepEqual(gapRuns([1, 2, 6, 7], 1, 7, 5), [], 'three empty heights are normal');
  assert.deepEqual(gapRuns([], 1, 8, 5), [{ from: 1, to: 8 }]);
  assert.deepEqual(gapRuns([5, 6], 5, 6, 5), []);
});

// an RPC tx_status made from an indexer fixture: the same receipts outcomes
const rpcOf = (raw) => ({ receipts_outcome: raw.receipts.map((r) => r.execution_outcome) });
test('sameOutcome: identical → true; a dropped log or a different result → false', () => {
  const raw = loadTx('refv2-sell-wnear').raw;
  assert.equal(sameOutcome(raw, rpcOf(raw)).ok, true);
  const dropped = rpcOf(raw); dropped.receipts_outcome = JSON.parse(JSON.stringify(dropped.receipts_outcome)); dropped.receipts_outcome[0].outcome.logs = [];
  const d = sameOutcome(raw, dropped); assert.equal(d.ok, false); assert.match(d.why, /logs differ/);
  const failedRpc = JSON.parse(JSON.stringify(rpcOf(raw))); failedRpc.receipts_outcome[0].outcome.status = { Failure: {} };
  assert.match(sameOutcome(raw, failedRpc).why, /success differs/);
  assert.equal(sameOutcome(raw, { receipts_outcome: [...rpcOf(raw).receipts_outcome, { outcome: { logs: [], status: { SuccessValue: '' } } }] }, { receipts: true }).ok, false, 'receipt count, when asked');
  assert.equal(sameOutcome(raw, { receipts_outcome: [...rpcOf(raw).receipts_outcome, { outcome: { logs: [], status: { SuccessValue: '' } } }] }).ok, true, 'ignored by default');
});
