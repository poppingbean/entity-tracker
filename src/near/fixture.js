// Real transactions as test fixtures (WP-01): a parser is tested against what the chain really returned, so a log-format surprise fails
// `npm test` instead of production. `node src/cli.js fixture-tx <hash> <name>` captures one; shrinkTx keeps deploys small.
const LIMIT = 2000;
const shrinkAction = (a) => {
  if (a && a.DeployContract && typeof a.DeployContract.code === 'string' && a.DeployContract.code.length > LIMIT) return { ...a, DeployContract: { ...a.DeployContract, code: `<omitted ${a.DeployContract.code.length} chars>` } };
  return a;
};
/** A copy of an indexer transaction with every DeployContract `code` over 2,000 characters replaced by "<omitted N chars>" (top level and inside receipts). Nothing else changes. */
export function shrinkTx(t) {
  const c = JSON.parse(JSON.stringify(t));
  if (c.transaction?.actions) c.transaction.actions = c.transaction.actions.map(shrinkAction);
  for (const r of c.receipts || []) { const acts = r.receipt?.receipt?.Action?.actions; if (acts) r.receipt.receipt.Action.actions = acts.map(shrinkAction); }
  return c;
}
/** The fixture document stored in test/fixtures/tx/<name>.json. */
export const fixtureDoc = ({ name, note = '', hash, tx, synthetic = false, ts = Date.now() }) => ({ name, note, hash, captured_ts: ts, synthetic, tx });
