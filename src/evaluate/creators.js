// Token creators ("contract creators"): who launched which tokens, how many of them were rugged, and who is on the dev-rug blacklist.
// Used to flag groups that contain a creator (member wallet or any linked wallet), on the creators page, and next to every token.
import { col } from '../db.js';
import { info, warn } from '../log.js';
import { classifyAccount, profileWallet } from '../graph/profile.js';

/**
 * Map creator account -> { account, launches, rugged, rug_rate, blacklisted: {ts, reason, token, symbol, source} | null, tokens: [{ id, symbol, launchpad, live_ts, rugged, kinds }] }.
 * `only` limits it to a set of accounts (all creators when omitted).
 */
export async function creatorIndex(only = null) {
  const match = only ? { creator: { $in: [...only] } } : { creator: { $ne: null } };
  const rows = await col('tokens').find(match, { projection: { creator: 1, symbol: 1, launchpad: 1, live_ts: 1, 'outcome.rugged': 1, 'outcome.rug_kinds': 1, 'rug.flagged': 1 } }).sort({ live_ts: -1 }).toArray();
  const out = new Map();
  for (const t of rows) {
    const c = out.get(t.creator) || { account: t.creator, launches: 0, rugged: 0, tokens: [], blacklisted: null };
    c.launches++;
    const rugged = !!t.outcome?.rugged || !!t.rug?.flagged;
    if (rugged) c.rugged++;
    c.tokens.push({ id: t._id, symbol: t.symbol || null, launchpad: t.launchpad, live_ts: t.live_ts, rugged, kinds: t.outcome?.rug_kinds || [] });
    out.set(t.creator, c);
  }
  const bl = await col('blacklist').find(only ? { _id: { $in: [...only] } } : {}).toArray();
  for (const b of bl) {
    const c = out.get(b._id) || { account: b._id, launches: 0, rugged: 0, tokens: [], blacklisted: null };
    c.blacklisted = { ts: b.ts, reason: b.reason || null, token: b.token || null, symbol: b.symbol || null, source: b.source || 'tracker' };
    out.set(b._id, c);
  }
  for (const c of out.values()) c.rug_rate = c.launches ? c.rugged / c.launches : null;
  return out;
}

/** Short form kept on groups / wallets / token rows: what matters at a glance. */
export const creatorBrief = (c) => (c ? { launches: c.launches, rugged: c.rugged, blacklisted: !!c.blacklisted, reason: c.blacklisted?.reason || null } : null);

/** 'blacklisted' > 'rugger' (at least one rugged launch) > 'creator' (launched tokens) > null. */
export const creatorFlag = (c) => (!c ? null : c.blacklisted ? 'blacklisted' : c.rugged > 0 ? 'rugger' : c.launches > 0 ? 'creator' : null);

// ------------------------------------------------------------------ who funds the creators
// Every token creator gets the same funding trace as an early wallet (graph/profile.js): its funders, the first funder's chain up to
// FUNDING_DEPTH hops, and where it sends NEAR. Creators tied to the same ordinary-wallet funder, or paying the same ordinary wallet,
// are one creator network: the same person or team launching from several accounts. Exchanges, relayers and NEAR Intents link nothing.
const MIN_FLOW_NEAR = 2; // cash-outs below this are dust
const MAX_ANCHOR_CREATORS = 30; // an account tied to more creators than this is a distributor / service: it links nothing

/** The accounts a creator is tied to: funders (first level and up the chain) and cash-out destinations, each with `link` true when it can tie two creators. */
export function creatorAnchors(w, kindOf = () => 'wallet') {
  const up = new Map();
  for (const f of w?.funders || []) if (!up.has(f.account)) up.set(f.account, { account: f.account, kind: f.kind, hop: 1, near: f.near ?? null, ts: f.ts ?? null, hash: f.hash ?? null, via: f.via ?? null, link: !isGeneric(f.kind) && !f.creator_only });
  for (const c of w?.chain || []) if (!up.has(c.account)) up.set(c.account, { account: c.account, kind: c.kind, hop: c.hop, near: c.near ?? null, ts: null, hash: null, via: null, link: !isGeneric(c.kind) });
  const down = (w?.flow_out || []).filter((f) => f.near >= MIN_FLOW_NEAR && f.to !== w._id).map((f) => { const kind = kindOf(f.to); return { account: f.to, kind, near: f.near, n: f.n, last_ts: f.last_ts ?? null, link: !isGeneric(kind) }; });
  return { up: [...up.values()].sort((a, b) => a.hop - b.hop), down };
}
const isGeneric = (k) => k != null && k !== 'wallet';

/** How `other` (a profiled creator wallet) is tied to the creator `selfId` with anchors `a`: the relations, strongest first, or [] when it is not. */
export function relateCreators(selfId, a, other, kindOf = () => 'wallet') {
  const o = creatorAnchors(other, kindOf), rel = [];
  const upSelf = new Set(a.up.filter((x) => x.link).map((x) => x.account)), downSelf = new Set(a.down.filter((x) => x.link).map((x) => x.account));
  if (a.up.some((x) => x.account === other._id)) rel.push({ type: 'funded_it', via: other._id });            // the other creator funded this one
  if (o.up.some((x) => x.account === selfId)) rel.push({ type: 'funded_by_it', via: selfId });                // this creator funded the other
  if (a.down.some((x) => x.account === other._id) || o.down.some((x) => x.account === selfId)) rel.push({ type: 'paid', via: other._id });
  for (const x of o.up) if (x.link && upSelf.has(x.account)) rel.push({ type: 'shared_funder', via: x.account });
  for (const x of o.down) if (x.link && downSelf.has(x.account)) rel.push({ type: 'shared_cashout', via: x.account });
  return rel;
}

/**
 * A creator's network, read live from the wallets collection: who funded it (with entity labels), where its NEAR went, the other creators
 * tied to it and how, and the network's combined record. `{ profiled: false }` until the creator's funding has been traced.
 */
export async function creatorNetwork(id) {
  const w = await col('wallets').findOne({ _id: id }, { projection: { funders: 1, chain: 1, flow_out: 1, profiled: 1, created_ts: 1, tx_count: 1, kind: 1 } });
  if (!w?.profiled) return { profiled: false };
  const kindOf = (acc) => classifyAccount(acc, null);
  const a = creatorAnchors(w, kindOf);
  const upLinks = a.up.filter((x) => x.link).map((x) => x.account), downLinks = a.down.filter((x) => x.link).map((x) => x.account);
  const others = await col('wallets').find({ is_creator: true, profiled: true, _id: { $ne: id }, $or: [
    { _id: { $in: [...a.up.map((x) => x.account), ...a.down.map((x) => x.account)] } }, { 'funders.account': { $in: [id, ...upLinks] } }, { 'chain.account': { $in: [id, ...upLinks] } }, { 'flow_out.to': { $in: [id, ...downLinks] } },
  ] }, { projection: { funders: 1, chain: 1, flow_out: 1 } }).limit(300).toArray();
  let sibs = others.map((o) => ({ account: o._id, relations: relateCreators(id, a, o, kindOf) }));
  // a shared funder / cash-out that ties this creator to dozens of others is a distributor (faucet, OTC desk, payroll): drop links through it
  const per = new Map();
  for (const s of sibs) for (const r of s.relations) if (r.type === 'shared_funder' || r.type === 'shared_cashout') per.set(r.via, (per.get(r.via) || 0) + 1);
  const distributors = new Set([...per].filter(([, k]) => k > MAX_ANCHOR_CREATORS).map(([acc]) => acc));
  sibs = sibs.map((s) => ({ ...s, relations: s.relations.filter((r) => !distributors.has(r.via) || !['shared_funder', 'shared_cashout'].includes(r.type)) })).filter((s) => s.relations.length);
  const idx = await creatorIndex([id, ...sibs.map((s) => s.account)]);
  const ents = new Map((await col('entities').find({ _id: { $in: [...a.up, ...a.down].map((x) => x.account) } }, { projection: { label: 1, type: 1, creators_funded_n: 1, creators_rugged_n: 1, funded_n: 1 } }).toArray()).map((e) => [e._id, e]));
  const tag = (x) => { const e = ents.get(x.account); return { ...x, label: e?.label ?? null, type: e?.type ?? null, creators_funded_n: e?.creators_funded_n ?? null, creators_rugged_n: e?.creators_rugged_n ?? null, early_funded_n: e?.funded_n ?? null }; };
  const rec = (acc) => { const c = idx.get(acc); return { launches: c?.launches ?? 0, rugged: c?.rugged ?? 0, blacklisted: !!c?.blacklisted, rug_symbols: (c?.tokens || []).filter((t) => t.rugged).slice(0, 4).map((t) => t.symbol || t.id) }; };
  const siblings = sibs.map((s) => ({ ...s, ...rec(s.account) })).sort((x, y) => y.rugged - x.rugged || y.launches - x.launches);
  const me = rec(id), all = [me, ...siblings];
  const launches = all.reduce((s, x) => s + x.launches, 0), rugged = all.reduce((s, x) => s + x.rugged, 0);
  return {
    profiled: true, created_ts: w.created_ts ?? null, tx_count: w.tx_count ?? null,
    funders: a.up.map((x) => ({ ...tag(x), distributor: distributors.has(x.account) })), cashout: a.down.slice(0, 10).map((x) => ({ ...tag(x), distributor: distributors.has(x.account) })), siblings: siblings.slice(0, 60),
    network: { creators: all.length, launches, rugged, rug_rate: launches ? rugged / launches : null, blacklisted: all.filter((x) => x.blacklisted).length, ruggers: all.filter((x) => x.rugged > 0 || x.blacklisted).length,
      // the other creators only: what this creator's network did before (its own record is counted separately)
      others_launches: launches - me.launches, others_rugged: rugged - me.rugged },
  };
}

/** Trace the funding of token creators that are not traced yet, newest launch first; marks every creator wallet `is_creator`. Returns how many were tried. */
export async function profileCreators(limit = 8) {
  const recent = await col('tokens').aggregate([{ $match: { creator: { $ne: null } } }, { $group: { _id: '$creator', last: { $max: '$live_ts' } } }, { $sort: { last: -1 } }, { $limit: 2000 }]).toArray();
  if (!recent.length) return 0;
  const ids = recent.map((r) => r._id);
  await col('wallets').updateMany({ _id: { $in: ids }, is_creator: { $ne: true } }, { $set: { is_creator: true } });
  const done = new Set((await col('wallets').find({ _id: { $in: ids }, profiled: true }, { projection: { _id: 1 } }).toArray()).map((x) => x._id));
  const todo = ids.filter((x) => !done.has(x)).slice(0, limit);
  let n = 0;
  for (const acc of todo) {
    try { await profileWallet(acc); n++; }
    catch (e) { warn(`creator profile ${acc} failed: ${e.message}`); await col('wallets').updateOne({ _id: acc }, { $set: { profiled: true, profile_error: e.message, profiled_ts: Date.now() } }); }
    await col('wallets').updateOne({ _id: acc }, { $set: { is_creator: true } });
  }
  if (todo.length) info(`CREATORS traced ${n} of ${todo.length}`);
  return todo.length; // attempts: a failed trace is marked done too, so callers can loop until 0
}
