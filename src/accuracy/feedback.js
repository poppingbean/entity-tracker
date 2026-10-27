// Feedback and hand labels. Anyone can say a verdict is wrong (pending until reviewed); a reviewer promotes it into ground_truth, which then
// overrides the price-based label in every accuracy number.
import { col } from '../db.js';

export const FEEDBACK_KINDS = ['token', 'group', 'wallet', 'collection'];
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

/** Store one report. verdict = what the reporter thinks the truth is: 'bad' (it was a scam / loss) or 'good'. */
export async function addFeedback({ kind, id, verdict, note, from }) {
  if (!FEEDBACK_KINDS.includes(kind)) throw new Error(`kind must be one of ${FEEDBACK_KINDS.join(', ')}`);
  id = clip(id, 200); if (!id) throw new Error('id is required');
  if (verdict !== 'bad' && verdict !== 'good') throw new Error("verdict must be 'bad' or 'good'");
  if ((await col('feedback').countDocuments({ status: 'pending' })) > 5000) throw new Error('the review queue is full, try later');
  const doc = { kind, id, verdict, note: clip(note, 500), from: clip(from, 80), ts: Date.now(), status: 'pending' };
  const r = await col('feedback').insertOne(doc);
  return { ...doc, _id: r.insertedId };
}

export const listFeedback = (status = 'pending', limit = 50) => col('feedback').find(status ? { status } : {}).sort({ ts: -1 }).limit(limit).toArray();

/** Label something by hand (source: 'report', 'feedback', 'manual'). */
export async function setTruth(kind, id, label, { source = 'manual', note = '' } = {}) {
  if (label !== 'bad' && label !== 'good') throw new Error("label must be 'bad' or 'good'");
  await col('ground_truth').replaceOne({ _id: `${kind}:${id}` }, { _id: `${kind}:${id}`, kind, id, label, source, note: clip(note, 500), ts: Date.now() }, { upsert: true });
}
export const clearTruth = (kind, id) => col('ground_truth').deleteOne({ _id: `${kind}:${id}` });

/** Review one report: accept (it becomes ground truth) or reject. */
export async function resolveFeedback(fid, accept) {
  const { ObjectId } = await import('mongodb');
  const f = await col('feedback').findOne({ _id: new ObjectId(String(fid)) });
  if (!f) throw new Error(`no feedback ${fid}`);
  if (accept) await setTruth(f.kind, f.id, f.verdict, { source: 'feedback', note: f.note });
  await col('feedback').updateOne({ _id: f._id }, { $set: { status: accept ? 'accepted' : 'rejected', resolved_ts: Date.now() } });
  return f;
}
