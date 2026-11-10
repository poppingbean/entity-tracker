// Prices at the time of an incident (WP-10). `usdAt(token, ts)` → { usd, basis, at_ts } with `basis` saying how the price was found, tried in order:
//   stable          USDT / USDC ids → 1
//   near_history    NEAR and wNEAR from an hourly NEAR/USD series (Binance klines by default, PRICE_HISTORY_URL), cached for good in `price_history`
//   tracker_trades  a token the tracker follows: its last traded price in NEAR at ts × the NEAR price at ts
//   implied         the case's own swaps: when the attacker swapped the token for NEAR or a stablecoin near ts, the two legs give a price (impliedPrices)
//   today           usdPrice(token), as before (the fallback; a basis the page shows)
// PRICE_AT_INCIDENT=false returns tier "today" only. Live detection keeps using today's prices (a live event is "now").
import { col } from '../db.js';
import { config } from '../config.js';
import { NEAR } from './flows.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { usdPrice, baseToken, tokenMeta, units } from './prices.js';

/** Set by traceIncident for the duration of one trace: { implied: Map(token → [{ ts, usd }]) }. valueOf reads it. */
export const priceCtx = new AsyncLocalStorage();

const STABLE = /^(usdt\.tether-token\.near|17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|[0-9a-f]{40}\.factory\.bridge\.near|usdc\.[a-z0-9.-]*near|eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\.[a-z0-9.-]*near|a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\.factory\.bridge\.near|dac17f958d2ee523a2206206994597c13d831ec7\.factory\.bridge\.near)$/;
const HOUR = 3600e3;
const hourOf = (ts) => Math.floor(ts / HOUR);

/** True for a stablecoin id. */
export const isStable = (token) => STABLE.test(baseToken(token));

// ---- NEAR/USD history
const mem = new Map(); // hour → price
/** Hourly NEAR/USD closes from a klines-style endpoint: [[openTime, open, high, low, close, …]]. Returns Map(hour → close). */
export function parseKlines(rows) {
  const m = new Map();
  for (const k of Array.isArray(rows) ? rows : []) { const c = Number(k?.[4]), t = Number(k?.[0]); if (Number.isFinite(c) && c > 0 && Number.isFinite(t)) m.set(hourOf(t), c); }
  return m;
}
async function fetchHours(fromTs, toTs) {
  const base = config.incidents.priceHistoryUrl;
  if (!base) return new Map();
  const url = `${base}${base.includes('?') ? '&' : '?'}symbol=NEARUSDT&interval=1h&startTime=${Math.floor(fromTs / HOUR) * HOUR}&endTime=${Math.ceil(toTs / HOUR) * HOUR}&limit=1000`;
  const rows = await fetch(url, { signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return parseKlines(rows);
}
/** NEAR/USD at `ts`: memory, then `price_history`, then one fetch of the surrounding days (stored for good: past prices do not change). Null when no source answers. */
export async function nearUsdAt(ts) {
  const h = hourOf(ts);
  if (mem.has(h)) return mem.get(h);
  const hit = await col('price_history').findOne({ _id: `near|${h}` }).catch(() => null);
  if (hit) { mem.set(h, hit.usd); return hit.usd; }
  if (ts > Date.now() - 2 * HOUR) return null; // the hour is not closed yet: "today"
  const got = await fetchHours(ts - 6 * 24 * HOUR, ts + 6 * 24 * HOUR);
  if (got.size) {
    await col('price_history').bulkWrite([...got].map(([hh, usd]) => ({ updateOne: { filter: { _id: `near|${hh}` }, update: { $setOnInsert: { _id: `near|${hh}`, usd, ts: hh * HOUR } }, upsert: true } })), { ordered: false }).catch(() => {});
    for (const [hh, usd] of got) mem.set(hh, usd);
  }
  return mem.get(h) ?? null;
}

// ---- implied prices from a case's own swaps (pure)
/**
 * Flows grouped by transaction: in one transaction an account that gave away token A and received token B (NEAR or a stablecoin) prices A.
 * flows: [{ tx, ts, token, from, to, raw }]; `amountOf(token, raw)` → whole-token amount; `known(token)` → USD per token for the other leg (1 for a stablecoin, the NEAR price for NEAR).
 * Returns Map(token → [{ ts, usd }]) (USD per whole token).
 */
export function impliedPrices(flows, amountOf, known) {
  const byTx = new Map();
  for (const f of flows) (byTx.get(f.tx) || byTx.set(f.tx, []).get(f.tx)).push(f);
  const out = new Map();
  for (const [, fs] of byTx) {
    const accounts = new Set(fs.flatMap((f) => [f.from, f.to]));
    for (const a of accounts) {
      const gave = fs.filter((f) => f.from === a), got = fs.filter((f) => f.to === a);
      for (const g of gave) for (const r of got) {
        if (g.token === r.token) continue;
        const kr = known(r.token); if (!(kr > 0)) continue;           // the leg we can price
        const ag = amountOf(g.token, g.raw), ar = amountOf(r.token, r.raw);
        if (!(ag > 0) || !(ar > 0)) continue;
        const usd = (ar * kr) / ag;
        const l = out.get(g.token) || []; l.push({ ts: g.ts, usd }); out.set(g.token, l);
      }
    }
  }
  return out;
}
/** The implied price nearest to ts within `withinMs` (default 24 h), or null. */
export function nearestImplied(list, ts, withinMs = 24 * HOUR) {
  let best = null;
  for (const p of list || []) { const d = Math.abs(p.ts - ts); if (d <= withinMs && (!best || d < best.d)) best = { d, usd: p.usd, ts: p.ts }; }
  return best && { usd: best.usd, at_ts: best.ts };
}

// ---- the entry point
/**
 * USD per whole token at `ts`. `opts.implied` is a Map from impliedPrices() for the case being traced. Never throws: a missing source falls
 * through to the next tier and in the end to today's price.
 */
export async function usdAt(token, ts, opts = {}) {
  const id = baseToken(token), today = async () => ({ usd: await usdPrice(token), basis: 'today', at_ts: Date.now() });
  if (!config.incidents.priceAtIncident || !Number.isFinite(ts)) return today();
  try {
    if (isStable(id)) return { usd: 1, basis: 'stable', at_ts: ts };
    if (id === NEAR || id === 'wrap.near') { const p = await nearUsdAt(ts); if (p) return { usd: p, basis: 'near_history', at_ts: ts }; return today(); }
    const trades = await col('trades').find({ token: id, ts: { $lte: ts } }, { projection: { near: 1, tokens: 1, ts: 1 } }).sort({ ts: -1 }).limit(1).toArray().catch(() => []);
    const t = trades[0];
    if (t && t.tokens > 0 && ts - t.ts <= 6 * HOUR) { const np = await nearUsdAt(ts); if (np) return { usd: (t.near / t.tokens) * np, basis: 'tracker_trades', at_ts: t.ts }; }
    const imp = nearestImplied(opts.implied?.get(token) || opts.implied?.get(id), ts);
    if (imp) return { usd: imp.usd, basis: 'implied', at_ts: imp.at_ts };
  } catch { /* fall through to today's price */ }
  return today();
}

/** The implied prices of one case's flows (swaps inside the case), with NEAR priced at the median time of the flows. Empty when nothing can be priced. */
export async function buildImplied(flows) {
  if (!config.incidents.priceAtIncident || !flows.length) return new Map();
  const ts = flows.map((f) => f.ts).filter(Number.isFinite).sort((a, b) => a - b), mid = ts[ts.length >> 1];
  const near = Number.isFinite(mid) ? await nearUsdAt(mid).catch(() => null) : null;
  const metas = new Map();
  for (const t of new Set(flows.map((f) => f.token))) if (!/^nft:|^mint:|^burn:/.test(t)) metas.set(t, await tokenMeta(t).catch(() => null));
  const known = (t) => (isStable(t) ? 1 : baseToken(t) === NEAR || baseToken(t) === 'wrap.near' ? near : null);
  const amountOf = (t, raw) => { const m = metas.get(t); return m ? units(String(raw), m.decimals) : 0; };
  return impliedPrices(flows.filter((f) => metas.get(f.token)), amountOf, known);
}
