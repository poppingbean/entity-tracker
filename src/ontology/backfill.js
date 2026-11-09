// Backfill: turn what Safe Near already knows into ontology facts (migration step 1). Idempotent: every run re-asserts what it sees and
// closes the facts of earlier runs it did not see again (a case cleared, an exchange wallet dropped from the registry).
//   node src/cli.js ontology-backfill [--dry]
import { col, bulkReplace } from '../db.js';
import { info } from '../log.js';
import { fromAuditRole } from './classes.js';
import { assert, retire, invalid, factDoc, clearCache } from './index.js';
import { virtualFacts } from './known.js';
import { resolve } from './resolve.js';
import { intentsSolver } from '../incident/origin.js';

const NO_CODE = '11111111111111111111111111111111';
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
      if (e.kind === 'hub') out.push({ subject: e._id, predicate: 'is_a', object: 'exchange', source: 'behaviour', confidence: 0.3, evidence: `busy: ${n} transactions, pays many wallets` });
      else if (e.kind === 'relayer') out.push({ subject: e._id, predicate: 'is_a', object: 'service/relayer', source: 'name_pattern', confidence: 0.45, evidence: 'grouping calls it a relayer (account name)' });
      // grouping's "wallet" only means nothing marked it as special: the weakest fact there is, below any name pattern
      else if (e.kind === 'wallet') out.push({ subject: e._id, predicate: 'is_a', object: 'person/wallet', source: 'name_pattern', confidence: 0.2, evidence: `nothing marks it as a service (${n} transactions)` });
      if (e.label && e.label_source === 'manual') out.push({ subject: e._id, predicate: 'label', object: e.label, source: 'manual', confidence: 0.9, evidence: 'named by hand' });
      for (const w of (e.funded_wallets || []).slice(0, 200)) {
        out.push({ subject: e._id, predicate: 'funded', object: w.wallet, source: 'behaviour', confidence: 0.8, evidence: `${(w.near ?? 0).toFixed(2)} NEAR${w.hash ? ` in ${w.hash}` : ''}`, near: w.near ?? null, tx: w.hash || null, ts: w.ts || null });
      }
    }
    return out;
  },

  async audits() {
    const out = [];
    const cur = col('audits').find({ auto: { $exists: true } }, { projection: { 'auto.role': 1, 'auto.label': 1, 'auto.confidence': 1, 'auto.control': 1, 'raw.account.code_hash': 1, 'raw.account.global_contract_hash': 1, 'raw.account.global_contract_account_id': 1 } });
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
    for (const inc of await col('incidents').find({ status: { $in: ['confirmed', 'suspected', 'cleared'] } }, { projection: { status: 1, kind: 1, accounts: 1, target: 1, victims: 1, confirmed_by: 1, updated_ts: 1, cleared: 1 } }).toArray()) {
      const source = inc.confirmed_by?.source ? 'public_report' : 'trace';
      const valid_to = inc.status === 'cleared' ? (inc.cleared?.ts || inc.updated_ts || Date.now()) : null;
      const base = { predicate: 'role_in', object: inc._id, source, confidence: inc.status === 'confirmed' ? 0.9 : 0.5, status: inc.status, kind: inc.kind, valid_to };
      const ev = (role) => `${role} in ${inc._id.slice(0, 16)}… (${inc.status} ${inc.kind})${inc.confirmed_by?.source ? `, ${inc.confirmed_by.source}` : ''}`;
      for (const a of inc.accounts || []) if (a.account && a.role) out.push({ ...base, subject: a.account, role: a.role, evidence: ev(a.role) });
      if (inc.target?.account) out.push({ ...base, subject: inc.target.account, role: 'target', evidence: ev('target') });
      for (const v of inc.victims || []) if (v.account && v.account !== inc.target?.account) out.push({ ...base, subject: v.account, role: 'victim', evidence: ev('victim') });
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

/** Run the writers. `dry`: collect and check the facts, write nothing. Returns { run, facts, per, rejected }. */
export async function backfill({ dry = false, only = null } = {}) {
  const run = Date.now(), per = {}, facts = [], rejected = [];
  for (const [name, fn] of Object.entries(WRITERS)) {
    if (only && !only.includes(name)) continue;
    const got = (await fn()).map((f) => ({ ...f, by: `backfill/${name}`, run }));
    const ok = got.filter((f) => { const p = invalid(f); if (p) rejected.push({ writer: name, problem: p, subject: f.subject }); return !p; });
    per[name] = ok.length; facts.push(...ok);
  }
  if (dry) return { run, facts, per, rejected, dry: true };
  const written = await assert(facts, { now: run });
  const retired = await retire({ by: { $in: Object.keys(per).map((n) => `backfill/${n}`) }, run: { $ne: run } }, { now: run });
  const entities = await rebuildEntities();
  info(`ontology backfill: ${written} facts written, ${retired} retired, ${entities} entities resolved`);
  return { run, per, written, retired, entities, rejected };
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
