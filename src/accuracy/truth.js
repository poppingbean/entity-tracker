// Ground truth for security verdicts (WP-02): one definition of "what really happened" for cases, live detections, flagged accounts and audited
// contracts, used by every security accuracy number (security.js). Pure: no database. A label is 'bad' (the thing we try to catch really
// happened: a hack, a malicious account, a contract that harmed users), 'good', or null (unknown: left out of precision / recall).
import { isA } from '../ontology/classes.js';

const DAY = 86400e3, KEEP = 30;
const PEOPLE = new Set(['attacker', 'accomplice', 'sub_account', 'intents_account', 'cash_out_wallet']);

/**
 * The status history of a case: `{ ts, status, kind, by }` entries, appended when the status changes (by: rules | report | operator | review),
 * newest last, at most 30. `prevStatus` is the status stored before this save; `doc` is the case being saved.
 */
export function nextHistory(prevHistory, prevStatus, doc, by, ts = Date.now()) {
  const h = Array.isArray(prevHistory) ? prevHistory.slice() : [];
  const last = h[h.length - 1];
  const was = last ? last.status : prevStatus;
  if (doc?.status && doc.status !== was) h.push({ ts, status: doc.status, kind: doc.kind || null, by });
  return h.slice(-KEEP);
}

/** A hand label of this kind and id, from `ground_truth` rows ({ kind, id, label }). */
const manualLabel = (manual, kind, id) => (Array.isArray(manual) ? manual.find((m) => m.kind === kind && m.id === id)?.label : manual?.label) || null;

/**
 * The truth of one case, in priority order: a hand label; a public report (with a link); an operator's confirmation; an operator's clear;
 * a deep review's clear that has stood 14 days (weaker, reported apart); otherwise unknown.
 */
export function incidentTruth(inc, manual = null, now = Date.now()) {
  const m = typeof manual === 'string' ? manual : manualLabel(manual, 'incident', inc?._id);
  if (m === 'bad' || m === 'good') return { label: m, source: 'manual' };
  const cb = inc?.confirmed_by;
  if (cb?.source) return { label: 'bad', source: 'public_report' };
  if (cb) return { label: 'bad', source: 'operator_confirm' };
  if (inc?.status === 'cleared') {
    const by = inc.cleared?.by;
    if (by && by !== 'review') return { label: 'good', source: 'operator_clear' };
    if (now - (inc.cleared?.ts || now) >= 14 * DAY) return { label: 'good', source: 'review_clear' };
  }
  return { label: null, source: null };
}

/** The truth of a live detection: its case's label when it led to one; 'good' when it was own funds / safe and 14 days passed with no case. */
export function detectionTruth(det, caseTruth = null, manual = null, now = Date.now()) {
  const m = typeof manual === 'string' ? manual : manualLabel(manual, 'detection', det?._id);
  if (m === 'bad' || m === 'good') return { label: m, source: 'manual' };
  if (caseTruth?.label) return { label: caseTruth.label, source: `case_${caseTruth.source}` };
  if (['own_funds', 'safe'].includes(det?.verdict) && now - (det.ts || det.first_ts || now) >= 14 * DAY) return { label: 'good', source: 'no_case' };
  return { label: null, source: null };
}

/**
 * The truth of an account: bad when it has a role of the attacker's side in a case labelled bad (`roles`: [{ role, truth }] with truth the
 * case's label); good when the golden set has it under exchange, service, contract or system (`golden`: its expected class); else unknown.
 */
export function accountTruth(account, roles = [], manual = null, golden = null) {
  const m = typeof manual === 'string' ? manual : manualLabel(manual, 'account', account);
  if (m === 'bad' || m === 'good') return { label: m, source: 'manual' };
  if ((roles || []).some((r) => PEOPLE.has(r.role) && r.truth === 'bad')) return { label: 'bad', source: 'case_role' };
  if (golden && ['exchange', 'service', 'contract', 'system'].some((c) => isA(golden, c))) return { label: 'good', source: 'golden_set' };
  return { label: null, source: null };
}

/** History rebuilt for a case stored before histories existed: first seen + its current status, plus one entry per tag (hack → confirmed, safe → cleared, review → suspected). */
export function historyFromStored(inc) {
  const h = [], t0 = inc.first_seen_ts || inc.traced_ts || inc.started_ts || 0, MAP = { hack: 'confirmed', safe: 'cleared', review: 'suspected' };
  for (const t of inc.tags || []) if (MAP[t.tag]) h.push({ ts: t.ts || t0, status: MAP[t.tag], kind: inc.kind || null, by: t.by === 'operator' ? 'operator' : t.by === 'deep review' || t.by === 'review' ? 'review' : t.by ? t.by : 'rules' });
  const out = [];
  for (const e of h.sort((a, b) => a.ts - b.ts)) if (!out.length || out[out.length - 1].status !== e.status) out.push(e);
  if (!out.length || out[out.length - 1].status !== inc.status) out.push({ ts: inc.updated_ts || t0, status: inc.status, kind: inc.kind || null, by: inc.confirmed_by ? 'report' : 'rules' });
  return out.slice(-KEEP);
}
