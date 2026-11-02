// USD prices of NEAR tokens for sizing losses: Ref Finance's price list (price per whole token, with decimals and symbol), Intear's for
// what Ref doesn't list, NEAR itself from wNEAR. Cached 10 minutes. Prices are today's, not the incident's: reports say so.
import { view } from '../near/rpc.js';
import { NEAR } from './flows.js';

let cache = { ts: 0, ref: new Map(), intear: new Map() };
const metaCache = new Map();
async function load() {
  if (Date.now() - cache.ts < 600e3 && cache.ref.size) return cache;
  const get = (u) => fetch(u, { signal: AbortSignal.timeout(20000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [ref, intear] = await Promise.all([get('https://indexer.ref.finance/list-token-price'), get('https://prices.intear.tech/prices')]);
  const m = new Map(), n = new Map();
  for (const [id, v] of Object.entries(ref || {})) if (Number(v.price) > 0) m.set(id, { usd: Number(v.price), decimals: v.decimal, symbol: v.symbol });
  for (const [id, v] of Object.entries(intear || {})) if (Number(v) > 0) n.set(id, Number(v));
  if (m.size || n.size) cache = { ts: Date.now(), ref: m, intear: n };
  return cache;
}
/** { symbol, decimals } of a token (cached); NEAR and intents balances resolve to their token. */
export async function tokenMeta(token) {
  const id = baseToken(token);
  if (id === NEAR) return { symbol: 'NEAR', decimals: 24 };
  if (metaCache.has(id)) return metaCache.get(id);
  const c = await load(), r = c.ref.get(id);
  let m = r ? { symbol: r.symbol, decimals: r.decimals } : null;
  if (!m) { try { const x = await view(id, 'ft_metadata'); m = { symbol: x?.symbol || id, decimals: Number.isInteger(x?.decimals) ? x.decimals : 18 }; } catch { m = { symbol: id.split('.')[0].slice(0, 12), decimals: 18 }; } }
  metaCache.set(id, m);
  return m;
}
/** The token a flow token stands for: intents:<id> -> <id>; NEAR -> NEAR. */
export const baseToken = (t) => String(t).replace(/^intents:/, '').replace(/^nep141:/, '');
/** USD per whole token, or null when no one prices it. */
export async function usdPrice(token) {
  const id = baseToken(token), c = await load();
  if (id === NEAR) return c.ref.get('wrap.near')?.usd ?? c.intear.get('wrap.near') ?? null;
  return c.ref.get(id)?.usd ?? c.intear.get(id) ?? null;
}
/** Whole-token amount from a raw integer string. */
export function units(raw, decimals) {
  const d = BigInt(Math.max(0, decimals - 6));
  return Number(BigInt(raw) / 10n ** d) / 10 ** Math.min(6, decimals);
}
/** { amount, usd, symbol } of a raw amount. */
export async function valueOf(token, raw) {
  if (/^nft:/.test(token)) return { amount: Number(raw), usd: null, symbol: token.slice(4) };
  const [m, p] = await Promise.all([tokenMeta(token), usdPrice(token)]);
  const amount = units(raw, m.decimals);
  return { amount, usd: p != null ? amount * p : null, symbol: m.symbol };
}
