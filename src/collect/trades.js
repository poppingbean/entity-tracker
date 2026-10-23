// Trades of a launched token, read from the token contract's own transaction history (oldest first) and stored in MongoDB.
import { col } from '../db.js';
import { config } from '../config.js';
import { accountRows, fetchTxs } from '../near/indexer.js';
import { DCL, REFV2, WNEAR, decimals, units, quoteNearPrice } from '../near/quotes.js';
import { yoctoToNear } from '../near/rpc.js';
import { cfgFor } from './cfg.js';

const GAYPAD = 'gaypad.j1-racing.near';
const AGGREGATORS = /^(aggregatedex\.near|dex\.intear\.near|router\.aurabot\.near|cosmosnock\.near)$/;
// Accounts that hold tokens for the venue itself and say nothing about an investor.
export const INFRA = /^(dclv2\.ref-labs\.near|v2\.ref-finance\.near|aggregatedex\.near|dex\.intear\.near|nearlytrade\.near|lock2\.nearlytrade\.near|meme-cooking\.near|launchpad\.justhoot\.near|gaypad\.j1-racing\.near|liquidity\.qlyphs\.near|tkn\.near|v2-launchpad\.justhoot\.near|v2-pool-creator\.justhoot\.near|token-locker\.ref-labs\.near|intents\.near|wrap\.near)$/;

/** Buys and sells of `token` in a list of decoded transactions, with NEAR values. */
export async function tradesFromTxs(token, pool, txs) {
  const dec = await decimals(token);
  const q = pool.quote, qDec = await decimals(q), qPx = pool.dex === 'curve' ? 1 : await quoteNearPrice(q);
  const out = [], transfers = [];
  for (const tx of txs) {
    if (tx.failed) continue;
    const refunded = new Set(tx.events.filter((e) => e.event === 'ft_transfer' && (e.data || []).some((d) => /refund/.test(d.memo || ''))).flatMap((e) => e.data.map((d) => d.amount)));
    let idx = 0;
    if (pool.dex === 'curve') {
      // gaypad bonding curve: every swap event carries the reserves after the trade; the NEAR side of the trade is the change in the
      // wNEAR reserve under a constant product (commission and the input token's own price do not matter)
      for (const e of tx.events.filter((x) => x.executor === GAYPAD && x.event === 'token_swap')) for (const s of e.data || []) {
        const buy = s.output_token === token, sell = s.input_token === token;
        if (!buy && !sell) continue;
        try {
          const hTok = BigInt(s.token_hold), hNear = BigInt(s.wnear_hold), amt = BigInt(buy ? s.output_amount : s.input_amount);
          const preTok = buy ? hTok + amt : hTok - amt;
          if (preTok <= 0n || hTok <= 0n) continue;
          const preNear = (hNear * hTok) / preTok;
          const nearRaw = buy ? hNear - preNear : preNear - hNear;
          if (nearRaw <= 0n) continue;
          out.push({ _id: `${tx.hash}|${idx++}`, token, ts: tx.ts, height: tx.height, hash: tx.hash, trader: s.user_id || tx.signer, buy, near: yoctoToNear(nearRaw.toString()), tokens: units(amt.toString(), dec) });
        } catch { /* malformed event */ }
      }
    } else if (pool.dex === 'dcl') {
      for (const e of tx.events.filter((x) => x.executor === DCL && x.event === 'swap')) for (const s of e.data || []) {
        if (s.pool_id !== pool.poolId || refunded.has(s.amount_in) || s.amount_in === '0') continue;
        const buy = s.token_in === q;
        if (!buy && s.token_in !== token) continue;
        const trader = AGGREGATORS.test(s.swapper) ? tx.signer : s.swapper;
        const near = units(buy ? s.amount_in : s.amount_out, qDec) * qPx, tokens = units(buy ? s.amount_out : s.amount_in, dec);
        out.push({ _id: `${tx.hash}|${idx++}`, token, ts: tx.ts, height: tx.height, hash: tx.hash, trader, buy, near, tokens });
      }
    } else {
      for (const l of tx.logs.filter((x) => x.executor === REFV2)) {
        const m = l.text.match(/^Swapped (\d+) ([^\s,]+) for (\d+) ([^\s,]+)/); if (!m) continue; // "..., total fee N, admin fee N" follows
        const buy = m[2] === WNEAR && m[4] === token, sell = m[2] === token && m[4] === WNEAR; if (!buy && !sell) continue;
        out.push({ _id: `${tx.hash}|${idx++}`, token, ts: tx.ts, height: tx.height, hash: tx.hash, trader: tx.signer, buy, near: yoctoToNear(buy ? m[1] : m[3]), tokens: units(buy ? m[3] : m[1], dec) });
      }
    }
    // token hand-offs between wallets (not through a venue): a classic way to move a position to a fresh wallet
    let ti = 0;
    for (const e of tx.events.filter((x) => x.executor === token && x.event === 'ft_transfer')) for (const d of e.data || []) {
      if (!d.old_owner_id || !d.new_owner_id || INFRA.test(d.old_owner_id) || INFRA.test(d.new_owner_id) || d.old_owner_id === token || d.new_owner_id === token) continue;
      transfers.push({ _id: `${tx.hash}|t${ti++}`, token, ts: tx.ts, hash: tx.hash, from: d.old_owner_id, to: d.new_owner_id, tokens: units(d.amount || '0', dec) });
    }
  }
  return { trades: out, transfers };
}

/**
 * Pull new transactions of the token contract since the last sync (oldest first), store the trades, advance the cursor.
 * Reads up to the last outcome checkpoint, or up to now with `full` (the ledger follow-up).
 * Returns { added, done, reachedEnd, lastTs }: done = the token's history has been read past its last outcome checkpoint;
 * reachedEnd = nothing more to read right now.
 */
export async function syncTokenTrades(token, { maxRows = 1000, full = false } = {}) {
  const horizon = token.live_ts + config.outcome.minutes[config.outcome.minutes.length - 1] * 60e3;
  const fromHeight = token.sync_height || token.live_height || undefined;
  const { rows } = await accountRows(token._id, { desc: false, fromHeight, maxRows, untilTs: full ? undefined : horizon });
  const fresh = rows.filter((r) => r.ts >= token.live_ts - 5000 && r.ok);
  const txs = fresh.length ? await fetchTxs(fresh.map((r) => r.hash)) : [];
  const { trades, transfers } = await tradesFromTxs(token._id, token.pool, txs);
  const keep = trades.filter((t) => t.near >= cfgFor(token).keepNear);
  if (keep.length) await col('trades').bulkWrite(keep.map((t) => ({ replaceOne: { filter: { _id: t._id }, replacement: t, upsert: true } })), { ordered: false });
  if (transfers.length) await col('transfers').bulkWrite(transfers.map((t) => ({ replaceOne: { filter: { _id: t._id }, replacement: t, upsert: true } })), { ordered: false });
  const last = rows.at(-1);
  const reachedEnd = rows.length < maxRows; // fewer rows than asked: nothing newer exists (yet) or we stopped at the horizon
  const pastHorizon = Date.now() > horizon && reachedEnd;
  await col('tokens').updateOne({ _id: token._id }, { $set: { sync_height: last?.height ?? token.sync_height ?? null, sync_ts: Date.now(), trades_n: (token.trades_n || 0) + keep.length } });
  return { added: keep.length, done: pastHorizon, reachedEnd, lastTs: last?.ts ?? null };
}
