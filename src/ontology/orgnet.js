// Organisation networks: the wallets an analyst traced to one organisation (BitMine's wallets, an exchange's, a fund's …), kept so that a wallet in two
// networks carries both: one record per organisation and wallet, never one organisation per wallet.
//   org_networks   { _id: 'org:<slug>', name, note, created_ts, updated_ts }
//   org_members    { _id: 'org:<slug>|<account>', org, account, why, source, confidence, link, by, added_ts, updated_ts }
// The writer `org_networks` (backfill.js) turns each member into an `operated_by` fact with its own evidence; the answer lists every organisation
// (resolve.js `operators`), so nothing is dropped. Removing a member closes its fact.
//   node src/cli.js org-add <org> <account …> --why "…" [--source manual|trace|public_report] [--link <url>] [--name "BitMine"] [--confidence 0.8] [--file list.txt] [--dry]
//   node src/cli.js org-remove <org> <account …>
//   node src/cli.js org-show <org> [--suggest] [--chain]
import { col } from '../db.js';
import { normalizeId } from './caip.js';
import { parseChainId } from './chains.js';
import { orgInfo } from './orgs.js';

export const ORG_SOURCES = { manual: 0.9, public_report: 0.85, trace: 0.7 }; // the default confidence per source
const slug = (s) => String(s || '').toLowerCase().replace(/^org:/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
/** 'BitMine', 'bitmine', 'org:bitmine' -> 'org:bitmine'; null when nothing is left. Pure. */
export const orgId = (s) => (slug(s) ? `org:${slug(s)}` : null);
const NEAR_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** An account or chain address a network can hold, normalised; null if it is neither. Pure. */
export function memberId(raw) {
  const id = normalizeId(raw);
  if (!id || id.length > 128) return null;
  if (parseChainId(id)) return id; // eth:0x…, tron:…, btc:…
  return id.length >= 2 && id.length <= 64 && NEAR_ID.test(id) ? id : null;
}

/** The record for one member. Pure. */
export function memberDoc(org, account, { why, source = 'manual', confidence = null, link = null, by = 'operator', now = Date.now() } = {}) {
  if (!ORG_SOURCES[source]) throw new Error(`source must be one of ${Object.keys(ORG_SOURCES).join(', ')}`);
  if (!why || String(why).trim().length < 3) throw new Error('why: say what ties the wallet to the organisation');
  if (source === 'public_report' && !/^https?:\/\//.test(String(link || ''))) throw new Error('a public report needs --link <url>');
  const c = confidence == null ? ORG_SOURCES[source] : Number(confidence);
  if (!(c > 0 && c <= 1)) throw new Error('confidence must be between 0 and 1');
  return { _id: `${org}|${account}`, org, account, why: String(why).trim().slice(0, 300), source, confidence: c, link: link ? String(link).slice(0, 300) : null, by, updated_ts: now };
}

/** The `operated_by` fact of a member (writer org_networks). Pure. */
export const memberFact = (m, name = null) => ({ subject: m.account, predicate: 'operated_by', object: m.org, source: m.source, confidence: m.confidence,
  evidence: `in ${name || orgInfo(m.org).name}'s network: ${m.why}${m.link ? ` (${m.link})` : ''}` });

const sync = async (accounts) => (await import('./writers.js')).syncFacts(['org_networks'], { scope: { org_networks: { ids: [...new Set(accounts)] } } });

/** Add wallets to an organisation's network (or update their evidence). Returns { org, added, updated, rejected }. */
export async function addMembers(orgRaw, accounts, opts = {}) {
  const org = orgId(orgRaw);
  if (!org) throw new Error('organisation missing');
  const now = Date.now(), rejected = [], ids = [];
  for (const a of accounts) { const id = memberId(a); if (id) ids.push(id); else rejected.push(String(a)); }
  const uniq = [...new Set(ids)];
  if (!uniq.length) return { org, added: 0, updated: 0, rejected };
  const docs = uniq.map((a) => memberDoc(org, a, { ...opts, now }));
  if (opts.dry) { const have = await col('org_members').countDocuments({ _id: { $in: docs.map((d) => d._id) } }); return { org, added: docs.length - have, updated: have, rejected, dry: true }; }
  await col('org_networks').updateOne({ _id: org }, { $set: { updated_ts: now, ...(opts.name ? { name: String(opts.name).slice(0, 80) } : {}), ...(opts.note ? { note: String(opts.note).slice(0, 500) } : {}) }, $setOnInsert: { created_ts: now, ...(opts.name ? {} : { name: orgInfo(org).name }) } }, { upsert: true });
  const r = await col('org_members').bulkWrite(docs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: d, $setOnInsert: { added_ts: now } }, upsert: true } })), { ordered: false });
  await sync(uniq);
  return { org, added: r.upsertedCount || 0, updated: r.matchedCount || 0, rejected };
}

/** Take wallets out of a network: their facts close. Returns { org, removed }. */
export async function removeMembers(orgRaw, accounts) {
  const org = orgId(orgRaw), ids = [...new Set(accounts.map(memberId).filter(Boolean))];
  const r = await col('org_members').deleteMany({ _id: { $in: ids.map((a) => `${org}|${a}`) } });
  if (r.deletedCount) { await col('org_networks').updateOne({ _id: org }, { $set: { updated_ts: Date.now() } }); await sync(ids); }
  return { org, removed: r.deletedCount };
}

/**
 * One network: its members with their evidence, and the overlaps (members tied to other organisations too, from any source:
 * the registry, hand labels, another network). Returns null when the organisation has no network.
 */
export async function showNetwork(orgRaw) {
  const org = orgId(orgRaw);
  const net = await col('org_networks').findOne({ _id: org });
  const members = await col('org_members').find({ org }).sort({ added_ts: 1 }).toArray();
  if (!net && !members.length) return null;
  const ids = members.map((m) => m.account);
  const other = ids.length ? await col('ontology_facts').find({ subject: { $in: ids }, predicate: 'operated_by', object: { $ne: org }, valid_to: null }, { projection: { subject: 1, object: 1, source: 1, evidence: 1 } }).toArray() : [];
  const by = new Map();
  for (const f of other) (by.get(f.subject) || by.set(f.subject, []).get(f.subject)).push({ org: f.object, name: orgInfo(f.object).name, source: f.source, evidence: f.evidence || null });
  return {
    org, name: net?.name || orgInfo(org).name, note: net?.note || null, same_as: orgInfo(org).same_as, members_n: members.length,
    members: members.map((m) => ({ account: m.account, why: m.why, source: m.source, confidence: m.confidence, link: m.link, by: m.by, added_ts: m.added_ts, also: by.get(m.account) || [] })),
    overlaps: [...by].map(([account, orgs]) => ({ account, orgs })),
  };
}

// what a wallet in the net is next to: an owner edge, not a service (an exchange, a router, a pass-through account says nothing about who owns two wallets)
const OWNER_EDGES = ['funded', 'controls', 'deployed', 'created_by', 'member_of'];
/**
 * Wallets next to the network that are not in it yet, for an analyst to check (nothing is added): the ontology's owner edges (funding, control, deploys,
 * one-owner groups), and with `chain` the NEAR accounts that sent to or received from the members repeatedly in their recent transactions.
 * Exchanges, routers and other pass-through accounts are left out. Returns [{ account, members, via, score }] best first.
 */
export async function suggestMembers(orgRaw, { chain = false, perMember = 100, minTimes = 2, limit = 50 } = {}) {
  const org = orgId(orgRaw);
  const members = (await col('org_members').find({ org }, { projection: { account: 1 } }).toArray()).map((m) => m.account);
  const inNet = new Set(members), cand = new Map();
  const { graph, cutsPath } = await import('./graph.js');
  const { classOf } = await import('./sync.js');
  const skip = (a) => !a || inNet.has(a) || /^(org|inc):/.test(a) || (!/^grp:/.test(a) && cutsPath(a));
  const note = (a, member, via, w = 1) => { const c = cand.get(a) || { account: a, members: new Set(), via: new Set(), w: 0 }; c.members.add(member); c.via.add(via); c.w += w; cand.set(a, c); };
  const g = await graph();
  for (const m of members) {
    for (const [dir, list] of [['out', g.out.get(m) || []], ['in', g.in.get(m) || []]]) for (const e of list) {
      if (!OWNER_EDGES.includes(e.p) || skip(e.to)) continue;
      if (/^grp:/.test(e.to)) { for (const x of g.in.get(e.to) || []) if (x.p === 'member_of' && !skip(x.to)) note(x.to, m, `same group ${e.to.slice(4)}`); continue; }
      note(e.to, m, `${dir === 'out' ? '' : '← '}${e.p.replace(/_/g, ' ')}`);
    }
  }
  if (chain) {
    const { accountTxHashes, fetchTxs } = await import('../incident/trace.js'), { flowsOfTx } = await import('../incident/flows.js');
    for (const m of members.filter((a) => !parseChainId(a))) {
      const { hashes } = await accountTxHashes(m, { limit: perMember }).catch(() => ({ hashes: [] }));
      const txs = hashes.length ? await fetchTxs(hashes).catch(() => []) : [];
      const times = new Map();
      for (const t of Array.isArray(txs) ? txs : [...(txs?.values?.() || [])]) {
        let flows = []; try { flows = flowsOfTx(t); } catch { /* an unreadable tx */ }
        for (const f of flows) { const other = f.from === m ? f.to : f.to === m ? f.from : null; if (other && other !== m) times.set(other, (times.get(other) || 0) + 1); }
      }
      for (const [a, n] of times) if (n >= minTimes && !skip(a) && classOf(a).top !== 'contract') note(a, m, `moved money with it ${n} times`, n);
    }
  }
  return [...cand.values()].map((c) => ({ account: c.account, members: [...c.members], via: [...c.via], score: c.members.size * 1000 + c.w })) // next to more members first, then the stronger tie
    .sort((a, b) => b.score - a.score).slice(0, limit);
}
