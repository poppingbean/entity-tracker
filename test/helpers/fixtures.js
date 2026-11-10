// Loads test/fixtures/tx/*.json: loadTx(name) → { raw, decoded, doc }; allTx() lists them all.
import fs from 'node:fs';
import { decodeTx } from '../../src/near/indexer.js';
const dir = new URL('../fixtures/tx/', import.meta.url);
export const allTx = () => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
export function loadTx(name) {
  const doc = JSON.parse(fs.readFileSync(new URL(`${name}.json`, dir), 'utf8'));
  return { doc, raw: doc.tx, decoded: decodeTx(doc.tx) };
}
