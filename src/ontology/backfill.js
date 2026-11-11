// The fact writers. Each writer reads one collection and returns its facts; `runWriters` asserts them as `writer/<name>` and closes that
// writer's facts it did not see again (a case cleared, an exchange wallet dropped from the registry), then re-resolves only the accounts
// it touched. Step G1: modules call it (through writers.js) right after they change their data, so new data reaches the ontology at once.
// The daily backfill is the same runner over every writer, kept as a safety net until G2 (docs/ontology-design.md 6.5).
//   node src/cli.js ontology-backfill [--dry]      node src/cli.js ontology-parity
import { col, bulkReplace } from '../db.js';
import { info } from '../log.js';
import { fromAuditRole } from './classes.js';
import { assert, retire, invalid, factDoc, factId, clearCache } from './index.js';
import { virtualFacts } from './known.js';
import { resolve } from './resolve.js';
import { intentsSolver } from '../incident/origin.js';
import { chainFacts } from './chains.js';
import { refreshSnapshot } from './sync.js';

const NO_CODE = '11111111111111111111111111111111';
const BUSY_TX = 15000; // grouping's hub threshold: this many transactions is busy like an exchange, a bot or a market maker
const RELAYER_NAME = /relayer|herewallet|meteor|wallet-relay|intear|registrar|\.tg$|\.user\.|^bridge/; // grouping's old relayer names
const org = (name) => `org:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

/** Each writer reads one collection and returns its facts. */
export const WRITERS = {
  async labels() {
    const out = [];
    for (const l of await col('labels').find({}).toArray()) {
      out.push({ subject: l._id, predicate: 'label', object: l.label, source: 'manual', confidence: 0.95, evidence: 'named by hand' });
      const cls = { exchange: 'exchange', service: 'service', bridge: 'service/bridge', fund: 'person/wallet' }[l.type];
      if (cls) out.push({ subject: l._id, predicate: 'is_a', object: cls, source: 'manual', confidence: 0.95, evidence: `named by hand: ${l.label}` });
      if (l.type === 'exchange') out.push({ subject: l._id, predicate: 'operated_by', object: org(l.label), source: 'manual', confidence: 0.9, evidence: 'named by hand' });
    }
    return out;
  },

  async exchange_wallets() {
    const out = [];
    for (const w of await col('exchange_wallets').find({}).toArray()) {
      const cls = w.kind === 'cold' ? 'exchange/cold_wallet' : 'exchange/hot_wallet';
      // proven by hand or by its sweeps to an exchange's cold wallet; otherwise it was only busy (the 2026-11-04 mistake), a weak fact
      const proven = w.source === 'manual' ? 'manual' : w.cold || /sends its reserves/.test(w.how || '') ? 'registry' : null;
      out.push({ subject: w._id, predicate: 'is_a', object: cls, source: proven || 'behaviour', confidence: proven ? 0.9 : 0.4, evidence: w.how || 'in the exchange wallet registry' });
      if (w.exchange) out.push({ subject: w._id, predicate: 'operated_by', object: org(w.exchange), source: proven || 'behaviour', confidence: proven ? 0.9 : 0.5, evidence: w.how || null });
      if (w.cold) {
        out.push({ subject: w._id, predicate: 'swept_to', object: w.cold, source: 'registry', confidence: 0.9, evidence: `sends its reserves to ${w.cold}` });
        out.push({ subject: w.cold, predicate: 'is_a', object: 'exchange/cold_wallet', source: 'registry', confidence: 0.85, evidence: `${w._id.slice(0, 12)}… sweeps its reserves here` });
        if (w.exchange) out.push({ subject: w.cold, predicate: 'operated_by', object: org(w.exchange), source: 'registry', confidence: 0.85, evidence: 'receives the exchange\'s sweeps' });
      }
    }
    return out;
  },

  async entities() {
    const out = [];
    const cur = col('entities').find({}, { projection: { kind: 1, type: 1, label: 1, label_source: 1, tx_count: 1, funded_wallets: 1 } });
    for await (const e of cur) {
      const n = (e.tx_count || 0).toLocaleString('en-US');
      // evidence only, never grouping's kind itself: that kind now comes from the ontology, and reading it back would be a loop
      // (a treasury the ontology calls a hub would come back as "busy, so an exchange")
      if ((e.tx_count || 0) >= BUSY_TX) out.push({ subject: e._id, predicate: 'is_a', object: 'exchange', source: 'behaviour', confidence: 0.3, evidence: `busy: ${n} transactions, pays many wallets` });
      else if (RELAYER_NAME.test(e._id)) out.push({ subject: e._id, predicate: 'is_a', object: 'service/relayer', source: 'name_pattern', confidence: 0.45, evidence: 'grouping calls it a relayer (account name)' });
      // grouping's "wallet" only means nothing marked it as special: the weakest fact there is, below any name pattern
      else if (e.kind === 'wallet') out.push({ subject: e._id, predicate: 'is_a', object: 'person/wallet', source: 'name_pattern', confidence: 0.2, evidence: `nothing marks it as a service (${n} transactions)` });
      if (e.label && e.label_source === 'manual') out.push({ subject: e._id, predicate: 'label', object: e.label, source: 'manual', confidence: 0.9, evidence: 'named by hand' });
      for (const w of (e.funded_wallets || []).slice(0, 200)) {
        out.push({ subject: e._id, predicate: 'funded', object: w.wallet, source: 'behaviour', confidence: 0.8, evidence: `${(w.near ?? 0).toFixed(2)} NEAR${w.hash ? ` in ${w.hash}` : ''}`, near: w.near ?? null, tx: w.hash || null, ts: w.ts || null });
      }
    }
    return out;
  },

  // scope { ids }: only these accounts (one audit just finished); its facts are the accounts' is_a and the controls edges into them
  async audits({ ids = null } = {}) {
    const out = [];
    const cur = col('audits').find({ auto: { $exists: true }, ...(ids ? { _id: { $in: ids } } : {}) }, { projection: { 'auto.role': 1, 'auto.label': 1, 'auto.confidence': 1, 'auto.control': 1, 'raw.account.code_hash': 1, 'raw.account.global_contract_hash': 1, 'raw.account.global_contract_account_id': 1 } });
    for await (const a of cur) {
      const acc = a.raw?.account, code = !!acc && (acc.code_hash && acc.code_hash !== NO_CODE || !!acc.global_contract_hash || !!acc.global_contract_account_id);
      const cls = fromAuditRole(a.auto?.role) || (code ? 'contract/other' : null);
      if (cls) out.push({ subject: a._id, predicate: 'is_a', object: cls, source: 'audit', confidence: fromAuditRole(a.auto?.role) ? Math.min(0.9, a.auto.confidence ?? 0.8) : 0.4, evidence: fromAuditRole(a.auto?.role) ? `the audit reads its code as ${a.auto.label || a.auto.role}` : 'has code the audit could not classify' });
      for (const c of a.auto?.control?.controllers || []) {
        if (c.account && c.account !== a._id) out.push({ subject: c.account, predicate: 'controls', object: a._id, source: 'audit', confidence: 0.9, evidence: `${c.via || 'controller'} of ${a._id} (${c.kind || 'account'})`, via: c.via || null });
      }
    }
    return out;
  },

  async incidents() {
    const out = [];
    for (const inc of await col('incidents').find({ status: { $in: ['confirmed', 'suspected', 'cleared'] } }, { projection: { status: 1, kind: 1, accounts: 1, target: 1, victims: 1, confirmed_by: 1, updated_ts: 1, cleared: 1, 'trail.exits': 1 } }).toArray()) {
      const source = inc.confirmed_by?.source ? 'public_report' : 'trace';
      const valid_to = inc.status === 'cleared' ? (inc.cleared?.ts || inc.updated_ts || Date.now()) : null;
      const base = { predicate: 'role_in', object: inc._id, source, confidence: inc.status === 'confirmed' ? 0.9 : 0.5, status: inc.status, kind: inc.kind, valid_to };
      const ev = (role) => `${role} in ${inc._id.slice(0, 16)}… (${inc.status} ${inc.kind})${inc.confirmed_by?.source ? `, ${inc.confirmed_by.source}` : ''}`;
      for (const a of inc.accounts || []) if (a.account && a.role) out.push({ ...base, subject: a.account, role: a.role, evidence: ev(a.role) });
      if (inc.target?.account) out.push({ ...base, subject: inc.target.account, role: 'target', evidence: ev('target') });
      for (const v of inc.victims || []) if (v.account && v.account !== inc.target?.account) out.push({ ...base, subject: v.account, role: 'victim', evidence: ev('victim') });
      out.push(...chainFacts(inc)); // WP-14: the addresses on other chains the case's money went to
    }
    return out;
  },

  async firewall_flags() {
    return (await col('firewall_flags').find({}).toArray()).filter((f) => f.severity).map((f) => ({
      subject: f._id, predicate: 'flagged', object: f.severity, source: f.source === 'incident' ? 'trace' : 'manual', confidence: 0.9, evidence: f.reason || f.detail || 'reported', case: f.incident || null,
    }));
  },

  // busy accounts the registry or grouping found only by being busy: NEAR Intents solvers among them are services, not exchanges.
  // The same check the tracer makes (intentsSolver), as a stronger behaviour fact than "busy".
  async solvers() {
    const [reg, hubs] = await Promise.all([
      col('exchange_wallets').find({ source: { $ne: 'manual' }, cold: null }, { projection: { _id: 1, how: 1 } }).toArray(),
      col('entities').find({ kind: 'hub' }, { projection: { _id: 1 } }).toArray(),
    ]);
    const ids = [...new Set([...reg.filter((w) => !/sends its reserves/.test(w.how || '')), ...hubs].map((x) => x._id))];
    const out = [];
    for (let i = 0; i < ids.length; i += 4) {
      await Promise.all(ids.slice(i, i + 4).map(async (id) => {
        const how = await intentsSolver(id).catch(() => null);
        if (how) out.push({ subject: id, predicate: 'is_a', object: 'service/intents_solver', source: 'behaviour', confidence: 0.8, evidence: how },
          { subject: id, predicate: 'solver_for', object: 'intents.near', source: 'behaviour', confidence: 0.8, evidence: how });
      }));
    }
    return out;
  },

  async clusters() {
    const out = [];
    for (const c of await col('clusters').find({}, { projection: { members: 1, verdict: 1 } }).toArray()) {
      for (const m of c.members || []) out.push({ subject: m, predicate: 'member_of', object: `grp:${c._id}`, source: 'behaviour', confidence: 0.6, evidence: `wallet group ${c._id}${c.verdict ? ` (${c.verdict})` : ''}` });
    }
    return out;
  },
};

// a writer's own name, and the name the daily backfill used before G1 (its facts are closed by the writer's first run)
export const writerBy = (name) => `writer/${name}`;
const legacyBy = (name) => `backfill/${name}`;
// the facts a scoped run owns: an audit run for some accounts closes only those accounts' facts
// (inside $and: retire() and the lookups add their own $or for 'still live', which would replace a top-level one)
const SCOPES = { audits: ({ ids }) => ({ $and: [{ $or: [{ subject: { $in: ids }, predicate: 'is_a' }, { object: { $in: ids }, predicate: 'controls' }] }] }) };

/**
 * Run some writers: assert their facts, close the ones they no longer see, re-resolve the accounts touched. `scope` = { <writer>: args }
 * narrows a writer that supports it (audits: { ids }). `dry`: build and check only. Returns { run, per, written, retired, touched, facts?, rejected }.
 */
export async function runWriters(names, { dry = false, scope = {}, now = Date.now() } = {}) {
  const run = now, per = {}, facts = [], rejected = [];
  for (const name of names) {
    if (!WRITERS[name]) throw new Error(`unknown writer ${name}`);
    const got = (await WRITERS[name](scope[name] || {})).map((f) => ({ ...f, by: writerBy(name), run }));
    const ok = got.filter((f) => { const p = invalid(f); if (p) rejected.push({ writer: name, problem: p, subject: f.subject }); return !p; });
    per[name] = ok.length; facts.push(...ok);
  }
  if (dry) return { run, facts, per, rejected, dry: true };
  const written = await assert(facts, { now: run });
  let retired = 0;
  const touched = new Set(facts.map((f) => f.subject));
  for (const name of Object.keys(per)) {
    const closing = { by: { $in: [writerBy(name), legacyBy(name)] }, run: { $ne: run }, ...(scope[name] && SCOPES[name] ? SCOPES[name](scope[name]) : {}) };
    if (scope[name] && !SCOPES[name]) throw new Error(`writer ${name} has no scope`);
    for (const f of await col('ontology_facts').find({ $and: [closing, { $or: [{ valid_to: null }, { valid_to: { $gt: run } }] }] }, { projection: { subject: 1 } }).toArray()) touched.add(f.subject);
    retired += await retire(closing, { now: run });
  }
  await resolveSubjects([...touched], { now: run });
  return { run, per, written, retired, touched: touched.size, rejected };
}

/** Every writer, then a full rebuild of `ontology_entities` (the daily safety net; G2 turns it off). Same return as runWriters plus `entities`. */
export async function backfill({ dry = false, only = null } = {}) {
  const r = await runWriters(only || Object.keys(WRITERS), { dry });
  if (dry) return r;
  const entities = await rebuildEntities();
  info(`ontology backfill: ${r.written} facts written, ${r.retired} retired, ${entities} entities resolved`);
  return { ...r, entities };
}

/**
 * Parity (the G2 gate): what every writer would write now against what is stored. `missing`: a fact a writer makes that is not stored
 * (a module changed its data without running its writer); `stale`: a stored fact no writer makes any more (a close that never ran).
 * Legacy `backfill/*` facts count as stored until a writer has replaced them. Writes nothing.
 */
export async function parity({ now = Date.now() } = {}) {
  const dry = await runWriters(Object.keys(WRITERS), { dry: true, now });
  const out = {};
  for (const name of Object.keys(WRITERS)) {
    // only facts that would be live: a cleared case's roles are written already closed (valid_to = the clear time)
    const live = (f) => f.valid_to == null || f.valid_to > now;
    const want = new Map(dry.facts.filter((f) => f.by === writerBy(name) && live(f)).map((f) => [factId(f), f]));
    const stored = await col('ontology_facts').find({ by: { $in: [writerBy(name), legacyBy(name)] }, $or: [{ valid_to: null }, { valid_to: { $gt: now } }] }, { projection: { subject: 1, predicate: 1, object: 1, by: 1 } }).toArray();
    // a legacy fact stands for the same fact under the writer's name
    const have = new Set(stored.map((f) => (f.by === writerBy(name) ? f._id : factId({ subject: f.subject, predicate: f.predicate, object: f.object, by: writerBy(name) }))));
    const missing = [...want.keys()].filter((id) => !have.has(id));
    const stale = [...have].filter((id) => !want.has(id));
    out[name] = { facts: want.size, missing: missing.length, stale: stale.length, legacy: stored.filter((f) => f.by === legacyBy(name)).length,
      sample_missing: missing.slice(0, 3).map((id) => { const f = want.get(id); return `${f.subject} ${f.predicate} ${JSON.stringify(f.object)}`; }) };
  }
  return { ts: now, writers: out, clean: Object.values(out).every((w) => !w.missing && !w.stale && !w.legacy) };
}

/** Re-resolve some accounts into `ontology_entities` (an account left with no stored facts loses its row). */
export async function resolveSubjects(subjects, { now = Date.now() } = {}) {
  for (let i = 0; i < subjects.length; i += 500) {
    const part = subjects.slice(i, i + 500);
    const per = new Map(part.map((a) => [a, virtualFacts(a)])), has = new Set();
    for await (const f of col('ontology_facts').find({ subject: { $in: part }, $or: [{ valid_to: null }, { valid_to: { $gt: now } }] })) { per.get(f.subject).push(f); has.add(f.subject); }
    const docs = part.filter((a) => has.has(a)).map((a) => ({ _id: a, ...resolve(a, per.get(a), now), resolved_ts: now }));
    if (docs.length) await bulkReplace('ontology_entities', docs);
    const gone = part.filter((a) => !has.has(a));
    if (gone.length) await col('ontology_entities').deleteMany({ _id: { $in: gone } });
  }
  clearCache();
  if (subjects.length) await refreshSnapshot({ force: true }).catch(() => {});
  return subjects.length;
}

/** Recompute `ontology_entities` (one resolved answer per account that has stored facts), for pages and the gate. */
export async function rebuildEntities() {
  const now = Date.now(), per = new Map();
  for await (const f of col('ontology_facts').find({ $or: [{ valid_to: null }, { valid_to: { $gt: now } }] })) {
    if (!per.has(f.subject)) per.set(f.subject, virtualFacts(f.subject));
    per.get(f.subject).push(f);
  }
  const docs = [...per].map(([a, fs]) => ({ _id: a, ...resolve(a, fs, now), resolved_ts: now }));
  await bulkReplace('ontology_entities', docs);
  await col('ontology_entities').deleteMany({ resolved_ts: { $lt: now } });
  clearCache();
  return docs.length;
}

/** Facts as they would be stored, for a dry run's golden check (no database). */
export const asDocs = (facts) => facts.map((f) => factDoc(f));
