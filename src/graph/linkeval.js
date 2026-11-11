// Wallet linking, measured (WP-13 part A): how many wallet pairs the current grouping gets right, against a set of pairs whose answer is known.
// Same owner: accounts of one confirmed case on the attacker's side (attacker, accomplice, sub account, cash-out wallet). Different owners:
// pairs of golden-set people, and any two wallets whose only tie is the same exchange. Pure functions; `linkEval` (CLI `link-eval`) reads the database.
// Nothing here changes a group.
import { col } from '../db.js';

const SIDE = new Set(['attacker', 'accomplice', 'sub_account', 'cash_out_wallet', 'intents_account']);
const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

/** Every pair inside each list of wallets (one owner), capped per list. */
export function samePairs(groups, cap = 40) {
  const out = new Set();
  for (const g of groups) { const xs = [...new Set(g)].slice(0, cap); for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.add(key(xs[i], xs[j])); }
  return out;
}
/** Pairs of different owners: every pair across the given lists (each list is one owner). */
export function differentPairs(owners, cap = 40) {
  const out = new Set();
  for (let i = 0; i < owners.length; i++) for (let j = i + 1; j < owners.length; j++) for (const a of owners[i].slice(0, cap)) for (const b of owners[j].slice(0, cap)) out.add(key(a, b));
  return out;
}

/**
 * Pairwise precision and recall of a grouping. `groupOf`: Map(wallet → group id); `same` / `diff`: Sets of "a|b" keys. Only pairs with both wallets
 * known to the grouping count (a wallet the grouping never saw is not a miss of the linking). precision = linked pairs that are really one owner
 * ÷ linked pairs with a known answer; recall = same-owner pairs that are linked ÷ same-owner pairs.
 */
export function pairScore(groupOf, same, diff) {
  const linked = (k) => { const [a, b] = k.split('|'); const ga = groupOf.get(a), gb = groupOf.get(b); return ga != null && ga === gb; };
  const seen = (k) => { const [a, b] = k.split('|'); return groupOf.has(a) && groupOf.has(b); };
  const s = [...same].filter(seen), d = [...diff].filter(seen);
  const tp = s.filter(linked).length, fp = d.filter(linked).length, fn = s.length - tp;
  return { same_pairs: s.length, diff_pairs: d.length, tp, fp, fn, precision: tp + fp ? r3(tp / (tp + fp)) : null, recall: s.length ? r3(tp / s.length) : null };
}

/** The share of early wallets in no group, split by the kind of their first funder. rows: [{ funder_kind, grouped }]. */
export function unlinkedByFunder(rows) {
  const out = {};
  for (const x of rows) { const k = x.funder_kind || 'unknown', o = out[k] ||= { wallets: 0, unlinked: 0 }; o.wallets++; if (!x.grouped) o.unlinked++; }
  for (const o of Object.values(out)) o.unlinked_share = r3(o.unlinked / o.wallets);
  return out;
}

/** Run it against the database. */
export async function linkEval() {
  const wallets = await col('wallets').find({ is_early: true, profiled: true }, { projection: { cluster_id: 1, funder_kind: 1 } }).toArray();
  const groupOf = new Map(wallets.filter((w) => w.cluster_id).map((w) => [w._id, w.cluster_id]));
  // every wallet the grouping knows (early or linked network wallets) counts as seen: give the ones in no group a unique id
  const all = new Map(wallets.map((w) => [w._id, w.cluster_id || `solo:${w._id}`]));
  const extra = await col('wallets').find({ net: true, profiled: true }, { projection: { cluster_id: 1 } }).toArray();
  for (const w of extra) if (!all.has(w._id)) all.set(w._id, w.cluster_id || `solo:${w._id}`);
  const cases = await col('incidents').find({ status: 'confirmed' }, { projection: { accounts: 1 } }).toArray();
  const same = samePairs(cases.map((c) => (c.accounts || []).filter((a) => SIDE.has(a.role)).map((a) => a.account)));
  const { GOLDEN } = await import('../ontology/golden.js');
  const people = GOLDEN.filter(([, cls]) => cls.startsWith('person')).map(([a]) => [a]); // each golden person is its own owner
  const diff = differentPairs(people);
  // two wallets funded by the same exchange hot wallet and by nothing else are NOT the same owner: the exchange hides who the customer is
  const byHub = new Map();
  for (const w of await col('wallets').find({ is_early: true, 'funders.0': { $exists: true } }, { projection: { funders: 1 } }).toArray()) {
    const fs = (w.funders || []).filter((f) => !f.creator_only);
    if (fs.length === 1 && fs[0].kind === 'hub') (byHub.get(fs[0].account) || byHub.set(fs[0].account, []).get(fs[0].account)).push(w._id);
  }
  for (const ws of byHub.values()) for (const k of differentPairs(ws.slice(0, 12).map((x) => [x]))) diff.add(k);
  const score = pairScore(all, same, diff);
  const split = unlinkedByFunder(wallets.map((w) => ({ funder_kind: w.funder_kind, grouped: !!w.cluster_id })));
  return { early_wallets: wallets.length, grouped: groupOf.size, same_owner_sets: cases.length, ...score, unlinked_by_funder_kind: split,
    note: score.same_pairs < 20 ? 'few known pairs: read as a first sign, not a measurement' : undefined };
}
