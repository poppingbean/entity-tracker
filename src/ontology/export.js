// Bulk export of the ontology (docs/ontology-layer-research.md, Stage 0): the same facts in the formats other tools read.
//   nquads   RDF 1.1 N-Quads. Every fact is a node typed <NS>Fact with its subject, predicate, object, source, confidence, evidence, writer, time (graph `facts`, with history);
//            every fact in force is also a plain triple (graph `live`). Reification is the classic node form, which every triple store reads and which maps onto RDF 1.2 reifiers later.
//   csv      one row per fact, for spreadsheets and bulk loads
//   oli      address labels in the shape of the Open Labels Initiative (chain_id as CAIP-2, address, tag_id, tag_value): a proposal for NEAR, only the tags is_eoa, contract_name, owner_project
//   stix     a STIX 2.1 bundle: one Indicator per flagged account in force
// Pure serializers over fact documents; the CLI (`ontology-export`) streams the collection through them.
import { createHash } from 'node:crypto';
import { NS, predIri, sourceIri, classIri } from './vocab.js';
import { accountIri, caip10 } from './caip.js';
import { ORGS, orgInfo } from './orgs.js';
import { SOURCE_RANK } from './classes.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#', RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', PROV_AT = 'http://www.w3.org/ns/prov#generatedAtTime';
const iriEsc = (s) => String(s).replace(/[\u0000- <>"{}|^`\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
const I = (s) => `<${iriEsc(s)}>`;
const lit = (s, dt = null) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"${dt ? `^^<${XSD}${dt}>` : ''}`;
const iso = (ts) => new Date(ts).toISOString();
export const GRAPH = { facts: `${NS}graph/facts`, live: `${NS}graph/live`, orgs: `${NS}graph/orgs` };
export const isLive = (f, now = Date.now()) => !f.valid_to || f.valid_to > now;

/** The object of a fact as an RDF term. */
export function objectTerm(f) {
  const o = f.object;
  switch (f.predicate) {
    case 'is_a': return I(classIri(o));
    case 'label': case 'flagged': return lit(o);
    case 'pass_through': case 'trusted': return lit(o === true || o === 'true' ? 'true' : 'false', 'boolean');
    case 'operated_by': return I(`${NS}org/${String(o).replace(/^org:/, '')}`);
    case 'role_in': return I(`${NS}case/${o}`);
    case 'member_of': return I(`${NS}group/${o}`);
    default: return I(accountIri(o));
  }
}

/** N-Quads lines of one fact. */
export function factQuads(f, now = Date.now()) {
  const fid = I(`${NS}fact/${f._id}`), g = I(GRAPH.facts), s = I(accountIri(f.subject)), o = objectTerm(f), out = [];
  const q = (p, term, graph = g) => out.push(`${fid} ${I(p)} ${term} ${graph} .`);
  q(RDF_TYPE, I(`${NS}Fact`));
  q(`${NS}subject`, s); q(`${NS}predicate`, I(predIri(f.predicate))); q(`${NS}object`, o);
  q(`${NS}source`, I(sourceIri(f.source)));
  if (f.confidence != null) q(`${NS}confidence`, lit(f.confidence, 'decimal'));
  if (f.evidence) q(`${NS}evidence`, lit(f.evidence));
  if (f.by) q(`${NS}by`, lit(f.by));
  for (const k of ['role', 'status', 'kind']) if (f[k]) q(`${NS}${k}`, lit(f[k]));
  if (f.observed_ts) q(PROV_AT, lit(iso(f.observed_ts), 'dateTime'));
  if (f.valid_from) q(`${NS}validFrom`, lit(iso(f.valid_from), 'dateTime'));
  if (f.valid_to) q(`${NS}validTo`, lit(iso(f.valid_to), 'dateTime'));
  if (isLive(f, now)) out.push(`${s} ${I(predIri(f.predicate))} ${o} ${I(GRAPH.live)} .`);
  return out;
}

/** The organisations: their names and the Wikidata item they are the same as (graph `orgs`). */
export function orgQuads() {
  const g = I(GRAPH.orgs), out = [];
  for (const id of Object.keys(ORGS)) {
    const o = orgInfo(id), n = I(`${NS}org/${id.replace(/^org:/, '')}`);
    out.push(`${n} ${I('http://www.w3.org/2000/01/rdf-schema#label')} ${lit(o.name)} ${g} .`);
    if (o.same_as) out.push(`${n} ${I('http://www.w3.org/2002/07/owl#sameAs')} ${I(o.same_as)} ${g} .`);
  }
  return out;
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const CSV_HEADER = ['subject', 'caip10', 'predicate', 'object', 'role', 'source', 'rank', 'confidence', 'evidence', 'by', 'status', 'kind', 'observed', 'valid_from', 'valid_to', 'in_force'];
export const csvRow = (f, now = Date.now()) => [f.subject, caip10(f.subject), f.predicate, typeof f.object === 'object' ? JSON.stringify(f.object) : f.object, f.role, f.source, SOURCE_RANK[f.source] ?? '', f.confidence, f.evidence, f.by, f.status, f.kind,
  f.observed_ts ? iso(f.observed_ts) : '', f.valid_from ? iso(f.valid_from) : '', f.valid_to ? iso(f.valid_to) : '', isLive(f, now)].map(csvCell).join(',');

/** OLI-shaped label rows from the facts in force: for each account and tag the strongest source wins. Only chains with a checked CAIP-2 id. */
export function oliRows(facts, now = Date.now()) {
  const best = new Map(), keep = (key, row, f) => { const w = best.get(key); if (!w || (SOURCE_RANK[f.source] ?? 0) > w.rank || ((SOURCE_RANK[f.source] ?? 0) === w.rank && (f.confidence ?? 0) > w.conf)) best.set(key, { row, rank: SOURCE_RANK[f.source] ?? 0, conf: f.confidence ?? 0 }); };
  const classOf = new Map();
  for (const f of facts) if (isLive(f, now) && f.predicate === 'is_a') { const w = classOf.get(f.subject); if (!w || (SOURCE_RANK[f.source] ?? 0) > (SOURCE_RANK[w.source] ?? 0)) classOf.set(f.subject, f); }
  for (const f of facts) {
    if (!isLive(f, now)) continue;
    const c = caip10(f.subject); if (!c) continue;
    const [ns, ref, ...rest] = c.split(':'), chain_id = `${ns}:${ref}`, address = rest.join(':');
    const row = (tag_id, tag_value) => ({ chain_id, address, tag_id, tag_value, source: f.source, confidence: f.confidence ?? null, evidence: f.evidence || null });
    if (f.predicate === 'is_a') {
      const top = String(f.object).split('.')[0].split('/')[0];
      const eoa = ['person/wallet', 'person/app_user'].includes(f.object) ? true : f.object === 'person/smart_wallet' || top === 'contract' ? false : null;
      if (eoa !== null) keep(`${c}|is_eoa`, row('is_eoa', eoa), f);
    } else if (f.predicate === 'label' && String(classOf.get(f.subject)?.object || '').startsWith('contract')) keep(`${c}|contract_name`, row('contract_name', f.object), f);
    else if (f.predicate === 'operated_by') keep(`${c}|owner_project`, row('owner_project', String(f.object).replace(/^org:/, '')), f);
  }
  return [...best.values()].map((b) => b.row).sort((a, b) => (a.chain_id + a.address + a.tag_id).localeCompare(b.chain_id + b.address + b.tag_id));
}

// ---- STIX 2.1
const STIX_NS = '5f0c6f2e-6c1a-4b5e-9a42-2b9f3c5d7a10'; // fixed UUID namespace of Safe Near's indicators
export function uuid5(name, ns = STIX_NS) {
  const h = createHash('sha1').update(Buffer.from(ns.replace(/-/g, ''), 'hex')).update(String(name)).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
/** One STIX Indicator for a flagged fact. A NEAR account is a `user-account`; an address on another chain a `cryptocurrency-wallet` (the object ransomware-tracking tools use; it is not in the STIX 2.1 core). */
export function stixIndicator(f) {
  const c = caip10(f.subject), chain = String(f.subject).includes(':') && !String(f.subject).startsWith('near:');
  const address = chain ? String(f.subject).slice(String(f.subject).indexOf(':') + 1) : f.subject;
  const created = iso(f.observed_ts || Date.now()), until = f.valid_to ? iso(f.valid_to) : null;
  return {
    type: 'indicator', spec_version: '2.1', id: `indicator--${uuid5(f._id)}`, created, modified: created,
    name: `${f.object} flag on ${f.subject}`, description: `${f.evidence || 'flagged'} [Safe Near: source ${f.source}, writer ${f.by}${c ? `, ${c}` : ''}]`,
    indicator_types: ['malicious-activity'], pattern_type: 'stix', pattern_version: '2.1',
    pattern: chain ? `[cryptocurrency-wallet:address = '${q(address)}']` : `[user-account:user_id = '${q(address)}']`,
    valid_from: created, ...(until && Date.parse(until) > Date.parse(created) ? { valid_until: until } : {}), confidence: Math.round(Math.max(0, Math.min(1, f.confidence ?? 0)) * 100),
    external_references: [{ source_name: 'Safe Near', url: `${NS}fact/${f._id}` }],
  };
}
export const stixBundle = (facts, now = Date.now()) => ({ type: 'bundle', id: `bundle--${uuid5('bundle:' + facts.length + ':' + now)}`, objects: facts.filter((f) => f.predicate === 'flagged' && isLive(f, now)).map(stixIndicator) });

/**
 * Stream the whole collection through a serializer. `facts`: an async iterable of fact documents; `write(line)`. Returns the number of facts.
 * nquads and csv carry history; oli and stix only what is in force.
 */
export async function exportFacts(format, facts, write, { now = Date.now() } = {}) {
  let n = 0;
  if (format === 'nquads') { for (const l of orgQuads()) write(l + '\n'); for await (const f of facts) { n++; for (const l of factQuads(f, now)) write(l + '\n'); } return n; }
  if (format === 'csv') { write(CSV_HEADER.join(',') + '\n'); for await (const f of facts) { n++; write(csvRow(f, now) + '\n'); } return n; }
  const all = []; for await (const f of facts) { n++; all.push(f); }
  if (format === 'oli') { for (const r of oliRows(all, now)) write(JSON.stringify(r) + '\n'); return n; }
  if (format === 'stix') { write(JSON.stringify(stixBundle(all, now), null, 1) + '\n'); return n; }
  throw new Error(`format: nquads, csv, oli or stix (got ${format})`);
}
