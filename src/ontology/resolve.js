// From an account's facts to one answer (docs/ontology-design.md, 3.3). Pure: no database, so it is tested directly.
import { compatible, isA, topOf, rankOf, isPassClass, cutsLinks, SEVERITY } from './classes.js';

/** A fact still holds at `now`. */
export const live = (f, now = Date.now()) => (!f.valid_from || f.valid_from <= now) && (!f.valid_to || f.valid_to > now);

/** Stronger first: source rank, then confidence, then the newest. */
const stronger = (a, b) => rankOf(b.source) - rankOf(a.source) || (b.confidence ?? 0) - (a.confidence ?? 0) || (b.observed_ts ?? 0) - (a.observed_ts ?? 0);
const best = (facts) => [...facts].sort(stronger)[0] || null;
const brief = (f) => f && { object: f.object, source: f.source, confidence: f.confidence ?? null, evidence: f.evidence || null, by: f.by || null };

/**
 * Resolve an account. The class is the strongest `is_a`; a weaker fact that refines it (exchange → exchange/hot_wallet) gives the
 * subclass. Weaker facts that contradict the winner are kept as conflicts, with their evidence, so a reader sees what was overruled.
 */
export function resolve(account, facts, now = Date.now()) {
  const F = facts.filter((f) => f.subject === account && live(f, now));
  const by = (p) => F.filter((f) => f.predicate === p);
  const isa = by('is_a').sort(stronger);
  const win = isa[0] || null;
  let cls = win?.object || 'unknown', refine = null;
  // the most specific class that agrees with the winner, from any source
  for (const f of isa) if (f !== win && isA(f.object, cls) && f.object !== cls) { cls = f.object; refine = f; }
  const conflicts = isa.filter((f) => !compatible(f.object, cls)).map(brief);

  const label = best(by('label'));
  const operator = best(by('operated_by'));
  const flags = by('flagged').sort((a, b) => (SEVERITY[b.object] ?? -1) - (SEVERITY[a.object] ?? -1) || stronger(a, b));
  const roles = by('role_in').map((f) => ({ case: f.object, role: f.role || null, status: f.status || null, source: f.source }));
  const pass = isPassClass(cls) || by('pass_through').some((f) => f.object === true);
  return {
    account,
    class: cls,
    top: topOf(cls),
    label: label?.object ?? null,
    operator: operator?.object ?? null,
    pass_through: pass,
    cuts_links: cutsLinks(cls) || pass,
    trusted: by('trusted').some((f) => f.object === true),
    flagged: flags[0] ? { severity: flags[0].object, reason: flags[0].evidence || null, source: flags[0].source } : null,
    roles,
    groups: by('member_of').map((f) => f.object),
    confidence: win?.confidence ?? 0,
    source: win?.source ?? null,
    why: win ? [win.evidence || `${win.source}: ${win.object}`, refine?.evidence].filter(Boolean).join('; ') : 'nothing is known about this account',
    conflicts,
    facts_n: F.length,
  };
}
