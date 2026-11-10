// Loads the real-transaction fixtures in test/fixtures/tx. Each file holds one raw FastNEAR /v0/transactions element in `tx`.
import { readdirSync, readFileSync } from 'node:fs';
import { decodeTx } from '../../src/near/indexer.js';

const DIR = new URL('../fixtures/tx/', import.meta.url);

/** Names of every fixture, sorted. */
export const allTx = () => readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

/** { name, note, hash, synthetic, raw, decoded } for one fixture; `raw` goes to flowsOfTx, `decoded` to everything else. */
export function loadTx(name) {
  const doc = JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8'));
  return { ...doc, raw: doc.tx, decoded: decodeTx(doc.tx) };
}
