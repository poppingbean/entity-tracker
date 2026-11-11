// The golden set: accounts whose class is known for certain (src/ontology/golden.json). Every migration step must keep them right
// (docs/ontology-design.md, 6), and the accuracy pass reports how many the ontology gets right (WP-07).
// golden.json entries: { account, expect (a class of the tree), note, source: operator | public (link in note) | self_evident }.
import fs from 'node:fs';
import { isA } from './classes.js';

export const GOLDEN_ENTRIES = JSON.parse(fs.readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));
/** Today's tuple shape: [account, expect, note]. */
export const GOLDEN = GOLDEN_ENTRIES.map((e) => [e.account, e.expect, e.note]);

/** Check resolved entities (Map account → entity) against the golden set: [{ account, expect, got, ok, why }]. */
export const checkGolden = (ents) => GOLDEN.map(([account, expect, note]) => {
  const e = ents.get(account);
  return { account, expect, got: e?.class || 'unknown', ok: !!e && isA(e.class, expect), note, why: e?.why || null };
});

/** `{ n, ok, by_class: [{ class, n, ok }], failures }`, from checkGolden's rows; stored by the accuracy pass as security.ontology. */
export function goldenReport(rows) {
  const per = new Map();
  for (const r of rows) { const k = r.expect.split('/')[0], p = per.get(k) || { class: k, n: 0, ok: 0 }; p.n++; if (r.ok) p.ok++; per.set(k, p); }
  return { n: rows.length, ok: rows.filter((r) => r.ok).length, by_class: [...per.values()], failures: rows.filter((r) => !r.ok).slice(0, 30).map((r) => ({ account: r.account, expect: r.expect, got: r.got, why: r.why })) };
}

/** Validation of the data file: every class exists, no duplicates, every entry has a source and a note. Returns the problems. */
export async function validateGolden(entries = GOLDEN_ENTRIES) {
  const { isClass } = await import('./classes.js'), seen = new Set(), bad = [];
  for (const e of entries) {
    if (!isClass(e.expect)) bad.push(`${e.account}: unknown class ${e.expect}`);
    if (seen.has(e.account)) bad.push(`${e.account}: duplicate`); seen.add(e.account);
    if (!['operator', 'public', 'self_evident'].includes(e.source)) bad.push(`${e.account}: source must be operator, public or self_evident`);
    if (!e.note) bad.push(`${e.account}: note missing`);
  }
  return bad;
}
