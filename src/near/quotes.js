// Pool quote tokens and how to value them in NEAR. Launch pools are quoted in wNEAR, NEARLY, RHEA or QTC; amounts of the
// other quotes are converted at the current price of a 1-NEAR bridge quote (good enough to size early buys).
import { view } from './rpc.js';

export const WNEAR = 'wrap.near';
export const DCL = 'dclv2.ref-labs.near', REFV2 = 'v2.ref-finance.near';

export const QUOTES = {
  'wrap.near': { symbol: 'wNEAR', bridge: null },
  'nearly-993927.nearlytrade.near': { symbol: 'NEARLY', bridge: { dex: 'dcl', poolId: 'nearly-993927.nearlytrade.near|wrap.near|10000' } },
  'token.rhealab.near': { symbol: 'RHEA', bridge: { dex: 'refv2', poolId: 6458 } },
  'qtc.omft.near': { symbol: 'QTC', bridge: { dex: 'dcl', poolId: 'qtc.omft.near|wrap.near|10000' } },
};
export const isKnownQuote = (q) => !!QUOTES[q];
export const quoteSymbol = (q) => QUOTES[q]?.symbol || q;

const decMap = new Map([[WNEAR, 24]]);
export async function decimals(token) {
  if (!decMap.has(token)) { try { decMap.set(token, (await view(token, 'ft_metadata')).decimals); } catch { decMap.set(token, 18); } }
  return decMap.get(token);
}
export const units = (raw, dec) => Number(BigInt(raw) / 10n ** BigInt(Math.max(0, dec - 6))) / 10 ** Math.min(6, dec);

const priceCache = new Map();
/** NEAR value of one whole quote token (cached 5 min). */
export async function quoteNearPrice(q) {
  if (q === WNEAR) return 1;
  const c = priceCache.get(q);
  if (c && Date.now() - c.ts < 300e3) return c.price;
  const b = QUOTES[q]?.bridge;
  if (!b) return 0;
  const amt = (10n ** 24n).toString();
  let raw = '0';
  try {
    raw = b.dex === 'dcl'
      ? (await view(DCL, 'quote', { pool_ids: [b.poolId], input_token: WNEAR, output_token: q, input_amount: amt }))?.amount || '0'
      : (await view(REFV2, 'get_return', { pool_id: b.poolId, token_in: WNEAR, amount_in: amt, token_out: q })) || '0';
  } catch {}
  const out = units(raw, await decimals(q));
  const price = out > 0 ? 1 / out : 0;
  priceCache.set(q, { ts: Date.now(), price });
  return price;
}
