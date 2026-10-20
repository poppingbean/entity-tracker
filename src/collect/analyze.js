// Pure functions: from a token's trades, work out who bought early, what each early buyer made, and how the token ended up.
// No I/O here, so it is unit-tested with synthetic trades (test/analyze.test.js).

const MIN = 60e3;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export { median };

/** Price series (NEAR per token) from trades, ignoring dust that would distort it. */
export function priceSeries(trades, minNear = 0.02) {
  return trades.filter((t) => t.near >= minNear && t.tokens > 0).map((t) => ({ ts: t.ts, price: t.near / t.tokens })).sort((a, b) => a.ts - b.ts);
}
/** Last traded price at or before `ts` (null when nothing traded yet). */
export function priceAt(series, ts) {
  let lo = 0, hi = series.length - 1, ans = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid].ts <= ts) { ans = series[mid].price; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/**
 * How the token did: price at each checkpoint, peak, drawdown, rug flag, volume, what the creator did.
 * `cfg` = { minutes: [60, 360, 1440], rugDrawdown: 0.9 }.
 */
export function buildOutcome(token, trades, now, cfg) {
  const live = token.live_ts, horizon = live + cfg.minutes[cfg.minutes.length - 1] * MIN;
  const inHorizon = trades.filter((t) => t.ts >= live && t.ts <= horizon);
  const series = priceSeries(inHorizon);
  const cp = {};
  for (const m of cfg.minutes) if (now >= live + m * MIN) cp[m] = priceAt(series, live + m * MIN);
  const first = series[0]?.price ?? null;
  let peak = null, peakTs = null;
  for (const p of series) if (peak == null || p.price > peak) { peak = p.price; peakTs = p.ts; }
  const last = series.at(-1)?.price ?? null;
  const drawdown = peak && last != null ? 1 - last / peak : null;
  const ageMin = (now - live) / MIN;
  const settled = ageMin >= cfg.minutes[0]; // judge a rug only after the first checkpoint
  const buys = inHorizon.filter((t) => t.buy), sells = inHorizon.filter((t) => !t.buy);
  const creator = token.creator;
  const creatorSells = creator ? sells.filter((t) => t.trader === creator) : [];
  const creatorBuys = creator ? buys.filter((t) => t.trader === creator) : [];
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const finalM = [...cfg.minutes].reverse().find((m) => cp[m] != null) ?? null;
  return {
    first_price: first, peak_price: peak, peak_ts: peakTs, last_price: last,
    peak_multiple: first && peak ? peak / first : null, last_multiple: first && last != null ? last / first : null,
    drawdown, rugged: settled && drawdown != null && drawdown >= cfg.rugDrawdown, cp, final_cp: finalM,
    buy_near: sum(buys, (t) => t.near), sell_near: sum(sells, (t) => t.near), buyers: new Set(buys.map((t) => t.trader)).size, sellers: new Set(sells.map((t) => t.trader)).size,
    trades: inHorizon.length, creator_buy_near: sum(creatorBuys, (t) => t.near), creator_sell_near: sum(creatorSells, (t) => t.near), creator_sold: creatorSells.length > 0,
    age_min: Math.round(ageMin), complete: ageMin >= cfg.minutes[cfg.minutes.length - 1],
  };
}

/**
 * Early buyers of a token and what each made. `cfg` = { windowMinutes, maxBuyers, minNear, minutes }.
 * An entry is a wallet whose first buy fell inside the window, among the first `maxBuyers` such wallets.
 * ROI at a checkpoint T = (NEAR already taken out by T + tokens still held x price at T) / NEAR put in during the window - 1.
 */
export function buildEntries(token, trades, now, cfg) {
  const live = token.live_ts, winEnd = live + cfg.windowMinutes * MIN;
  const series = priceSeries(trades.filter((t) => t.ts >= live));
  const byWallet = new Map();
  for (const t of trades) { if (t.ts < live) continue; (byWallet.get(t.trader) || byWallet.set(t.trader, []).get(t.trader)).push(t); }
  const candidates = [];
  for (const [wallet, ts] of byWallet) {
    ts.sort((a, b) => a.ts - b.ts);
    const wb = ts.filter((t) => t.buy && t.ts <= winEnd);
    if (!wb.length) continue;
    const buyNear = wb.reduce((s, t) => s + t.near, 0);
    if (buyNear < cfg.minNear) continue;
    candidates.push({ wallet, ts, wb, buyNear, first: wb[0].ts });
  }
  candidates.sort((a, b) => a.first - b.first);
  const kept = candidates.slice(0, cfg.maxBuyers);
  const nowPrice = series.at(-1)?.price ?? null;
  return kept.map((c, i) => {
    const buyTokens = c.wb.reduce((s, t) => s + t.tokens, 0);
    const allSells = c.ts.filter((t) => !t.buy);
    const valueAt = (T, price) => {
      const sold = allSells.filter((t) => t.ts <= T);
      const soldTokens = sold.reduce((s, t) => s + t.tokens, 0), soldNear = sold.reduce((s, t) => s + t.near, 0);
      const eff = Math.min(soldTokens, buyTokens), takenOut = soldTokens > 0 ? soldNear * (eff / soldTokens) : 0;
      const remaining = buyTokens - eff;
      return { value: takenOut + (price != null ? remaining * price : 0), soldShare: buyTokens ? eff / buyTokens : 0, takenOut };
    };
    const roi = {}, soldShare = {}, takenOut = {};
    for (const m of cfg.minutes) {
      const T = live + m * MIN;
      if (now < T) continue;
      const p = priceAt(series, T);
      if (p == null) continue;
      const v = valueAt(T, p);
      roi[m] = v.value / c.buyNear - 1; soldShare[m] = v.soldShare; takenOut[m] = v.takenOut;
    }
    const vNow = valueAt(now, nowPrice);
    return {
      _id: `${token._id}|${c.wallet}`, token: token._id, wallet: c.wallet, rank: i + 1, first_buy_ts: c.first, first_buy_hash: c.wb[0].hash || null, delay_s: Math.round((c.first - live) / 1000),
      buy_near: c.buyNear, buy_tokens: buyTokens, n_buys: c.wb.length, entry_price: buyTokens ? c.buyNear / buyTokens : null,
      is_creator: !!token.creator && c.wallet === token.creator, roi, sold_share: soldShare, taken_out: takenOut,
      roi_now: nowPrice != null ? vNow.value / c.buyNear - 1 : null, sold_share_now: vNow.soldShare,
      first_sell_ts: allSells[0]?.ts ?? null, launchpad: token.launchpad, symbol: token.symbol || null, live_ts: live,
    };
  });
}

/** The ROI an entry is judged by: the latest checkpoint the token has reached (null when it has not reached the first). */
export function evalRoi(entry, minutes) {
  for (const m of [...minutes].reverse()) if (entry.roi?.[m] != null) return entry.roi[m];
  return null;
}
