// Pure functions: from a token's trades, work out who bought early, what each early buyer made, and how the token ended up.
// No I/O here, so it is unit-tested with synthetic trades (test/analyze.test.js).

const MIN = 60e3;
/** Version of the rug rules in buildOutcome: bump it when they change, and the worker re-applies them to every stored outcome from an older version. */
export const RUG_RULES_V = 8; // 7: rug rules judge every stored trade (all time), not only the first 24 h; 8: a crash must be fast, creator sales count in the first days, launch-price rules need the launch

/** Did the price fall to (1 - depth) of the peak within `days` after the peak? A rug is a fast fall; a token bleeding down over months is not one. */
export function fastFall(series, peak, peakTs, depth, days) {
  if (!peak) return false;
  const floor = peak * (1 - depth), until = peakTs + days * 1440 * MIN;
  return series.some((p) => p.ts > peakTs && p.ts <= until && p.price <= floor);
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export { median };

/** Price series (NEAR per token) from trades, ignoring dust and isolated bad prints that would distort it. */
export function priceSeries(trades, minNear = 0.02) {
  minNear = minNear ?? 0.02;
  return dropSpikes(trades.filter((t) => t.near >= minNear && t.tokens > 0).map((t) => ({ ts: t.ts, price: t.near / t.tokens })).sort((a, b) => a.ts - b.ts));
}

/**
 * Drop isolated prints: a price more than `factor` x away from the median of the trades on BOTH sides of it (up to `k` each side) while
 * those agree with each other. A routed or mis-decoded trade can show one absurd price (BLACKDRAGON: one sell at 7.4x every trade around it
 * became a "54,979x" all-time high and a fake crash). A real pump or dump keeps trading at the new level, so it stays.
 */
export function dropSpikes(series, { k = 5, factor = 3 } = {}) {
  if (series.length < 5) return series;
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const before = series.slice(Math.max(0, i - k), i).map((p) => p.price), after = series.slice(i + 1, i + 1 + k).map((p) => p.price);
    if (before.length < 2 || after.length < 2) { out.push(series[i]); continue; } // the edges (launch, latest trade) can't be judged
    const mb = median(before), ma = median(after), p = series[i].price;
    const agree = Math.max(mb, ma) / Math.min(mb, ma) < factor; // the neighbours are on one level (not a real move happening right here)
    const off = (m) => p / m > factor || m / p > factor;
    if (agree && off(mb) && off(ma)) continue;
    out.push(series[i]);
  }
  return out;
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
  // the rug rules judge the token's whole stored history (the full ledger keeps reading after 24 h): a crash, a round trip or a creator
  // sale on day 5 counts. The checkpoints and the 24 h numbers above stay what verdicts and tags compare.
  const allT = trades.filter((t) => t.ts >= live), seriesAll = priceSeries(allT, cfg.priceMinNear);
  let peakA = null, peakATs = null;
  for (const p of seriesAll) if (peakA == null || p.price > peakA) { peakA = p.price; peakATs = p.ts; }
  const lastA = seriesAll.at(-1)?.price ?? null, firstA = seriesAll[0]?.price ?? null;
  const drawdownA = peakA && lastA != null ? 1 - lastA / peakA : null;
  const creatorSellsAll = creator ? allT.filter((t) => !t.buy && t.trader === creator) : [];
  const creatorSellNear = sum(creatorSellsAll, (t) => t.near);
  // creator exit: how much of the creator's dev buy came back out within the first hour, and how soon the first sale was. Not a rug by itself
  // (most launches show it and the price rarely moves), but the clearest early sign of a creator leaving.
  const devBuy = token.dev_buy_near || 0, firstSell = creatorSells[0];
  const exitSold = sum(creatorSells.filter((t) => t.ts <= live + 60 * MIN), (t) => t.near);
  const creatorExit = firstSell && devBuy >= 1 ? { share: exitSold / devBuy, minutes: Math.max(0, Math.round((firstSell.ts - live) / MIN)), sold_near: exitSold, dev_buy_near: devBuy } : null;
  const rugKinds = [];
  const crashDays = cfg.crashDays ?? 7;
  // the launch is in the stored trades (older tokens are often read from part-way through their life): only then is the first stored price the launch price
  const launchCovered = !!allT.length && allT[0].ts - live <= 60 * MIN;
  if (settled && drawdownA != null && drawdownA >= cfg.rugDrawdown && fastFall(seriesAll, peakA, peakATs, cfg.rugDrawdown, crashDays)) rugKinds.push('price_crash');
  else if (settled && drawdownA != null && drawdownA >= (cfg.softRugDrawdown ?? 0.7) && creatorSellNear >= 1 && fastFall(seriesAll, peakA, peakATs, cfg.softRugDrawdown ?? 0.7, crashDays)) rugKinds.push('creator_dump');
  // round trip: it pumped (peak at least roundTripPeak x the launch price) and is back near where it started (at most roundTripBack x): everyone who bought after launch is flat or under
  const first0 = launchCovered ? firstA : null;
  if (settled && first0 && peakA && lastA != null && peakA / first0 >= (cfg.roundTripPeak ?? 3) && lastA / first0 <= (cfg.roundTripBack ?? 1.25) && !rugKinds.length) rugKinds.push('round_trip');
  // creator exit: the creator took (all of) their dev buy out within the hour and the token is not much above its launch price (at most creatorExitBack x), so holders are flat or under
  if (creatorExit && creatorExit.share >= (cfg.creatorExitShare ?? 0.8) && first0 && lastA != null && lastA / first0 <= (cfg.creatorExitBack ?? 1.5) && !rugKinds.length) rugKinds.push('creator_exit');
  // the creator sold in its first days: a dump, whatever the price did (the kinds above say more when they apply)
  const earlyCreatorSellNear = sum(creatorSellsAll.filter((t) => t.ts <= live + (cfg.creatorSellRugDays ?? 30) * 1440 * MIN), (t) => t.near);
  if (earlyCreatorSellNear > 0 && earlyCreatorSellNear > (cfg.creatorSellRugNear ?? 0) && !rugKinds.length) rugKinds.push('creator_sold');
  if (token.rug?.flagged && token.rug.source !== 'ledger') rugKinds.push('flagged'); // dev-rug blacklist (old "ledger" flags are covered by the all-time creator sales above)
  return {
    first_price: first, peak_price: peak, peak_ts: peakTs, last_price: last,
    peak_multiple: first && peak ? peak / first : null, last_multiple: first && last != null ? last / first : null,
    drawdown, rugged: rugKinds.length > 0, rug_kinds: [...new Set(rugKinds)], rules_v: RUG_RULES_V,
    // what the rug rules saw: the whole stored history (all time), not only the first 24 h
    rug_basis: { peak_multiple: firstA && peakA ? peakA / firstA : null, peak_ts: peakATs, last_multiple: firstA && lastA != null ? lastA / firstA : null, drawdown: drawdownA,
      creator_sell_near: creatorSellNear, creator_sold: creatorSellsAll.length > 0, creator_sell_after_24h_near: sum(creatorSellsAll.filter((t) => t.ts > horizon), (t) => t.near), last_trade_ts: allT.at(-1)?.ts ?? null, trades: allT.length }, rug_reason: token.rug?.reason || null, creator_exit: creatorExit, cp, final_cp: finalM,
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
    // fell like a rug at some point after launch (24 h verdicts may not show it): deep and fast, not a long decline from an old high
    drawdown, collapsed: drawdown != null && drawdown >= cfg.rugDrawdown && fastFall(series, ath, athTs, cfg.rugDrawdown, cfg.crashDays ?? 7),
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
