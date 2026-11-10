// case-add: put accounts an analyst (or the ring detector, once an operator approves) found into a confirmed case, everywhere at once:
//   - the case's own accounts (`incidents.accounts`, marked `added_by`, so a full re-trace keeps them);
//   - the firewall flags (the case's own flagAccounts, same wording and severity per role);
//   - the ontology: `funded` edges with amount / tx / time evidence, one `member_of` group, and `role_in` with status "suspected" for
//     accounts linked only by trading (never flagged: a suspected role is shown as "being watched");
//   - the scanner's creator blacklist for token creators;
//   - then the incidents and firewall_flags backfill writers, so `role_in` / `flagged` facts follow at once.
// Labels never spread along `funded` (docs/ontology-design.md 5.3): every role is written on its own account with its own evidence.
//   node src/cli.js case-add <case id | attacker account> <plan.json> [--dry]
import { col } from '../db.js';
import { info } from '../log.js';
import { accountRows, fetchTxs } from '../near/indexer.js';
import { assert, invalid, clearCache } from '../ontology/index.js';
import { runWriters } from '../ontology/backfill.js';
import { blacklistCreator } from '../scanner/pipeline.js';
import { flagAccounts } from './service.js';

// roles a case-add may give: the attacker's own (flagged per role by flagAccounts) or a suspected link (not flagged)
// (not 'accomplice': in a case that means "named in a public report", flagged critical; a trading-only link goes under `suspected`)
export const CASE_ROLES = new Set(['cash_out_wallet', 'sub_account', 'intents_account', 'funder']);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** The case a plan is for: `inc:<id>`, or an account that is the case's attacker or one of its accounts. */
export async function findCase(q) {
  const s = String(q || '').trim().toLowerCase();
  const id = s.startsWith('inc:') ? s : `inc:${s}`;
  return await col('incidents').findOne({ _id: id }) || col('incidents').findOne({ 'accounts.account': s, status: 'confirmed' });
}

/**
 * Check a plan and fill its defaults. A plan is
 *   { name, accounts: [{ account, role, why }], edges: [{ from, to, near?, n?, tx?, ts? } | [from, to]],
 *     suspected: [{ account, why, token? }], members: [{ account, why, confidence? }], blacklist: [{ account, token?, why }] }
 * `name` makes the writer (`case-add/<name>`) and the group (`grp:<name>`): running the same name again replaces its facts.
 * Returns { plan, problems }.
 */
export function checkPlan(raw) {
  const problems = [];
  const p = { name: slug(raw?.name || ''), accounts: [], edges: [], suspected: [], members: [], blacklist: [] };
  if (!p.name) problems.push('name missing');
  for (const a of raw?.accounts || []) {
    if (!a?.account) { problems.push('an account without "account"'); continue; }
    const role = a.role || 'cash_out_wallet';
    if (!CASE_ROLES.has(role)) problems.push(`${a.account}: role ${role} is not one of ${[...CASE_ROLES].join(', ')}`);
    p.accounts.push({ account: String(a.account).toLowerCase(), role, why: a.why || null });
  }
  for (const e of raw?.edges || []) {
    const [from, to] = Array.isArray(e) ? e : [e?.from, e?.to];
    if (!from || !to) { problems.push('an edge without from / to'); continue; }
    p.edges.push(Array.isArray(e) ? { from, to } : { ...e, from, to });
  }
  for (const s of raw?.suspected || []) {
    if (!s?.account || !s?.why) { problems.push('a suspected account needs "account" and "why"'); continue; }
    p.suspected.push({ account: String(s.account).toLowerCase(), why: s.why, token: s.token || null });
  }
  for (const m of raw?.members || []) if (m?.account) p.members.push({ account: String(m.account).toLowerCase(), why: m.why || 'named by the analyst', confidence: Math.min(0.8, m.confidence ?? 0.4) });
  for (const b of raw?.blacklist || []) if (b?.account) p.blacklist.push({ account: String(b.account).toLowerCase(), token: b.token || null, why: b.why || 'token creator in a laundering ring' });
  const both = p.accounts.filter((a) => p.suspected.some((s) => s.account === a.account)).map((a) => a.account);
  if (both.length) problems.push(`both a case account and suspected: ${both.join(', ')} (a suspected account must not be flagged)`);
  return { plan: p, problems };
}

/** NEAR sent from -> to, read from the chain: { near, n, tx, ts } of the first transfer (null when none). `cache` is shared per run. */
export async function edgeEvidence(from, to, { cache = new Map(), minNear = 0.05 } = {}) {
  // the oldest and the newest 400 transactions of each side: a busy account's later payment is past its oldest 400
  const hist = async (acc) => {
    if (!cache.has(acc)) {
      const [old, recent] = await Promise.all([accountRows(acc, { desc: false, maxRows: 400 }), accountRows(acc, { desc: true, maxRows: 400 })]);
      cache.set(acc, await fetchTxs([...old.rows, ...recent.rows].map((r) => r.hash))); // fetchTxs de-duplicates and sorts oldest first
    }
    return cache.get(acc);
  };
  for (const side of [to, from]) {
    let near = 0, n = 0, tx = null, ts = null;
    for (const t of await hist(side)) for (const f of t.inflows) if (f.from === from && f.to === to && f.near > minNear) { near += f.near; n++; if (!tx) { tx = t.hash; ts = t.ts; } }
    if (n) return { near: Math.round(near * 100) / 100, n, tx, ts };
  }
  return null;
}

/**
 * Apply a checked plan to a case. `dry`: read the chain and build everything, write nothing. Returns what was (or would be) written.
 * Only a confirmed case takes accounts: an unproven case flags nothing, so its accounts would say more than the case does.
 */
export async function addToCase(caseQuery, rawPlan, { dry = false, log = () => {} } = {}) {
  const { plan, problems } = checkPlan(rawPlan);
  if (problems.length) throw new Error(`plan: ${problems.join('; ')}`);
  const inc = await findCase(caseQuery);
  if (!inc) throw new Error(`no case for ${caseQuery}`);
  if (inc.status !== 'confirmed') throw new Error(`${inc._id} is ${inc.status}: only a confirmed case takes accounts (confirm it by hand first)`);
  const BY = `case-add/${plan.name}`, GRP = `grp:${plan.name}`;

  // 1) the edges, with evidence read from the chain where the plan gave none
  const cache = new Map(), edges = [];
  for (const e of plan.edges) {
    const ev = e.tx ? e : { ...e, ...(await edgeEvidence(e.from, e.to, { cache }) || {}) };
    if (!ev.tx) { log(`no transfer found ${e.from} -> ${e.to}: edge left out`); continue; }
    edges.push(ev);
  }
  // 2) the case's accounts
  const have = new Set((inc.accounts || []).map((a) => a.account));
  const notOwn = new Set([inc.target?.account, ...(inc.victims || []).map((v) => v.account)].filter(Boolean)); // never the attacker's
  const add = plan.accounts.filter((a) => !have.has(a.account) && !notOwn.has(a.account)).map((a) => ({ account: a.account, role: a.role, ts: Date.now(), added_by: BY, ...(a.why ? { why: a.why } : {}) }));
  // 3) the facts this writer owns
  const facts = [];
  for (const e of edges) facts.push({ subject: e.from, predicate: 'funded', object: e.to, source: 'trace', confidence: 0.9, evidence: `${Number(e.near || 0).toFixed(2)} NEAR in ${e.n || 1} transfer(s), first ${e.tx}`, near: e.near ?? null, tx: e.tx, ts: e.ts ?? null, by: BY });
  for (const a of plan.accounts) facts.push({ subject: a.account, predicate: 'member_of', object: GRP, source: 'trace', confidence: 0.8, evidence: a.why || `${a.role} of ${inc._id}`, by: BY });
  for (const s of plan.suspected) {
    const why = `${s.why}; linked by trading, no traced payment`;
    facts.push({ subject: s.account, predicate: 'member_of', object: GRP, source: 'trace', confidence: 0.6, evidence: why, by: BY });
    facts.push({ subject: s.account, predicate: 'role_in', object: inc._id, role: 'accomplice', status: 'suspected', kind: inc.kind, source: 'trace', confidence: 0.6, evidence: why, by: BY, valid_to: null });
  }
  for (const m of plan.members) facts.push({ subject: m.account, predicate: 'member_of', object: GRP, source: 'trace', confidence: m.confidence, evidence: m.why, by: BY });
  const bad = facts.map(invalid).filter(Boolean);
  if (bad.length) throw new Error(`facts: ${[...new Set(bad)].join('; ')}`);
  const out = { case: inc._id, by: BY, group: GRP, accounts_added: add.length, accounts_already: plan.accounts.length - add.length, edges: edges.length, edges_missing: plan.edges.length - edges.length, facts: facts.length, blacklist: plan.blacklist.length, dry };
  if (dry) return { ...out, add, edges_found: edges };

  if (add.length) await col('incidents').updateOne({ _id: inc._id }, { $push: { accounts: { $each: add } }, $set: { updated_ts: Date.now() } });
  out.flagged = await flagAccounts(await col('incidents').findOne({ _id: inc._id }));
  out.blacklisted = 0;
  for (const b of plan.blacklist) if (await blacklistCreator(b.account, { account: b.account, case: inc._id, reason: b.why, ...(b.token ? { laundering_token: b.token } : {}) })) out.blacklisted++;
  await col('ontology_facts').deleteMany({ by: BY });
  out.facts_written = await assert(facts);
  const r = await runWriters(['incidents', 'firewall_flags']); // the writers themselves, not a throttled sync: the result is reported
  out.backfill = { written: r.written, retired: r.retired };
  clearCache();
  info(`case-add ${BY} -> ${inc._id}: ${add.length} accounts, ${edges.length} edges, ${out.facts_written} facts, ${out.blacklisted} blacklisted`);
  return out;
}
