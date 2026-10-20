// Network expansion: a group is only as good as the links we can see, so the ordinary wallets around each group (who funded its members,
// where they sent NEAR, and those wallets' own funders and destinations) are profiled too, up to DEEP_DEPTH hops out. Their edges let
// buildGroups find early wallets that are connected through them, so a group that grows its network picks up the new linked wallets
// on the next regroup. Runs every worker cycle in small batches; profiled network wallets are kept in `wallets` with net: true.
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { profileWallet, classifyAccount, isGenericKind } from './profile.js';
import { buildAdjacency, blockedSet, kindMap, reachFrom, DEEP_DEPTH } from './deep.js';

const PROJ = { funders: 1, chain: 1, flow_out: 1, kind: 1, is_early: 1, profiled: 1 };

/** Next accounts to profile: not yet profiled ordinary wallets within DEEP_DEPTH - 1 hops of a group member, nearest and biggest group first. */
export async function networkCandidates(limit) {
  const clusters = await col('clusters').find({}, { projection: { members: 1, size: 1, score: 1 } }).sort({ size: -1, score: -1 }).toArray();
  if (!clusters.length) return [];
  const memberIds = [...new Set(clusters.flatMap((c) => c.members))];
  const docs = [];
  for (let i = 0; i < memberIds.length; i += 1000) docs.push(...await col('wallets').find({ _id: { $in: memberIds.slice(i, i + 1000) }, profiled: true }, { projection: PROJ }).toArray());
  docs.push(...await col('wallets').find({ net: true, profiled: true }, { projection: PROJ }).toArray());
  const adj = buildAdjacency(docs), blocked = blockedSet(adj, kindMap(docs));
  const profiled = new Set(docs.map((d) => d._id));
  const best = new Map(); // account -> { d, rank }
  clusters.forEach((c, rank) => {
    for (const m of c.members) {
      if (!adj.has(m)) continue;
      for (const [node, info] of reachFrom(m, adj, blocked, DEEP_DEPTH - 1)) {
        if (info.d === 0 || profiled.has(node) || isGenericKind(classifyAccount(node, null))) continue;
        const cur = best.get(node);
        if (!cur || info.d < cur.d || (info.d === cur.d && rank < cur.rank)) best.set(node, { d: info.d, rank });
      }
    }
  });
  const out = [...best.entries()].map(([account, v]) => ({ account, ...v }));
  out.sort((a, b) => a.d - b.d || a.rank - b.rank);
  // early wallets are profiled by the normal loop; skip them here
  const early = new Set((await col('wallets').find({ _id: { $in: out.slice(0, limit * 3).map((x) => x.account) }, is_early: true }, { projection: { _id: 1 } }).toArray()).map((w) => w._id));
  return out.filter((x) => !early.has(x.account)).slice(0, limit);
}

/** Profile up to `limit` network wallets. Returns how many were profiled. */
export async function expandNetworks(limit = config.graph.expandBatch) {
  if (!limit || limit < 1) return 0;
  const have = await col('wallets').countDocuments({ net: true });
  if (have >= config.graph.networkMaxNodes) return 0;
  const todo = await networkCandidates(Math.min(limit, config.graph.networkMaxNodes - have));
  let done = 0, idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const c = todo[idx++];
      try {
        await profileWallet(c.account);
        await col('wallets').updateOne({ _id: c.account }, { $set: { net: true, role: 'network' }, $min: { net_depth: c.d } });
        done++;
      } catch (e) {
        warn(`network profile ${c.account} failed: ${e.message}`);
        await col('wallets').updateOne({ _id: c.account }, { $set: { net: true, profiled: true, profile_error: e.message, profiled_ts: Date.now(), role: 'network' }, $min: { net_depth: c.d }, $setOnInsert: { first_seen_ts: Date.now(), cluster_id: null } }, { upsert: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, config.graph.profileConcurrency) }, worker));
  if (done) info(`NETWORK expanded ${done} linked wallets (${have + done} total)`);
  return done;
}
