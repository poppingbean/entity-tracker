// Every source file that reads `config.` imports it. A missing import is a ReferenceError only when that line runs: the exchange scan
// (src/incident/exchanges.js) failed on every block for days with "config is not defined", caught and logged as INFO, so hot-wallet drain
// detection was off without anything failing. The functions involved need the database, so no other test ran them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === 'public' ? [] : files(p)) : p.endsWith('.js') ? [p] : []; });

test('every server source file that uses config imports it', () => {
  const missing = [];
  for (const f of files(SRC)) {
    if (f.replace(/\\/g, '/').endsWith('/src/config.js')) continue;
    const s = readFileSync(f, 'utf8');
    if (!/\bconfig\./.test(s)) continue;
    const imported = /import\s*\{[^}]*\bconfig\b[^}]*\}\s*from/.test(s) || /const\s*\{[^}]*\bconfig\b[^}]*\}\s*=\s*await import\(/.test(s);
    if (!imported) missing.push(f.slice(SRC.length));
  }
  assert.deepEqual(missing, [], `uses config without importing it: ${missing.join(', ')}`);
});
