// Where the money came from: the investigation's other direction. From a suspect wallet, follow its large inflows back, hop by hop, until
// they reach an exchange, a contract, or a wallet that was already there long before. Two things fall out of it:
//   sources   who the money came from, each named (an exchange hot wallet, a contract, a wallet) with the path to the suspect
//   drain     an exchange hot wallet that sent a large amount to an account that had just been created: an exchange hack. Its first
//             receiver is the attacker's real wallet (the "root"); the suspect is one of the wallets the root paid out to
// Exchange hot wallets often have no NEAR name. They are recognised by what they do: thousands of transactions and the deposits they
// sweep, the `hub` kind the tracker gives them, and above all where they send their reserves (a hot wallet that tops up or sweeps to
// binancecold3.near is Binance's).
import { col } from '../db.js';
import { config } from '../config.js';
import { txIndexer } from '../near/rpc.js';
import { viewAccount } from '../audit/rpc.js';
import { builtinLabel } from '../labels.js';
import { flowsOfTx } from './flows.js';
import { valueOf } from './prices.js';

const ROUTERS = new Set(['wrap.near', 'intents.near', 'aggregatedex.near', 'v2.ref-finance.near', 'dclv2.ref-labs.near', 'system', 'near']);
const PSEUDO = /^(mint|burn|intents|chain|nft):/;
const cache = new Map();
const firstTx = async (id) => {
  const j = await txIndexer('/v0/account', { account_id: id, limit: 1, desc: false }).catch(() => null);
  const r = j?.account_txs?.[0];
  return r ? { ts: Number(r.tx_block_timestamp) / 1e6, hash: r.transaction_hash, total: j.txs_count } : null;
};

/** What an account is, for an investigation: { kind: exchange | contract | wallet, name, how, tx_count, first_ts }. Cached. */
export async function identify(id) {
  if (cache.has(id)) return cache.get(id);
  const b = builtinLabel(id);
  const [ent, lab, first, state, reg] = await Promise.all([col('entities').findOne({ _id: id }, { projection: { kind: 1, label: 1, label_source: 1 } }).catch(() => null), col('labels').findOne({ _id: id }).catch(() => null),
    firstTx(id), viewAccount(id).catch(() => null), col('exchange_wallets').findOne({ _id: id }).catch(() => null)]);
  let out;
  if (reg) out = { kind: 'exchange', name: `${reg.exchange || 'Unnamed exchange'} ${reg.kind === 'cold' ? 'cold' : 'hot'} wallet`, how: reg.how || 'in the exchange wallet registry' };
  else if (lab?.label) out = { kind: lab.type === 'exchange' ? 'exchange' : 'wallet', name: lab.label, how: 'named by hand' };
  else if (b?.type === 'exchange') out = { kind: 'exchange', name: b.label, how: 'account name' };
  if (!out) {
    const busy = (first?.total || 0) >= 20000 || ent?.kind === 'hub';
    if (busy) {
      // a busy wallet: whose exchange is it? the exchange-named accounts it sends its reserves to say so
      const sweep = await sweepTarget(id);
      out = sweep ? { kind: 'exchange', name: `${sweep.label} hot wallet`, how: `sends its reserves to ${sweep.to}` } : { kind: 'exchange', name: ent?.label && ent.label_source !== 'kind' ? ent.label : 'Unnamed exchange hot wallet', how: `${(first?.total || 0).toLocaleString('en-US')} transactions${ent?.kind === 'hub' ? ', pays out to many wallets' : ''}` };
    }
  }
  if (!out) {
    const contract = state && (state.code_hash !== '11111111111111111111111111111111' || state.global_contract_hash || state.global_contract_account_id);
    out = contract ? { kind: 'contract', name: b?.label || null, how: 'has code' } : { kind: 'wallet', name: b?.label || null, how: null };
  }
  out = { ...out, tx_count: first?.total ?? null, first_ts: first?.ts ?? null };
  cache.set(id, out);
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return out;
}
/** The exchange-named account a busy wallet sends its NEAR to (its own cold wallet), from its latest 60 transactions it signed. */
async function sweepTarget(id) {
  const j = await txIndexer('/v0/account', { account_id: id, limit: 60, desc: true, is_signer: true }).catch(() => null);
  const hashes = (j?.account_txs || []).map((r) => r.transaction_hash);
  if (!hashes.length) return null;
  const got = [];
  for (let i = 0; i < hashes.length; i += 20) got.push(...((await txIndexer('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) }).catch(() => null))?.transactions || [])); // 20 per call
  for (const x of got) {
    if (x.transaction.signer_id !== id) continue;
    const l = builtinLabel(x.transaction.receiver_id);
    if (l?.type === 'exchange') return { to: x.transaction.receiver_id, label: l.label };
  }
  return null;
}

/** Large inflows of an account (NEAR and priced tokens), grouped by sender: [{ from, usd, txs, first_ts, items }], biggest first. */
async function inflows(id, txs, minUsd) {
  const per = new Map();
  for (const t of txs) for (const f of flowsOfTx(t)) {
    if (f.to !== id || f.from === id || ROUTERS.has(f.from) || PSEUDO.test(f.from) || /^nft:/.test(f.token)) continue;
    const v = await valueOf(f.token, f.raw);
    const x = per.get(f.from) || { from: f.from, usd: 0, txs: new Set(), first_ts: f.ts, items: [] };
    x.usd += v.usd || 0; x.txs.add(f.tx); x.first_ts = Math.min(x.first_ts, f.ts); x.items.push({ token: f.token, symbol: v.symbol, amount: v.amount, usd: v.usd, tx: f.tx, ts: f.ts });
    per.set(f.from, x);
  }
  return [...per.values()].filter((x) => x.usd >= minUsd).map((x) => ({ ...x, txs: [...x.txs] })).sort((a, b) => b.usd - a.usd);
}

/**
 * Follow the money in, from `account` (its transactions already read: `txs`). `history(id)` reads another account's transactions.
 * Returns { sources, path, drain: null | { exchange, victims: [...], root, root_created_ts, usd } }.
 */
export async function upstream(account, txs, history, { maxHops = 3, minUsd = Math.max(1000, config.incidents.minUsd / 5) } = {}) {
  const sources = [], path = [];
  let cur = account, curTxs = txs, drain = null;
  for (let hop = 1; hop <= maxHops; hop++) {
    const ins = (await inflows(cur, curTxs, minUsd)).slice(0, 6);
    if (!ins.length) break;
    const ids = await Promise.all(ins.map((x) => identify(x.from)));
    const rows = ins.map((x, i) => ({ account: x.from, ...ids[i], usd: Math.round(x.usd), txs: x.txs.slice(0, 10), first_ts: x.first_ts, to: cur, hop,
      tokens: Object.values(x.items.reduce((m, it) => { const k = it.symbol; m[k] = m[k] || { symbol: k, amount: 0, usd: 0 }; m[k].amount += it.amount || 0; m[k].usd += it.usd || 0; return m; }, {})).map((t) => ({ ...t, usd: Math.round(t.usd) })) }));
    sources.push(...rows);
    // an exchange hot wallet that paid a large amount to an account created just before (or by that very payment): an exchange drain
    const curInfo = await identify(cur);
    const exch = rows.filter((r) => r.kind === 'exchange');
    const fresh = curInfo.first_ts != null && exch.length && exch.some((r) => r.first_ts - curInfo.first_ts < config.incidents.freshHours * 3600e3);
    const big = exch.reduce((s, r) => s + r.usd, 0);
    if (fresh && big >= config.incidents.alwaysUsd) {
      drain = { exchange: [...new Set(exch.map((r) => r.name.replace(/ hot wallet$/, '')))].join(', '), victims: exch, root: cur, root_created_ts: curInfo.first_ts, usd: Math.round(big) };
      path.push({ hop, account: cur, from: exch.map((r) => r.account) });
      break;
    }
    // keep going up through one wallet that sent most of the money and is not an exchange or a contract
    const next = rows.find((r) => r.kind === 'wallet');
    if (!next || exch.length || next.usd < rows[0].usd * 0.5) break;
    path.push({ hop, account: cur, from: [next.account] });
    cur = next.account;
    curTxs = await history(cur);
  }
  return { sources, path, drain };
}
