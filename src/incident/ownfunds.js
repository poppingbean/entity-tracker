// Is a large withdrawal from a protocol the wallet's own money? A whale unstaking from LiNEAR or taking its collateral out of Burrow is the
// biggest outflow a protocol ever sees, and looks just like a drain. The difference is in the wallet's past: it put the money in first.
// Look back through the transactions the wallet signed (oldest first) for what it paid into that protocol, at least a day before the
// withdrawal: staking deposits (NEAR attached to deposit_and_stake, near_deposit …) and tokens sent in (ft_transfer_call). When those cover at
// least half of what it took out (rewards and price moves account for the rest), it is a withdrawal of its own funds, not a hack.
import { txIndexer } from '../near/rpc.js';
import { flowsOfTx, NEAR } from './flows.js';
import { valueOf, baseToken } from './prices.js';

const MAX_ROWS = 4000;      // signed transactions read at most (oldest first)
const BEFORE_MS = 86400e3;  // deposits count only when made at least a day before the withdrawal (an exploit deposits and takes in one go)
const cache = new Map();    // `${wallet}|${protocol}` -> result (an hour)

async function fetchBatch(hashes) {
  const out = [];
  for (let i = 0; i < hashes.length; i += 20) out.push(hashes.slice(i, i + 20));
  const res = [];
  let k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (k < out.length) { const g = out[k++]; res.push(...((await txIndexer('/v0/transactions', { tx_hashes: g }).catch(() => null))?.transactions || [])); } }));
  return res;
}

/**
 * What `wallet` paid into `protocol` before `beforeTs` - BEFORE_MS, and whether it covers `withdrawnUsd`.
 * Returns { own_funds, deposited_usd, deposits: [{ token, symbol, amount, usd }], first_ts, last_ts, txs, scanned, explanation }.
 */
export async function ownFunds(wallet, protocol, { beforeTs = Date.now(), withdrawnUsd = 0 } = {}) {
  const key = `${wallet}|${protocol}|${Math.round(withdrawnUsd)}`;
  const c = cache.get(key);
  if (c && Date.now() - c.ts < 3600e3) return c.value;
  const per = new Map(); let first = null, last = null, scanned = 0, depositUsd = 0; const txs = [];
  let resume = null;
  outer: while (scanned < MAX_ROWS) {
    const j = await txIndexer('/v0/account', { account_id: wallet, limit: 200, desc: false, is_signer: true, ...(resume ? { resume_token: resume } : {}) }).catch(() => null);
    const rows = (j?.account_txs || []).filter((r) => Number(r.tx_block_timestamp) / 1e6 < beforeTs - BEFORE_MS);
    if (!rows.length) break;
    scanned += rows.length;
    for (const t of await fetchBatch(rows.map((r) => r.transaction_hash))) {
      const ts = Number(t.execution_outcome?.block_timestamp || 0) / 1e6;
      for (const f of flowsOfTx(t)) {
        // paid into the protocol by this wallet: NEAR attached to a call, or tokens transferred in
        if (f.from !== wallet || f.to !== protocol || /^(nft|intents|mint|burn):/.test(f.token)) continue;
        per.set(f.token, (per.get(f.token) || 0n) + BigInt(f.raw));
        first = first ? Math.min(first, ts) : ts; last = last ? Math.max(last, ts) : ts;
        if (txs.length < 5 && !txs.includes(f.tx)) txs.push(f.tx);
      }
    }
    // stop as soon as the deposits found cover the withdrawal
    depositUsd = 0;
    for (const [token, raw] of per) depositUsd += (await valueOf(token, raw.toString())).usd || 0;
    if (withdrawnUsd && depositUsd >= 0.5 * withdrawnUsd) break outer;
    if (!j.resume_token || rows.length < (j.account_txs || []).length) break;
    resume = j.resume_token;
  }
  const deposits = await Promise.all([...per].map(async ([token, raw]) => { const v = await valueOf(token, raw.toString()); return { token: baseToken(token), symbol: v.symbol, amount: v.amount, usd: v.usd != null ? Math.round(v.usd) : null }; }));
  deposits.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const own = withdrawnUsd > 0 && depositUsd >= 0.5 * withdrawnUsd;
  const fmt = (x) => (x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : Math.round(x).toString());
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const value = { own_funds: own, deposited_usd: Math.round(depositUsd), deposits, first_ts: first, last_ts: last, txs, scanned,
    explanation: deposits.length ? `${own ? 'Its own funds: it' : 'It'} put ${deposits.slice(0, 3).map((d) => `${fmt(d.amount)} ${d.symbol}`).join(', ')} (~$${Math.round(depositUsd).toLocaleString('en-US')} today) into ${protocol} between ${day(first)} and ${day(last)}${own ? '' : `, less than half of the ~$${Math.round(withdrawnUsd).toLocaleString('en-US')} it took out`}.`
      : `No deposit into ${protocol} made at least a day before the withdrawal (${scanned.toLocaleString('en-US')} of its transactions read).` };
  cache.set(key, { ts: Date.now(), value });
  return value;
}
export { NEAR };
