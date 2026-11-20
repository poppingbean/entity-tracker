// External cases: a hack on another chain that Safe Near knows about from public reports and the public NEAR Intents record (docs/external-cases.md).
// Bitget (2026-09-24), Bybit (2025-02-21): the money was stolen on Ethereum, XRP Ledger, Tron ... and Safe Near's tracer follows NEAR accounts, so these are not
// traced; they are written down, with their sources, as DATA (src/incident/external/<id>.json) and loaded here:
//   - the case itself, in its own collection `external_cases` (kept apart from `incidents` on purpose: the tracer, the live follow and the Accuracy page
//     score cases Safe Near detected or traced, and a case it only read about would count as a miss);
//   - one ontology fact per address (`role_in` the case, `flagged` for the ones that are the attacker's), so Safe Near, the Safety Check, `what_is` and the
//     MCP tools answer for an `eth:0x…` / `xrp:r…` / `tron:T…` address the way they do for a NEAR account.
// Pure functions (validate, docFrom, factsOf) and one I/O function (loadExternal). Nothing here reads the chain.
import { createHash } from 'node:crypto';
import { col } from '../db.js';
import { assert, retire, factId } from '../ontology/index.js';
import { chainId, parseChainId } from '../ontology/chains.js';

export const EXTERNAL_PREFIX = 'ext:';
export const BY = (id) => `external:${id}`;

/** What an address was in the case. `bad` roles are flagged; `recipient` was only named; `victim` lost money. */
export const ROLES = {
  attacker: { group: 'bad', flag: 'critical', words: 'an attacker address' },
  exploit_contract: { group: 'bad', flag: 'critical', words: 'a contract the attacker used' },
  laundering_wallet: { group: 'bad', flag: 'critical', words: 'a wallet that held or moved the stolen money' },
  intents_depositor: { group: 'bad', flag: 'critical', words: 'the address that deposited stolen money into NEAR Intents' },
  intended_recipient: { group: 'recipient', flag: 'high', words: 'the destination of a swap the attacker ordered on NEAR Intents (the swap was refunded, the address never received it)' },
  victim: { group: 'victim', flag: null, words: 'a wallet that lost money in the hack' },
};
const SOURCES_OK = new Set(['public_report', 'manual']);

const isoOk = (s) => s == null || !Number.isNaN(Date.parse(s));
const url = (s) => typeof s === 'string' && /^https?:\/\//.test(s);

/** Problems with a case file (empty = fine). */
export function validateExternal(d) {
  const p = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!/^[a-z0-9-]{3,60}$/.test(d.id || '')) p.push('id: lowercase letters, digits and dashes (3 to 60)');
  for (const k of ['name', 'victim', 'kind', 'summary']) if (!d[k] || typeof d[k] !== 'string') p.push(`${k} missing`);
  if (!['exchange_drain', 'protocol_exploit', 'wallet_drainer'].includes(d.kind)) p.push('kind: exchange_drain, protocol_exploit or wallet_drainer');
  if (d.status !== 'confirmed') p.push('status: only confirmed public cases are loaded (an unconfirmed claim belongs in a watch)');
  if (!isoOk(d.started_utc) || !d.started_utc) p.push('started_utc: an ISO time');
  if (!(d.loss_usd > 0)) p.push('loss_usd: a number');
  if (!Array.isArray(d.sources) || !d.sources.length || d.sources.some((s) => !url(s.url) || !s.publisher || !s.says)) p.push('sources: each needs url, publisher and what it says');
  const ids = new Set((d.sources || []).map((s) => s.id));
  if ((d.sources || []).some((s) => !s.id)) p.push('sources: each needs an id');
  const seen = new Set();
  if (!Array.isArray(d.addresses) || !d.addresses.length) p.push('addresses: at least one');
  for (const [i, a] of (d.addresses || []).entries()) {
    const at = `addresses[${i}]`;
    const id = chainId(a.chain, a.address);
    if (!id) p.push(`${at}: unknown chain ${a.chain} or empty address`);
    if (!ROLES[a.role]) p.push(`${at}: role must be one of ${Object.keys(ROLES).join(', ')}`);
    if (!a.evidence || typeof a.evidence !== 'string') p.push(`${at}: evidence (one sentence) missing`);
    if (!ids.has(a.source)) p.push(`${at}: source ${a.source} is not in sources`);
    if (!(a.confidence >= 0.3 && a.confidence <= 0.95)) p.push(`${at}: confidence between 0.3 and 0.95`);
    if (id && seen.has(id)) p.push(`${at}: ${id} is listed twice (one role per address)`);
    seen.add(id);
  }
  for (const [i, o] of (d.intents?.orders || []).entries()) {
    if (!o.deposit_address || !o.status || !o.source || !ids.has(o.source)) p.push(`intents.orders[${i}]: deposit_address, status and a known source`);
  }
  for (const [i, s] of (d.intents?.statements || []).entries()) if (!s.by || !s.says || !ids.has(s.source)) p.push(`intents.statements[${i}]: by, says and a known source`);
  if (!d.intents || typeof d.intents.checked !== 'string') p.push('intents.checked: say what was looked at, also when nothing was found');
  return p;
}

/** The document stored in `external_cases`. */
export function docFrom(d, now = Date.now()) {
  const id = EXTERNAL_PREFIX + d.id;
  return {
    _id: id, status: 'confirmed', external: true, name: d.name, victim: d.victim, kind: d.kind, summary: d.summary,
    started_ts: Date.parse(d.started_utc), detected_ts: d.detected_utc ? Date.parse(d.detected_utc) : null, loss_usd: d.loss_usd, loss_note: d.loss_note || null,
    chains: d.chains || [], root_cause: d.root_cause || null, attribution: d.attribution || [], sources: d.sources,
    addresses: d.addresses.map((a) => ({ chain: a.chain, address: a.address, id: chainId(a.chain, a.address), role: a.role, evidence: a.evidence, source: a.source, confidence: a.confidence })),
    intents: { checked: d.intents.checked, activity: d.intents.activity || 'none found', orders: d.intents.orders || [], statements: d.intents.statements || [], frozen_usd: d.intents.frozen_usd ?? null, processed_usd: d.intents.processed_usd ?? null, blocked_usd: d.intents.blocked_usd ?? null },
    other_freezes: d.other_freezes || [], notes: d.notes || [], loaded_ts: now,
    fingerprint: createHash('sha1').update(JSON.stringify(d)).digest('hex').slice(0, 12),
  };
}

/** The ontology facts of a case: one `role_in` per address and role, one `flagged` for the roles that are the attacker's. */
export function factsOf(d, now = Date.now()) {
  const caseId = EXTERNAL_PREFIX + d.id, by = BY(d.id), out = [];
  for (const a of d.addresses) {
    const id = chainId(a.chain, a.address), r = ROLES[a.role], src = d.sources.find((s) => s.id === a.source);
    const evidence = `${a.evidence} (${src.publisher}: ${src.url})`;
    out.push({ subject: id, predicate: 'role_in', object: caseId, role: a.role, source: 'public_report', confidence: a.confidence, evidence, status: 'confirmed', kind: d.kind, by, observed_ts: now });
    if (r.flag) out.push({ subject: id, predicate: 'flagged', object: r.flag, source: 'public_report', confidence: a.confidence, evidence: `${r.words} in the ${d.name} (${new Date(Date.parse(d.started_utc)).toISOString().slice(0, 10)}): ${a.evidence}`.slice(0, 300), case: caseId, by, observed_ts: now });
  }
  return out;
}

/** Load one case file: the document and its facts; facts this file wrote earlier and no longer contains are closed. dry: only count. */
export async function loadExternal(d, { dry = false, now = Date.now() } = {}) {
  const problems = validateExternal(d);
  if (problems.length) throw new Error(`${d?.id || 'case'}: ${problems.join('; ')}`);
  const doc = docFrom(d, now), facts = factsOf(d, now), keep = facts.map((f) => factId(f));
  const prev = await col('external_cases').findOne({ _id: doc._id }, { projection: { fingerprint: 1 } });
  const stale = await col('ontology_facts').countDocuments({ by: BY(d.id), _id: { $nin: keep }, $or: [{ valid_to: null }, { valid_to: { $gt: now } }] });
  if (dry) return { id: doc._id, dry: true, exists: !!prev, changed: prev ? prev.fingerprint !== doc.fingerprint : true, addresses: doc.addresses.length, facts: facts.length, stale_facts: stale };
  await col('external_cases').replaceOne({ _id: doc._id }, doc, { upsert: true });
  const written = await assert(facts, { now });
  const retired = stale ? await retire({ by: BY(d.id), _id: { $nin: keep } }, { now }) : 0;
  return { id: doc._id, dry: false, exists: !!prev, changed: prev ? prev.fingerprint !== doc.fingerprint : true, addresses: doc.addresses.length, facts: written, stale_facts: retired };
}

/** Cases (newest first), without the address lists, for the API. */
export const listExternal = () => col('external_cases').find({}, { projection: { addresses: 0 } }).sort({ started_ts: -1 }).toArray();

/** The external cases whose ids are in `ids` (ids not starting with `ext:` are ignored). */
export async function externalCases(ids) {
  const want = [...new Set((ids || []).filter((x) => String(x).startsWith(EXTERNAL_PREFIX)))];
  return want.length ? col('external_cases').find({ _id: { $in: want } }).toArray() : [];
}

export { parseChainId };
