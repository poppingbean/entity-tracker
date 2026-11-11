// What a transaction moves besides attached NEAR: fungible tokens sent with ft_transfer / ft_transfer_call (NEP-141), and balances moved
// inside NEAR Intents (ft_withdraw, mt_transfer, mt_transfer_call, mt_batch_transfer, mt_batch_transfer_call; ids like nep141:<token>).
// The Agent Guard's spending limits count these: an agent capped at 5 NEAR must not be able to send its whole USDC balance with ft_transfer.
// `tokenMoves` is pure; `valueMoves` prices them at today's rate (a check is "now").
import { valueOf, usdPrice } from '../incident/prices.js';

const FT = new Set(['ft_transfer', 'ft_transfer_call']);
const INTENTS = 'intents.near';
const nep141 = (id) => String(id || '').replace(/^nep141:/, '');
const isRaw = (x) => /^\d+$/.test(String(x ?? ''));

/** [{ tx, action, token, raw, to, via }] for every token amount the transactions send out. Pure. */
export function tokenMoves(txs) {
  const out = [];
  (txs || []).forEach((t, ti) => {
    for (const a of t.actions || []) {
      if (a.kind !== 'function_call' || !a.args || typeof a.args !== 'object') continue;
      const m = String(a.method || ''), g = a.args, at = { tx: ti, action: a.index ?? null };
      if (FT.has(m) && isRaw(g.amount)) out.push({ ...at, token: t.receiver, raw: String(g.amount), to: g.receiver_id || null, via: m });
      else if (t.receiver === INTENTS && m === 'ft_withdraw' && isRaw(g.amount)) out.push({ ...at, token: nep141(g.token), raw: String(g.amount), to: g.receiver_id || null, via: 'intents ft_withdraw' });
      else if (t.receiver === INTENTS && /^mt_transfer(_call)?$/.test(m) && isRaw(g.amount)) out.push({ ...at, token: nep141(g.token_id), raw: String(g.amount), to: g.receiver_id || null, via: `intents ${m}` });
      else if (t.receiver === INTENTS && /^mt_batch_transfer(_call)?$/.test(m) && Array.isArray(g.token_ids)) {
        g.token_ids.forEach((id, i) => { if (isRaw(g.amounts?.[i])) out.push({ ...at, token: nep141(id), raw: String(g.amounts[i]), to: g.receiver_id || null, via: `intents ${m}` }); });
      }
    }
  });
  return out;
}

/** The moves with their amount and USD value today ({ symbol, amount, usd }; usd null when the token has no price). Never throws. */
export async function valueMoves(moves, { timeoutMs = 2000 } = {}) {
  const one = (m) => Promise.race([
    valueOf(m.token, m.raw).then((v) => ({ ...m, symbol: v.symbol || null, amount: v.amount ?? null, usd: v.usd == null ? null : Math.round(v.usd * 100) / 100 })),
    new Promise((r) => setTimeout(() => r({ ...m, symbol: null, amount: null, usd: null }), timeoutMs)),
  ]).catch(() => ({ ...m, symbol: null, amount: null, usd: null }));
  return Promise.all(moves.slice(0, 50).map(one));
}

/** NEAR in USD today (null when unknown). */
export const nearUsd = () => usdPrice('wrap.near').catch(() => null);
