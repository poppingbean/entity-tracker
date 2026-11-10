// Regression fixtures: real transactions stored as test/fixtures/tx/<name>.json, so a log-format surprise fails `npm test` instead of production.
// Pure helpers only (no network); the `fixture-tx` command in cli.js fetches the transaction and writes the file.

const MAX_CODE = 2000; // a DeployContract `code` longer than this is replaced by a marker; nothing else is changed

/** A copy of an indexer transaction where every DeployContract `code` over 2,000 characters is "<omitted N chars>" (top level and in receipts). */
export function shrinkTx(tx) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'DeployContract' && x && typeof x.code === 'string' && x.code.length > MAX_CODE) o[k] = { ...x, code: `<omitted ${x.code.length} chars>` };
        else o[k] = walk(x);
      }
      return o;
    }
    return v;
  };
  return walk(tx);
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** The fixture file document for a raw indexer transaction. `captured_ts` is passed in so the function stays pure. */
export function fixtureDoc({ name, note = '', tx, captured_ts, synthetic = false }) {
  if (!NAME.test(name || '')) throw new Error(`fixture name "${name}" must be lower-case letters, digits, - or _`);
  const raw = shrinkTx(tx);
  const hash = raw?.transaction?.hash;
  if (!hash) throw new Error('not an indexer transaction: no transaction.hash');
  return { name, note, hash, captured_ts, synthetic, tx: raw };
}
