// Wallet profiling: who funded a wallet (and who funded the funder, a few hops up) and where its NEAR goes afterwards.
// The funding chain and the outflows are what later link wallets into groups.
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { accountPage, accountRows, fetchTxs } from '../near/indexer.js';
import { INFRA } from '../collect/trades.js';
import { yoctoToNear } from '../near/rpc.js';

const HUB_TX_COUNT = 15000; // an account with this many transactions is an exchange hot wallet / market maker / bot, not a person

/** What kind of account this is, for deciding whether sharing it says anything about common ownership. */
export function classifyAccount(account, txCount) {
  if (!account) return 'unknown';
  if (account === 'intents.near') return 'intents';
  if (account === 'near') return 'protocol';
  if (INFRA.test(account) || /\.(nearlytrade|launchpad\.justhoot|gaypad\.j1-racing|qlyphs|tkn)\.near$/.test(account)) return 'protocol';
  if (/relayer|herewallet|meteor|wallet-relay|intear|registrar|\.tg$|\.user\.|^bridge/.test(account)) return 'relayer';
  if ((txCount ?? 0) >= HUB_TX_COUNT) return 'hub';
  return 'wallet';
}
/** Kinds whose shared use proves nothing: stop following the chain and do not link wallets through them. */
export const isGenericKind = (k) => k !== 'wallet';

/**
 * Who really funded an account. Wallets made by a relayer (meteor, intear, herewallet ...) all share the relayer as "creator",
 * which says nothing; the money arrives right after from the owner's own wallet (often an implicit account), from an exchange, or via
 * NEAR Intents. So: read the oldest transactions, collect every NEAR inflow (including contract-originated ones), drop relayer gas
 * top-ups, and take the earliest sender of a meaningful amount as the funder. Other large senders are kept as extra funders.
 */
export const MIN_FUND_NEAR = 1;      // a sender must have sent at least this much to count as a funder
const DUST_NEAR = 0.05;              // ignore smaller transfers (gas top-ups, dust)
export async function findFunding(account) {
  const { rows, count } = await accountPage(account, { desc: false, limit: 30 });
  const txs = rows.length ? await fetchTxs(rows.map((r) => r.hash)) : [];
  const created = rows[0]?.ts ?? null;
  let creator = null;
  const bySender = new Map();
  for (const tx of txs) {
    const ca = tx.calls.find((c) => /create_account/.test(c.method) && (c.args?.new_account_id === account || c.args?.account_id === account));
    if (ca && tx.signer !== account && !creator) creator = { account: tx.signer, near: ca.depositNear, ts: tx.ts, hash: tx.hash };
    // NEAR Intents withdrawal: the transfer comes from intents.near, but the event names the intents account that ordered it
    const viaIntents = [];
    for (const ev of tx.events) if (ev.executor === 'intents.near' && ev.event === 'native_withdraw') for (const d of ev.data || []) if (d.receiver_id === account && d.account_id) viaIntents.push({ from: d.account_id, near: yoctoToNear(d.amount || '0'), via: 'intents' });
    const seen = new Set();
    const direct = [...tx.inflows.filter((x) => x.to === account), ...tx.transfers.filter((x) => x.to === account).map((x) => ({ from: tx.signer, near: x.near }))].filter((f) => !(viaIntents.length && f.from === 'intents.near'));
    for (const f of [...viaIntents, ...direct]) {
      if (!f.from || f.from === account || f.near < DUST_NEAR) continue;
      const key = `${f.from}|${f.near}`; if (seen.has(key)) continue; seen.add(key); // the same transfer shows up as a tx action and as a receipt
      const e = bySender.get(f.from) || { account: f.from, near: 0, ts: tx.ts, hash: tx.hash, via: f.via || null };
      e.near += f.near; bySender.set(f.from, e);
    }
  }
  // a relayer / protocol account that merely created the wallet is not a funder
  const candidates = [...bySender.values()].filter((e) => !['relayer', 'protocol'].includes(classifyAccount(e.account, null)));
  const big = candidates.filter((e) => e.near >= MIN_FUND_NEAR).sort((a, b) => a.ts - b.ts);
  const funders = big.slice(0, 5);
  if (!funders.length && creator && !['relayer', 'protocol'].includes(classifyAccount(creator.account, null))) funders.push({ account: creator.account, near: creator.near, ts: creator.ts, hash: creator.hash });
  if (!funders.length && creator) funders.push({ account: creator.account, near: creator.near, ts: creator.ts, hash: creator.hash, creatorOnly: true }); // only the relayer is known
  if (!funders.length) { // sub-account: its parent created it
    const dot = account.indexOf('.');
    if (dot > 0 && !/^[0-9a-f]{64}$/.test(account)) { const parent = account.slice(dot + 1); if (parent && parent !== 'near') funders.push({ account: parent, near: null, ts: created, hash: null, viaParent: true }); }
  }
  const f0 = funders[0];
  return { funders, funder: f0?.account ?? null, near: f0?.near ?? null, ts: f0?.ts ?? null, hash: f0?.hash ?? null, creator: creator?.account ?? null, txCount: count, created, viaParent: !!f0?.viaParent, creatorOnly: !!f0?.creatorOnly };
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
  const chain = [], edges = [], fundersOut = [];
  // every meaningful funder (the earliest first): classify it and draw the edge
  for (const x of f.funders) {
    const byName = classifyAccount(x.account, null);
    const txc = byName === 'wallet' ? await txCountOf(x.account) : null;
    fundersOut.push({ account: x.account, kind: byName === 'wallet' ? classifyAccount(x.account, txc) : byName, near: x.near, ts: x.ts, tx_count: txc, creator_only: !!x.creatorOnly, via: x.via || null, hash: x.hash || null });
    edges.push({ _id: `fund|${x.account}|${account}`, type: 'fund', from: x.account, to: account, near: x.near, first_ts: x.ts, hash: x.hash, hop: 1 });
  }
  // follow the first funder up the chain (its funder, and so on) while it is an ordinary wallet
  let cur = f.funder, hop = 1, from = account, fundNear = f.near, fundTs = f.ts, fundHash = f.hash;
  const seen = new Set([account]);
  while (cur && hop <= config.graph.fundingDepth && !seen.has(cur)) {
    seen.add(cur);
    const node = hop === 1 && fundersOut[0]?.account === cur ? { kind: fundersOut[0].kind, tx_count: fundersOut[0].tx_count, ...(await funderNode(cur)) } : await funderNode(cur);
    chain.push({ account: cur, kind: node.kind, hop, near: fundNear, tx_count: node.tx_count });
    if (hop > 1) edges.push({ _id: `fund|${cur}|${from}`, type: 'fund', from: cur, to: from, near: fundNear, first_ts: fundTs, hash: fundHash, hop });
    if (isGenericKind(node.kind)) break; // exchanges / relayers / intents: stop, they link nothing
    from = cur; cur = node.funder; fundNear = node.funding_near; fundTs = node.funding_ts; fundHash = node.funding_hash; hop++;
  }
  let flows = [];
  if (kind !== 'hub') { try { flows = await recentOutflows(account, config.graph.flowLookbackTxs); } catch (e) { warn(`flows of ${account} failed: ${e.message}`); } }
  for (const fl of flows.slice(0, 20)) edges.push({ _id: `flow|${account}|${fl.to}`, type: 'flow', from: account, to: fl.to, near: fl.near, n: fl.n, last_ts: fl.last_ts });
  if (edges.length) await col('edges').bulkWrite(edges.map((e) => ({ replaceOne: { filter: { _id: e._id }, replacement: e, upsert: true } })), { ordered: false });
  const first = chain[0];
  await col('wallets').updateOne({ _id: account }, { $set: {
    profiled: true, profiled_ts: Date.now(), created_ts: f.created, tx_count: f.txCount, kind, funder: first?.account ?? null, funder_kind: first?.kind ?? null, funders: fundersOut, funder_creator: f.creator, funder_creator_only: !!f.creatorOnly,
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
