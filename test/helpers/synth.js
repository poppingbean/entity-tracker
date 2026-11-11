// Builds raw indexer transactions (the shape FastNEAR /v0/transactions returns) for SYNTHETIC fixtures, until a real one replaces them.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
export const ev = (standard, event, data) => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data })}`;
export const fc = (method_name, args = {}, deposit = '0') => ({ FunctionCall: { method_name, args: b64(args), gas: 30000000000000, deposit } });
export const xfer = (deposit) => ({ Transfer: { deposit } });
/** receipts: [{ pred, recv, logs, actions, failed }] */
export function rawTx({ hash, signer, receiver, actions, receipts = [], ts = 1794300000000, height = 200000000, failed = false }) {
  return {
    transaction: { hash, signer_id: signer, receiver_id: receiver, actions },
    execution_outcome: { block_timestamp: String(BigInt(ts) * 1000000n), block_height: height, outcome: { logs: [], status: failed ? { Failure: {} } : { SuccessValue: '' } } },
    receipts: receipts.map((r, i) => ({
      receipt: { receipt_id: `${hash}-${i}`, predecessor_id: r.pred, receiver_id: r.recv, receipt: { Action: { signer_id: signer, actions: r.actions || [{ FunctionCall: { method_name: 'x' } }] } } },
      execution_outcome: { block_height: height, block_timestamp: String(BigInt(ts) * 1000000n), outcome: { executor_id: r.recv, logs: r.logs || [], status: r.failed || failed ? { Failure: {} } : { SuccessValue: '' } } },
    })),
  };
}
