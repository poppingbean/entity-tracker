// Any wallet, as the chain shows it: for the wallet page when the tracker has not profiled the account (only early launch buyers are).
// Balance and age, keys, tokens held, recent transactions in plain words, and what Safe Near knows about it (flags, hacks it is linked to,
// the entity record, tokens it launched). Cached a minute.
import { col } from '../db.js';
import { txIndexer, fastnearGet } from './rpc.js';
import { viewAccount, viewAccessKeyList } from '../audit/rpc.js';
import { builtinLabel } from '../labels.js';
import { flowsOfTx, NEAR } from '../incident/flows.js';
import { valueOf } from '../incident/prices.js';

const cache = new Map();
const near = (y) => { try { return Number(BigInt(y) / 10n ** 21n) / 1e3; } catch { return null; } };
const actionText = (a) => {
  if (typeof a === 'string') return a;
  if (a.Transfer) return `send ${near(a.Transfer.deposit)} NEAR`;
  if (a.FunctionCall) { const d = near(a.FunctionCall.deposit); return `${a.FunctionCall.method_name}${d >= 0.01 ? ` (${d} NEAR)` : ''}`; }
  if (a.AddKey) return `add ${a.AddKey.access_key?.permission === 'FullAccess' ? 'full-access ' : 'app '}key`;
  return Object.keys(a)[0].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
};

/** The on-chain view of one account, or null when it does not exist. */
export async function walletView(id) {
  const c = cache.get(id);
  if (c && Date.now() - c.ts < 60e3) return c.value;
  const state = await viewAccount(id).catch(() => null);
  if (!state) return null;
  const [keys, full, recent, first, flags, incidents, entity, launches] = await Promise.all([
    viewAccessKeyList(id).catch(() => []),
    fastnearGet(`/v1/account/${encodeURIComponent(id)}/full`).catch(() => null),
    txIndexer('/v0/account', { account_id: id, limit: 25, desc: true }).catch(() => null),
    txIndexer('/v0/account', { account_id: id, limit: 1, desc: false }).catch(() => null),
    col('firewall_flags').find({ _id: id, private: { $ne: true } }).toArray().catch(() => []),
    col('incidents').find({ status: 'confirmed', $or: [{ 'accounts.account': id }, { 'target.account': id }, { 'sources.account': id }] }, { projection: { kind: 1, stolen_usd: 1, started_ts: 1, 'ai.headline': 1, drain: 1, 'target.account': 1, accounts: 1, sources: 1 } }).limit(5).toArray().catch(() => []),
    col('entities').findOne({ _id: id }, { projection: { kind: 1, label: 1, label_source: 1, tx_count: 1, funded_n: 1 } }).catch(() => null),
    col('tokens').countDocuments({ creator: id }).catch(() => 0),
  ]);
  // tokens held, valued (the largest first)
  const toks = (full?.tokens || []).filter((t) => t.balance && t.balance !== '0').slice(0, 60);
  const held = (await Promise.all(toks.map(async (t) => ({ token: t.contract_id, ...(await valueOf(t.contract_id, t.balance)) })))).filter((t) => (t.usd || 0) >= 1).sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, 15);
  // recent transactions in plain words, with what moved in and out of this account
  const hashes = (recent?.account_txs || []).map((r) => r.transaction_hash);
  const txs = [];
  for (let i = 0; i < hashes.length; i += 20) txs.push(...((await txIndexer('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) }).catch(() => null))?.transactions || []));
  txs.sort((a, b) => (b.execution_outcome?.block_height || 0) - (a.execution_outcome?.block_height || 0));
  const rows = await Promise.all(txs.map(async (t) => {
    const ins = [], outs = [];
    for (const f of flowsOfTx(t)) {
      if (f.to !== id && f.from !== id || /^(nft|mint|burn|intents|chain):/.test(f.token + f.from + f.to)) continue;
      const v = await valueOf(f.token, f.raw);
      if (!v.amount) continue;
      (f.to === id ? ins : outs).push({ symbol: v.symbol, amount: v.amount, usd: v.usd != null ? Math.round(v.usd) : null, other: f.to === id ? f.from : f.to });
    }
    return { tx: t.transaction.hash, ts: Number(t.execution_outcome?.block_timestamp || 0) / 1e6 || null, signer: t.transaction.signer_id, receiver: t.transaction.receiver_id,
      did: (t.transaction.actions || []).slice(0, 3).map(actionText).join(', '), failed: (t.receipts || []).some((r) => r.execution_outcome?.outcome?.status?.Failure), in: ins.slice(0, 3), out: outs.slice(0, 3) };
  }));
  const nearUsd = (await valueOf(NEAR, state.amount)).usd;
  const role = (inc) => (inc.sources || []).some((s) => s.account === id) ? 'source of the stolen money' : inc.target?.account === id ? 'the contract that was hit' : (inc.accounts || []).find((a) => a.account === id)?.role?.replace(/_/g, ' ') || null;
  const value = {
    id, balance_near: near(state.amount), balance_usd: nearUsd != null ? Math.round(nearUsd) : null, contract: state.code_hash !== '11111111111111111111111111111111' || !!state.global_contract_hash,
    tx_count: recent?.txs_count ?? null, first_ts: first?.account_txs?.[0] ? Number(first.account_txs[0].tx_block_timestamp) / 1e6 : null,
    keys: { full: keys.filter((k) => k.access_key?.permission === 'FullAccess').length, app: keys.filter((k) => k.access_key?.permission?.FunctionCall).length },
    tokens: held, tokens_usd: Math.round(held.reduce((s, t) => s + (t.usd || 0), 0)), nft_collections: (full?.nfts || []).length,
    label: builtinLabel(id)?.label || (entity?.label_source !== 'kind' ? entity?.label : null) || null, entity: entity ? { kind: entity.kind, label: entity.label, funded_n: entity.funded_n } : null,
    flags: flags.map((f) => ({ severity: f.severity, reason: f.reason })), incidents: incidents.map((i) => ({ id: i._id, kind: i.kind, stolen_usd: i.stolen_usd, when: i.started_ts, headline: i.ai?.headline || null, exchange: i.drain?.exchange || null, role: role(i) })),
    launches, recent: rows,
  };
  cache.set(id, { ts: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
