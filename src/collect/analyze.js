// Pure functions: from a token's trades, work out who bought early, what each early buyer made, and how the token ended up.
// No I/O here, so it is unit-tested with synthetic trades (test/analyze.test.js).

const MIN = 60e3;
/** Version of the rug rules in buildOutcome: bump it when they change, and the worker re-applies them to every stored outcome from an older version. */
export const RUG_RULES_V = 6;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export { median };

/** Price series (NEAR per token) from trades, ignoring dust that would distort it. */
export function priceSeries(trades, minNear = 0.02) {
  minNear = minNear ?? 0.02;
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
  const series = priceSeries(inHorizon, cfg.priceMinNear);
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
  // Why a token counts as rugged: its price collapsed from the peak, its creator dumped into a deep fall, or it was flagged from outside
  // (the scanner's dev-rug blacklist: the creator emptied their balance while a position was held).
  const creatorSellNear = sum(creatorSells, (t) => t.near);
  // creator exit: how much of the creator's dev buy came back out within the first hour, and how soon the first sale was. Not a rug by itself
  // (most launches show it and the price rarely moves), but the clearest early sign of a creator leaving.
  const devBuy = token.dev_buy_near || 0, firstSell = creatorSells[0];
  const exitSold = sum(creatorSells.filter((t) => t.ts <= live + 60 * MIN), (t) => t.near);
  const creatorExit = firstSell && devBuy >= 1 ? { share: exitSold / devBuy, minutes: Math.max(0, Math.round((firstSell.ts - live) / MIN)), sold_near: exitSold, dev_buy_near: devBuy } : null;
  const rugKinds = [];
  if (settled && drawdown != null && drawdown >= cfg.rugDrawdown) rugKinds.push('price_crash');
  else if (settled && drawdown != null && drawdown >= (cfg.softRugDrawdown ?? 0.7) && creatorSellNear >= 1) rugKinds.push('creator_dump');
  // round trip: it pumped (peak at least roundTripPeak x the launch price) and is back near where it started (at most roundTripBack x): everyone who bought after launch is flat or under
  const first0 = series[0]?.price;
  if (settled && first0 && peak && last != null && peak / first0 >= (cfg.roundTripPeak ?? 3) && last / first0 <= (cfg.roundTripBack ?? 1.25) && !rugKinds.length) rugKinds.push('round_trip');
  // creator exit: the creator took (all of) their dev buy out within the hour and the token is not much above its launch price (at most creatorExitBack x), so holders are flat or under
  if (creatorExit && creatorExit.share >= (cfg.creatorExitShare ?? 0.8) && first0 && last != null && last / first0 <= (cfg.creatorExitBack ?? 1.5) && !rugKinds.length) rugKinds.push('creator_exit');
  // the creator sold at all: a dump, whatever the price did (the kinds above say more when they apply)
  if (creatorSells.length && creatorSellNear > (cfg.creatorSellRugNear ?? 0) && !rugKinds.length) rugKinds.push('creator_sold');
  if (token.rug?.flagged) rugKinds.push(token.rug.source === 'ledger' ? 'creator_sold' : 'flagged'); // ledger: the creator sold after the first 24 h
  return {
    first_price: first, peak_price: peak, peak_ts: peakTs, last_price: last,
    peak_multiple: first && peak ? peak / first : null, last_multiple: first && last != null ? last / first : null,
    drawdown, rugged: rugKinds.length > 0, rug_kinds: [...new Set(rugKinds)], rules_v: RUG_RULES_V, rug_reason: token.rug?.reason || null, creator_exit: creatorExit, cp, final_cp: finalM,
    buy_near: sum(buys, (t) => t.near), sell_near: sum(sells, (t) => t.near), buyers: new Set(buys.map((t) => t.trader)).size, sellers: new Set(sells.map((t) => t.trader)).size,
    trades: inHorizon.length, creator_buy_near: sum(creatorBuys, (t) => t.near), creator_sell_near: sum(creatorSells, (t) => t.near), creator_sold: creatorSells.length > 0,
    age_min: Math.round(ageMin), complete: ageMin >= cfg.minutes[cfg.minutes.length - 1],
  };
}

/**
 * The token over its whole stored history (the full ledger), next to the 24 h outcome: current price, all-time high, drawdown from it,
 * when it last traded, and volume after the last checkpoint. `cfg` = the outcome settings. Verdicts never read this.
 */
export function buildLedger(token, trades, cfg) {
  const live = token.live_ts, horizon = live + cfg.minutes[cfg.minutes.length - 1] * MIN;
  const all = trades.filter((t) => t.ts >= live), after = all.filter((t) => t.ts > horizon);
  const series = priceSeries(all, cfg.priceMinNear);
  const first = series[0]?.price ?? null, last = series.at(-1)?.price ?? null;
  let ath = null, athTs = null;
  for (const p of series) if (ath == null || p.price > ath) { ath = p.price; athTs = p.ts; }
  const drawdown = ath && last != null ? 1 - last / ath : null;
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const creatorAfter = token.creator ? after.filter((t) => !t.buy && t.trader === token.creator) : [];
  const side = (a) => ({ trades: a.length, buy_near: sum(a.filter((t) => t.buy), (t) => t.near), sell_near: sum(a.filter((t) => !t.buy), (t) => t.near), buyers: new Set(a.filter((t) => t.buy).map((t) => t.trader)).size });
  return {
    last_price: last, last_multiple: first && last != null ? last / first : null, last_trade_ts: all.at(-1)?.ts ?? null,
    ath_price: ath, ath_multiple: first && ath ? ath / first : null, ath_ts: athTs, ath_after_cp: athTs != null && athTs > horizon,
    drawdown, collapsed: drawdown != null && drawdown >= cfg.rugDrawdown, // fell like a rug at some point after launch (24 h verdicts may not show it)
    ...side(all), after_cp: side(after),
    creator_sell_near_after_cp: sum(creatorAfter, (t) => t.near), creator_first_sell_after_cp_ts: creatorAfter[0]?.ts ?? null, // the creator selling after day 1
  };
}

/**
 * Early buyers of a token and what each made. `cfg` = { windowMinutes, maxBuyers, minNear, minutes }.
 * An entry is a wallet whose first buy fell inside the window, among the first `maxBuyers` such wallets.
 * ROI at a checkpoint T = (NEAR already taken out by T + tokens still held x price at T) / NEAR put in during the window - 1.
 */
export function buildEntries(token, trades, now, cfg) {
  const live = token.live_ts, winEnd = live + cfg.windowMinutes * MIN;
  const series = priceSeries(trades.filter((t) => t.ts >= live), cfg.priceMinNear);
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
    // profit split: realized = NEAR taken out minus the cost of the tokens sold; unrealized = what is still held, valued at the last price, minus its cost
    const realizedNow = vNow.takenOut - c.buyNear * vNow.soldShare, pnlNow = nowPrice != null ? vNow.value - c.buyNear : null;
    return {
      _id: `${token._id}|${c.wallet}`, token: token._id, wallet: c.wallet, rank: i + 1, first_buy_ts: c.first, first_buy_hash: c.wb[0].hash || null, delay_s: Math.round((c.first - live) / 1000),
      buy_near: c.buyNear, buy_tokens: buyTokens, n_buys: c.wb.length, entry_price: buyTokens ? c.buyNear / buyTokens : null,
      is_creator: !!token.creator && c.wallet === token.creator, roi, sold_share: soldShare, taken_out: takenOut,
      roi_now: nowPrice != null ? vNow.value / c.buyNear - 1 : null, sold_share_now: vNow.soldShare, pnl_now: pnlNow, realized_now: realizedNow, unrealized_now: pnlNow != null ? pnlNow - realizedNow : null,
      first_sell_ts: allSells[0]?.ts ?? null, launchpad: token.launchpad, symbol: token.symbol || null, live_ts: live,
    };
  });
}

/** The checkpoint (minutes) an entry is judged at: the latest one it has reached, or null. */
export function evalCp(entry, minutes) {
  for (const m of [...minutes].reverse()) if (entry.roi?.[m] != null) return m;
  return null;
}

/** The ROI an entry is judged by: the latest checkpoint the token has reached (null when it has not reached the first). */
export function evalRoi(entry, minutes) {
  for (const m of [...minutes].reverse()) if (entry.roi?.[m] != null) return entry.roi[m];
  return null;
}
