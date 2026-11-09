// Grouping keeps the kind of every account it saw on each wallet (wallets.kind, funders[].kind, chain[].kind, funder_kind), so a new rule
// only applies to existing data once those are recomputed. This re-sync is local (no network: the stored transaction counts are reused),
// runs once when the grouping rule changes (ONTOLOGY_READ gains or loses "grouping"), and is followed by a regroup.
//   node src/cli.js ontology-apply [--dry]
import { col, metaGet, metaSet } from '../db.js';
import { info } from '../log.js';
import { classifyAccount } from '../graph/profile.js';
import { reads, refreshSnapshot } from './sync.js';

export const groupingMode = () => (reads('grouping') ? 'ontology' : 'old');

/** Recompute stored kinds. Returns { wallets, changed, moves: { "old>new": n } }. */
export async function applyGroupingKinds({ dry = false } = {}) {
  await refreshSnapshot({ force: true });
  const moves = {}, ops = [];
  let wallets = 0;
  const note = (a, b) => { if (a !== b) moves[`${a}>${b}`] = (moves[`${a}>${b}`] || 0) + 1; };
  for await (const w of col('wallets').find({}, { projection: { kind: 1, tx_count: 1, funders: 1, chain: 1, funder_kind: 1 } })) {
    wallets++;
    const set = {};
    if (w.kind) { const k = classifyAccount(w._id, w.tx_count ?? null); if (k !== w.kind) { note(w.kind, k); set.kind = k; } }
    if (Array.isArray(w.funders) && w.funders.length) {
      let ch = false;
      const fs = w.funders.map((f) => { const k = f.account ? classifyAccount(f.account, f.tx_count ?? null) : f.kind; if (k !== f.kind) { note(f.kind, k); ch = true; return { ...f, kind: k }; } return f; });
      if (ch) { set.funders = fs; set.funder_kind = fs[0]?.kind ?? null; }
    }
    if (Array.isArray(w.chain) && w.chain.length) {
      let ch = false;
      const cs = w.chain.map((c) => { const k = c.account ? classifyAccount(c.account, c.tx_count ?? null) : c.kind; if (k !== c.kind) { note(c.kind, k); ch = true; return { ...c, kind: k }; } return c; });
      if (ch) set.chain = cs;
    }
    if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: w._id }, update: { $set: set } } });
  }
  if (!dry) for (let i = 0; i < ops.length; i += 500) await col('wallets').bulkWrite(ops.slice(i, i + 500), { ordered: false });
  return { wallets, changed: ops.length, moves, dry };
}

/** On worker start: re-sync once if the grouping rule differs from the one the stored kinds were computed with, then regroup. */
export async function syncGroupingIfChanged() {
  const mode = groupingMode(), was = await metaGet('ontology_grouping_mode', 'old');
  if (mode === was) return null;
  const r = await applyGroupingKinds();
  const { evaluateGroups } = await import('../evaluate/run.js');
  await evaluateGroups(); // regroups and rebuilds the entity table
  await metaSet('ontology_grouping_mode', mode);
  info(`ontology: grouping rule ${was} → ${mode}: ${r.changed} of ${r.wallets} wallets re-synced, groups rebuilt`);
  return r;
}
