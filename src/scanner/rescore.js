// Re-score stored checks after a gate became soft (min_buyers, not_overextended: warnings now, see rules.js). A stored check keeps its
// score; its soft gate ids move from `failed` to `warnings`, and a check that failed on soft gates alone passes if its score is high
// enough. Nothing is re-fetched and no AI review or simulated buy happens for the past: the check only says what the gates say now.
//   node src/cli.js rescore-gates            dry run: what would change
//   node src/cli.js rescore-gates --apply    write it (each changed record keeps its earlier values in rescore_before)
//   node src/cli.js rescore-gates --undo     put the earlier values back
import { col } from '../db.js';
import { config } from '../config.js';
import { SOFT_GATES, isHardGate, softNote } from './rules.js';

export const RESCORE_TAG = 'soft-gates-1';
const DECISION = 'passed on re-score: few buyers / price run-up are warnings now (not reviewed or bought at the time)';

/**
 * The new state of one stored check (a scan document or a token's `scan`), or null when it has no soft gate in `failed`.
 * `failed` holds gate objects ({ id, why }) or plain ids, as stored; the kept hard gates stay in the same form.
 */
export function rescoreCheck(s, minScore = config.rules.minScore) {
  const list = s?.failed || [];
  const soft = list.filter((g) => !isHardGate(g));
  if (!soft.length) return null;
  const hard = list.filter(isHardGate);
  const have = new Set((s.warnings || []).map((w) => w.id));
  const added = [...new Set(soft.map((g) => g?.id ?? g))].filter((id) => !have.has(id)).map((id) => ({ id, level: 'warning', why: softNote(id, s.features) }));
  const pass = s.pass === true || (hard.length === 0 && s.score != null && s.score >= minScore);
  return { failed: hard, warnings: [...(s.warnings || []), ...added], pass, became_pass: pass && s.pass !== true };
}

const softFilter = (path) => ({ [path]: { $in: [...SOFT_GATES] } });

/** Dry run by default; `apply` writes, `undo` restores what an earlier apply changed. */
export async function rescoreGates({ apply = false, undo = false } = {}) {
  const ts = Date.now();
  if (undo) {
    const out = { undo: true };
    for (const [name, prefix] of [['scans', ''], ['tokens', 'scan.']]) {
      const docs = await col(name).find({ [`${prefix}rescore_before.tag`]: RESCORE_TAG }, { projection: { [`${prefix}rescore_before`]: 1 } }).toArray();
      const ops = docs.map((d) => {
        const b = (prefix ? d.scan : d).rescore_before;
        const $set = { [`${prefix}pass`]: b.pass, [`${prefix}failed`]: b.failed, [`${prefix}decision`]: b.decision };
        const $unset = { [`${prefix}rescore_before`]: '', [`${prefix}rescored_ts`]: '' };
        if (b.warnings) $set[`${prefix}warnings`] = b.warnings; else $unset[`${prefix}warnings`] = ''; // earlier warnings (e.g. rugger) go back as they were
        return { updateOne: { filter: { _id: d._id }, update: { $set, $unset } } };
      });
      if (ops.length) await col(name).bulkWrite(ops, { ordered: false });
      out[name] = { restored: ops.length };
    }
    return out;
  }

  const out = { apply, min_score: config.rules.minScore };
  // scan documents (the evaluation history)
  const scans = await col('scans').find(softFilter('failed.id'), { projection: { token: 1, symbol: 1, pass: 1, score: 1, failed: 1, warnings: 1, decision: 1, 'features.trading': 1 } }).toArray();
  const scanOps = [], nowPass = [];
  for (const d of scans) {
    const r = rescoreCheck(d);
    if (!r) continue;
    if (r.became_pass) nowPass.push({ id: d._id, symbol: d.symbol, score: d.score });
    scanOps.push({ updateOne: { filter: { _id: d._id }, update: { $set: { failed: r.failed, warnings: r.warnings, pass: r.pass, ...(r.became_pass ? { decision: DECISION } : {}), rescored_ts: ts,
      rescore_before: { tag: RESCORE_TAG, pass: d.pass, failed: d.failed, warnings: d.warnings ?? null, decision: d.decision ?? null } } } } });
  }
  // each token's latest check (what the token list shows); its failed list holds gate ids
  const toks = await col('tokens').find(softFilter('scan.failed'), { projection: { symbol: 1, scan: 1 } }).toArray();
  const tokOps = [], tokPass = [];
  for (const t of toks) {
    const r = rescoreCheck(t.scan);
    if (!r) continue;
    if (r.became_pass) tokPass.push({ token: t._id, symbol: t.symbol, score: t.scan.score });
    tokOps.push({ updateOne: { filter: { _id: t._id }, update: { $set: { 'scan.failed': r.failed, 'scan.warnings': r.warnings, 'scan.pass': r.pass, ...(r.became_pass ? { 'scan.decision': DECISION } : {}), 'scan.rescored_ts': ts,
      'scan.rescore_before': { tag: RESCORE_TAG, pass: t.scan.pass, failed: t.scan.failed, warnings: t.scan.warnings ?? null, decision: t.scan.decision ?? null } } } } });
  }
  if (apply) {
    for (let i = 0; i < scanOps.length; i += 500) await col('scans').bulkWrite(scanOps.slice(i, i + 500), { ordered: false });
    for (let i = 0; i < tokOps.length; i += 500) await col('tokens').bulkWrite(tokOps.slice(i, i + 500), { ordered: false });
  }
  return { ...out, scans: { changed: scanOps.length, now_pass: nowPass.length, examples: nowPass.slice(0, 10) }, tokens: { changed: tokOps.length, now_pass: tokPass.length, examples: tokPass.slice(0, 10) } };
}
