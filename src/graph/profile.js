// Wallet profiling: who funded a wallet (and who funded the funder, a few hops up) and where its NEAR goes afterwards.
// The funding chain and the outflows are what later link wallets into groups.
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { accountPage, accountRows, fetchTxs } from '../near/indexer.js';
import { INFRA } from '../collect/trades.js';

const HUB_TX_COUNT = 15000; // an account with this many transactions is an exchange hot wallet / market maker / bot, not a person

/** What kind of account this is, for deciding whether sharing it says anything about common ownership. */
export function classifyAccount(account, txCount) {
  if (!account) return 'unknown';
  if (account === 'intents.near') return 'intents';
  if (account === 'near') return 'protocol';
  if (INFRA.test(account) || /\.(nearlytrade|launchpad\.justhoot)\.near$/.test(account)) return 'protocol';
  if (/relayer|herewallet|meteor|wallet-relay|intear|registrar|\.tg$|\.user\.|^bridge/.test(account)) return 'relayer';
  if ((txCount ?? 0) >= HUB_TX_COUNT) return 'hub';
  return 'wallet';
}
/** Kinds whose shared use proves nothing: stop following the chain and do not link wallets through them. */
export const isGenericKind = (k) => k !== 'wallet';

/** First funding of an account, from its oldest transactions. */
export async function findFunding(account) {
  const { rows, count } = await accountPage(account, { desc: false, limit: 8 });
  const txs = rows.length ? await fetchTxs(rows.map((r) => r.hash)) : [];
  const created = rows[0]?.ts ?? null;
  for (const tx of txs) {
    const toMe = tx.transfers.filter((t) => t.to === account);
    if (tx.receiver === account && tx.signer !== account && toMe.length) return { funder: tx.signer, near: toMe.reduce((s, t) => s + t.near, 0), ts: tx.ts, hash: tx.hash, txCount: count, created };
    const ca = tx.calls.find((c) => /create_account/.test(c.method) && (c.args?.new_account_id === account || c.args?.account_id === account));
    if (ca && tx.signer !== account) return { funder: tx.signer, near: ca.depositNear, ts: tx.ts, hash: tx.hash, txCount: count, created };
  }
  const dot = account.indexOf('.'); // sub-account: its parent created it
  if (dot > 0 && !/^[0-9a-f]{64}$/.test(account)) { const parent = account.slice(dot + 1); if (parent && parent !== 'near') return { funder: parent, near: null, ts: created, hash: null, txCount: count, created, viaParent: true }; }
  return { funder: null, near: null, ts: null, hash: null, txCount: count, created };
}

async function txCountOf(account) { return (await accountPage(account, { desc: false, limit: 1 })).count ?? 0; }

/** Where an account sent NEAR recently (outflows), from its latest signed transactions. */
export async function recentOutflows(account, lookback) {
  const { rows } = await accountRows(account, { desc: true, maxRows: lookback });
  const mine = rows.filter((r) => r.isSigner && r.ok);
  const txs = mine.length ? await fetchTxs(mine.map((r) => r.hash)) : [];
  const by = new Map();
  for (const tx of txs) for (const t of tx.transfers) {
    if (t.to === account || t.near <= 0) continue;
    const e = by.get(t.to) || { to: t.to, near: 0, n: 0, last_ts: 0 };
    e.near += t.near; e.n++; e.last_ts = Math.max(e.last_ts, tx.ts); by.set(t.to, e);
  }
  return [...by.values()].sort((a, b) => b.near - a.near);
}

async function funderNode(account) {
  const cached = await col('wallets').findOne({ _id: account, funding_done: true });
  if (cached) return cached;
  const f = await findFunding(account);
  const doc = { funding_done: true, tx_count: f.txCount, created_ts: f.created, kind: classifyAccount(account, f.txCount), funder: f.funder, funding_near: f.near, funding_ts: f.ts, funding_hash: f.hash, funding_via_parent: !!f.viaParent };
  await col('wallets').updateOne({ _id: account }, { $set: doc, $setOnInsert: { _id: account, profiled: false, role: 'funder', first_seen_ts: Date.now(), cluster_id: null } }, { upsert: true });
  return { _id: account, ...doc };
}

/** Profile one wallet: funding chain up to FUNDING_DEPTH hops, recent outflows, edges for the graph. */
export async function profileWallet(account) {
  const f = await findFunding(account);
  const kind = classifyAccount(account, f.txCount);
  const chain = [];
  const edges = [];
  let cur = f.funder, hop = 1, from = account, fundNear = f.near, fundTs = f.ts, fundHash = f.hash;
  const seen = new Set([account]);
  while (cur && hop <= config.graph.fundingDepth && !seen.has(cur)) {
    seen.add(cur);
    const node = await funderNode(cur);
    chain.push({ account: cur, kind: node.kind, hop, near: fundNear, tx_count: node.tx_count });
    edges.push({ _id: `fund|${cur}|${from}`, type: 'fund', from: cur, to: from, near: fundNear, first_ts: fundTs, hash: fundHash, hop });
    if (isGenericKind(node.kind)) break; // exchanges / relayers / intents: stop, they link nothing
    from = cur; cur = node.funder; fundNear = node.funding_near; fundTs = node.funding_ts; fundHash = node.funding_hash; hop++;
  }
  let flows = [];
  if (kind !== 'hub') { try { flows = await recentOutflows(account, config.graph.flowLookbackTxs); } catch (e) { warn(`flows of ${account} failed: ${e.message}`); } }
  for (const fl of flows.slice(0, 20)) edges.push({ _id: `flow|${account}|${fl.to}`, type: 'flow', from: account, to: fl.to, near: fl.near, n: fl.n, last_ts: fl.last_ts });
  if (edges.length) await col('edges').bulkWrite(edges.map((e) => ({ replaceOne: { filter: { _id: e._id }, replacement: e, upsert: true } })), { ordered: false });
  const first = chain[0];
  await col('wallets').updateOne({ _id: account }, { $set: {
    profiled: true, profiled_ts: Date.now(), created_ts: f.created, tx_count: f.txCount, kind, funder: first?.account ?? null, funder_kind: first?.kind ?? null,
    funding_near: f.near, funding_ts: f.ts, funding_hash: f.hash, chain, flow_out: flows.slice(0, 15), flow_out_total: flows.reduce((s, x) => s + x.near, 0),
  }, $setOnInsert: { first_seen_ts: Date.now(), cluster_id: null } }, { upsert: true });
  return { chain: chain.length, flows: flows.length };
}

/** Profile wallets that have not been profiled yet, a few at a time. */
export async function profilePending(limit = 40) {
  const todo = await col('wallets').find({ profiled: false, is_early: true }).limit(limit).toArray();
  let done = 0, idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const w = todo[idx++];
      try { await profileWallet(w._id); done++; } catch (e) { warn(`profile ${w._id} failed: ${e.message}`); await col('wallets').updateOne({ _id: w._id }, { $set: { profiled: true, profile_error: e.message, profiled_ts: Date.now() } }); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, config.graph.profileConcurrency) }, worker));
  if (done) info(`PROFILED ${done} wallets`);
  return done;
}
