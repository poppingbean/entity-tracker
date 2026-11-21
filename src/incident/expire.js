// Open cases nobody followed up go back to Normal. A live-feed finding still tagged "Large transfer" (drain?) or "Watching" (review), and an
// investigation still `suspected`, become Normal (tag `safe`, by 'auto') when nothing about them happened for INCIDENT_QUIET_HOURS (72 h):
//   - no report from people on the account (`reports`),
//   - no stolen funds moving from the case (`incident_moves`),
//   - no news naming the account (`security_news.accounts`),
//   - and no new tag on the case itself (a deep review, an operator).
// A case that was ever tagged Hack (or confirmed) is never returned: a human decides it. A returned case can still become a Hack later: the rules
// confirm it if proof turns up (service.js keeps a cleared case cleared only while the rules do not confirm it).
//   node src/cli.js incident-expire [--apply]     (dry by default; the worker runs it every hour)
import { col } from '../db.js';
import { config } from '../config.js';
import { info } from '../log.js';

const OPEN_TAGS = new Set(['drain?', 'review', 'unconfirmed']);
export const QUIET_WHY = (h) => `No report, fund movement or news about this case for ${h} hours: back to normal`;

/** Was the case ever called a hack (its tags or its status history)? Pure. */
export const everHack = (doc) => (doc.tags || []).some((t) => t.tag === 'hack') || (doc.status_history || []).some((s) => s.status === 'confirmed') || !!doc.confirmed_by || doc.verdict === 'hack';

/** The last time anything happened to a case: its own tags and times, and the outside signals given. Pure. */
export function lastActivity(doc, signals = []) {
  const own = [doc.first_seen_ts, doc.event_ts, doc.ts, ...(doc.tags || []).map((t) => t.ts)];
  return Math.max(0, ...[...own, ...signals].filter((x) => Number.isFinite(x)));
}

/** Is this case open, never a hack, and quiet for `quietMs`? Pure. `kind`: 'incident' | 'detection'. */
export function isQuiet(doc, kind, last, now, quietMs) {
  if (everHack(doc)) return false;
  if (kind === 'incident' && doc.status !== 'suspected') return false;
  if (kind === 'detection') {
    if (['safe', 'own_funds'].includes(doc.verdict)) return false; // already Normal (an own-funds finding has no tags; the page shows it as Normal)
    const t = doc.tags?.length ? doc.tags[doc.tags.length - 1].tag : 'drain?';
    if (!OPEN_TAGS.has(t)) return false;
  }
  return now - last >= quietMs;
}

// newest outside signal per account / per case
async function newest(collection, filter, field = 'ts') {
  const d = await col(collection).find(filter, { projection: { [field]: 1 } }).sort({ [field]: -1 }).limit(1).next().catch(() => null);
  return d?.[field] ?? null;
}
const signalsFor = async (accounts, caseId) => {
  const a = [...new Set(accounts.filter(Boolean))];
  return Promise.all([
    a.length ? newest('reports', { $or: [{ 'input.account': { $in: a } }, { 'input.target': { $in: a } }] }, 'last_ts') : null,
    caseId ? newest('incident_moves', { incident: caseId }) : null,
    a.length ? newest('security_news', { accounts: { $in: a } }) : null,
  ]);
};

/**
 * Find the quiet open cases and (apply) return them to Normal. Returns { incidents: [...], detections: [...] }, each { id, account, last, quiet_h }.
 * Investigations are returned first, so a finding whose investigation was just cleared follows it.
 */
export async function expireQuietCases({ apply = false, now = Date.now(), hours = config.incidents.quietHours, log = () => {} } = {}) {
  const quietMs = hours * 3600e3, why = QUIET_WHY(hours), out = { incidents: [], detections: [] };
  const { clearIncident } = await import('./service.js');
  const openCase = new Set();
  for (const inc of await col('incidents').find({ status: 'suspected' }).toArray()) {
    const account = inc._id.replace(/^inc:/, '');
    const last = lastActivity(inc, await signalsFor([account, inc.attacker?.account, inc.pasted], inc._id));
    if (!isQuiet(inc, 'incident', last, now, quietMs)) { openCase.add(inc._id); continue; }
    out.incidents.push({ id: inc._id, account, last, quiet_h: Math.floor((now - last) / 3600e3) });
    if (apply) await clearIncident(account, { by: 'auto', reason: why });
  }
  for (const d of await col('incident_detections').find({ verdict: { $ne: 'hack' } }).toArray()) {
    const caseId = d.review?.incident || null;
    if (caseId && openCase.has(caseId)) continue; // its investigation is still open: the finding follows it
    const caseDoc = caseId ? await col('incidents').findOne({ _id: caseId }, { projection: { tags: 1, status_history: 1, confirmed_by: 1, status: 1 } }) : null;
    if (caseDoc && (everHack(caseDoc) || caseDoc.status === 'confirmed')) continue;
    const last = lastActivity(d, await signalsFor([d.receiver], caseId));
    if (!isQuiet(d, 'detection', last, now, quietMs)) continue;
    out.detections.push({ id: d._id, account: d.receiver, last, quiet_h: Math.floor((now - last) / 3600e3) });
    if (!apply) continue;
    await col('incident_detections').updateOne({ _id: d._id }, { $set: { verdict: 'safe', review: { ...(d.review || {}), ts: now, tag: 'safe', why, by: 'auto' } },
      $push: { tags: { $each: [...(d.tags?.length ? [] : [{ tag: 'drain?', ts: d.ts }]), { tag: 'safe', ts: now, why, by: 'auto' }], $slice: -10 } } });
    await col('alerts').updateMany({ type: 'drain_suspected', 'related.wallets': d.receiver, title: { $not: /^(Not a hack|Retracted|Safe)/ } }, [{ $set: { title: { $concat: ['Safe after review: ', '$title'] }, severity: 'info' } }]).catch(() => {});
  }
  const n = out.incidents.length + out.detections.length;
  if (n) (apply ? info : log)(`quiet cases${apply ? ' returned to normal' : ' (dry)'}: ${out.incidents.length} investigations, ${out.detections.length} findings (${hours} h without a report, a move or news)`);
  return out;
}
