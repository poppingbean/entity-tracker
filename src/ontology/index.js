// The ontology layer: the one place that says what an account is and how accounts relate (docs/ontology-design.md).
// Facts live in `ontology_facts` (one document per assertion, the knowledge graph's edges); code-level facts are added on the fly.
//   whatIs(account)            → { class, label, operator, pass_through, cuts_links, trusted, flagged, roles, why, conflicts … }
//   whatIsMany(accounts)       → Map(account → the same), one query
//   is(account, cls), isPassThrough(account)
//   relationsOf(account, { predicate, direction })
//   assert(fact), retire(filter)        writers only
import { createHash } from 'node:crypto';
import { col } from '../db.js';
import { isA, isClass, PREDICATES, rankOf } from './classes.js';
import { virtualFacts } from './known.js';
import { resolve, live } from './resolve.js';

export { resolve } from './resolve.js';
export { cutsLinks, isA, topOf, CLASSES } from './classes.js';

const TTL = 60e3, MAX = 5000;
const cache = new Map();
const hit = (a) => { const c = cache.get(a); return c && Date.now() - c.ts < TTL ? c.v : null; };
const put = (a, v) => { cache.set(a, { ts: Date.now(), v }); if (cache.size > MAX) cache.delete(cache.keys().next().value); };
export const clearCache = () => cache.clear();

export const factId = (f) => createHash('sha1').update([f.subject, f.predicate, JSON.stringify(f.object), f.by || ''].join('|')).digest('hex').slice(0, 24);

/** Stored facts about these accounts (empty when the database is not connected: virtual facts still answer). */
async function storedFacts(accounts) {
  try { return await col('ontology_facts').find({ subject: { $in: accounts }, $or: [{ valid_to: null }, { valid_to: { $gt: Date.now() } }] }).toArray(); }
  catch { return []; }
}

export async function whatIsMany(accounts) {
  const ids = [...new Set((accounts || []).filter(Boolean).map(String))];
  const out = new Map(), need = [];
  for (const a of ids) { const c = hit(a); if (c) out.set(a, c); else need.push(a); }
  if (need.length) {
    const stored = await storedFacts(need);
    const per = new Map(need.map((a) => [a, virtualFacts(a)]));
    for (const f of stored) per.get(f.subject)?.push(f);
    for (const a of need) { const r = resolve(a, per.get(a)); put(a, r); out.set(a, r); }
  }
  return out;
}
export const whatIs = async (account) => (await whatIsMany([account])).get(String(account));
export const is = async (account, cls) => isA((await whatIs(account)).class, cls);
export const isPassThrough = async (account) => (await whatIs(account)).pass_through;

/** Edges of the knowledge graph around an account: out (account is the subject), in (it is the object), or both. */
export async function relationsOf(account, { predicate = null, direction = 'out', now = Date.now() } = {}) {
  const p = predicate ? (Array.isArray(predicate) ? { $in: predicate } : predicate) : { $exists: true };
  const q = [];
  if (direction !== 'in') q.push({ subject: account, predicate: p });
  if (direction !== 'out') q.push({ object: account, predicate: p });
  const stored = await col('ontology_facts').find({ $or: q }).toArray().catch(() => []);
  const virt = direction !== 'in' ? virtualFacts(account).filter((f) => !predicate || [].concat(predicate).includes(f.predicate)) : [];
  return [...stored, ...virt].filter((f) => live(f, now)).sort((a, b) => rankOf(b.source) - rankOf(a.source));
}

/** Check a fact before it is written. Returns the problem, or null. */
export function invalid(f) {
  if (!f?.subject || typeof f.subject !== 'string') return 'subject missing';
  if (!PREDICATES.has(f.predicate)) return `unknown predicate ${f.predicate}`;
  if (f.object === undefined || f.object === null || f.object === '') return 'object missing';
  if (f.predicate === 'is_a' && !isClass(f.object)) return `unknown class ${f.object}`;
  if (!rankOf(f.source)) return `unknown source ${f.source}`;
  if (!f.by) return 'by missing';
  return null;
}

/** The document stored for a fact. */
export function factDoc(f, now = Date.now()) {
  const { virtual, ...rest } = f;
  return { _id: factId(f), confidence: 0.5, evidence: null, valid_from: null, valid_to: null, ...rest, observed_ts: f.observed_ts ?? now };
}

/** Write facts (upsert by subject + predicate + object + writer). Skips invalid ones and returns how many were written. */
export async function assert(facts, { now = Date.now() } = {}) {
  const docs = [].concat(facts).filter((f) => !invalid(f)).map((f) => factDoc(f, now));
  for (let i = 0; i < docs.length; i += 500) {
    const part = docs.slice(i, i + 500);
    await col('ontology_facts').bulkWrite(part.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
  }
  for (const d of docs) cache.delete(d.subject);
  return docs.length;
}

/** Close facts that no longer hold (a writer's facts it did not see again, a cleared case). */
export async function retire(filter, { now = Date.now() } = {}) {
  const r = await col('ontology_facts').updateMany({ ...filter, $or: [{ valid_to: null }, { valid_to: { $gt: now } }] }, { $set: { valid_to: now } });
  cache.clear();
  return r.modifiedCount || 0;
}
