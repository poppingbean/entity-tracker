// A token's total supply and last traded price, for market caps and for valuing token amounts (transfers).
import { col } from '../db.js';
import { view } from '../near/rpc.js';
import { decimals, units } from '../near/quotes.js';

/** Total supply: kept on the token, else the scanner's first check, else read from the contract once and kept on the token. Null when unknown. */
export async function tokenSupply(id) {
  const t = await col('tokens').findOne({ _id: id }, { projection: { supply: 1 } });
  if (t?.supply > 0) return t.supply;
  const s = await col('scans').findOne({ token: id, 'features.market.totalSupply': { $gt: 0 } }, { projection: { 'features.market.totalSupply': 1 } });
  if (s) return s.features.market.totalSupply;
  try {
    const sup = units(String(await view(id, 'ft_total_supply')), await decimals(id));
    if (sup > 0) { await col('tokens').updateOne({ _id: id }, { $set: { supply: sup } }); return sup; }
  } catch {}
  return null;
}

/** The last trade big enough to price the token (dust trades round badly): { price (NEAR per token), ts }, or null. */
export async function lastPrice(id) {
  const t = await col('trades').find({ token: id, near: { $gte: 0.02 }, tokens: { $gt: 0 } }, { projection: { near: 1, tokens: 1, ts: 1 } }).sort({ ts: -1 }).limit(1).next();
  return t ? { price: t.near / t.tokens, ts: t.ts } : null;
}
