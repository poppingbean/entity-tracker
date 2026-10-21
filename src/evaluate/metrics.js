// Pure functions: how a group of wallets performed as early investors, and a rule-based verdict.
// "Good" = early money that makes money in tokens that hold up (worth watching / following).
// "Bad"  = insiders, rug farmers, coordinated sybil snipers, or consistent losers (worth avoiding, or treating as a warning sign).
import { median, evalRoi, evalCp } from '../collect/analyze.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const DAY = 86400e3;

/**
 * Tag of a wallet or group from its money and its hit rate (the share of the tokens it bought early that ended in profit, ROI > 0 at the
 * latest checkpoint). loss = lost money overall (weighted ROI <= 0). Net profit: win80 = profitable in 80 %+ of its tokens, win50 = 50 %+,
 * win30 = 30 %+, sniper = under 30 % (a few big wins pay for many small losses). "unrated" until it has `minTokens` judged tokens.
 */
export const WIN_TAGS = ['win80', 'win50', 'win30', 'sniper', 'loss'];
export function winTag(profitRate, tokensN, minTokens, roi = null) {
  if (profitRate == null || tokensN < minTokens) return 'unrated';
  if (roi != null && roi <= 0) return 'loss'; // lost money overall, however many tokens ended in profit
  if (profitRate >= 0.8) return 'win80';
  if (profitRate >= 0.5) return 'win50';
  if (profitRate >= 0.3) return 'win30';
  return roi != null ? 'sniper' : 'loss'; // net profit from a few big wins while most tokens lost
}

/**
 * members: [wallet ids]; entries: all early entries of those wallets (with roi/sold_share/token_rugged)
 * tokens: Map token -> token doc (outcome, creator, symbol, launchpad); wallets: Map id -> wallet doc
 * insiderEntries: Set of "token|wallet" for entries linked to the token's creator
 * cfg: { minutes, winRoi, cobuySeconds, minTokens, goodScore, badScore }
 */
export function computeMetrics(members, entries, tokens, wallets, insiderEntries, cfg) {
  const judged = entries.filter((e) => evalRoi(e, cfg.minutes) != null);
  const byToken = new Map();
  for (const e of judged) (byToken.get(e.token) || byToken.set(e.token, []).get(e.token)).push(e);

  const rows = [];
  for (const [token, es] of byToken) {
    const buy = es.reduce((s, e) => s + e.buy_near, 0);
    const value = es.reduce((s, e) => s + e.buy_near * (1 + evalRoi(e, cfg.minutes)), 0);
    const t = tokens.get(token);
    const insider = es.filter((e) => insiderEntries.has(`${token}|${e.wallet}`)).length;
    // realized = NEAR already taken out minus the cost of the tokens sold; unrealized = the rest of the profit (tokens still held at the checkpoint price)
    const realized = es.reduce((s, e) => { const k = evalCp(e, cfg.minutes); return s + (e.taken_out?.[k] ?? 0) - e.buy_near * (e.sold_share?.[k] ?? 0); }, 0);
    rows.push({ realized_near: realized, unrealized_near: value - buy - realized,
      token, symbol: t?.symbol || null, launchpad: t?.launchpad || null, live_ts: t?.live_ts || null, wallets: es.length, buy_near: buy, roi: buy ? value / buy - 1 : 0, pnl_near: value - buy,
      rugged: !!t?.outcome?.rugged, peak_multiple: t?.outcome?.peak_multiple ?? null, insider_wallets: insider, first_delay_s: Math.min(...es.map((e) => e.delay_s)),
      sold_share: es.reduce((s, e) => s + (e.sold_share?.[cfg.minutes[0]] ?? 0), 0) / es.length,
    });
  }
  rows.sort((a, b) => (b.live_ts || 0) - (a.live_ts || 0));

  const n = rows.length;
  const wins = rows.filter((r) => r.roi >= cfg.winRoi), losses = rows.filter((r) => r.roi <= -0.5), rugs = rows.filter((r) => r.rugged);
  const totalBuy = judged.reduce((s, e) => s + e.buy_near, 0);
  const pnl = rows.reduce((s, r) => s + r.pnl_near, 0), realizedPnl = rows.reduce((s, r) => s + r.realized_near, 0);
  const insiderEntriesN = judged.filter((e) => insiderEntries.has(`${e.token}|${e.wallet}`)).length;

  // fresh wallets: created less than 3 days before the entry
  let fresh = 0, freshKnown = 0;
  for (const e of judged) { const w = wallets.get(e.wallet); if (w?.created_ts) { freshKnown++; if (e.first_buy_ts - w.created_ts < 3 * DAY) fresh++; } }

  // synchronised buying: another member bought the same token within a few seconds
  let sync = 0;
  const entriesByToken = new Map();
  for (const e of entries) (entriesByToken.get(e.token) || entriesByToken.set(e.token, []).get(e.token)).push(e);
  for (const list of entriesByToken.values()) for (const e of list) if (list.some((o) => o.wallet !== e.wallet && Math.abs(o.first_buy_ts - e.first_buy_ts) <= cfg.cobuySeconds * 1000)) sync++;

  const m = {
    wallets_n: members.length, entries_n: entries.length, tokens_n: n, tokens_all: new Set(entries.map((e) => e.token)).size,
    total_buy_near: totalBuy, avg_buy_near: judged.length ? totalBuy / judged.length : 0, pnl_near: pnl, realized_near: realizedPnl, unrealized_near: pnl - realizedPnl, roi_weighted: totalBuy ? pnl / totalBuy : null,
    median_token_roi: median(rows.map((r) => r.roi)), win_rate: n ? wins.length / n : null, profit_tokens_n: rows.filter((r) => r.roi > 0).length, profit_rate: n ? rows.filter((r) => r.roi > 0).length / n : null, loss_rate: n ? losses.length / n : null,
    rug_tokens_n: rugs.length, rug_share: n ? rugs.length / n : null,
    win_rate_in_rugs: rugs.length ? rugs.filter((r) => r.roi >= cfg.winRoi).length / rugs.length : null, pnl_in_rugs: rugs.reduce((s, r) => s + r.pnl_near, 0),
    creator_linked_share: judged.length ? insiderEntriesN / judged.length : 0, creator_linked_tokens: rows.filter((r) => r.insider_wallets > 0).length,
    fresh_share: freshKnown ? fresh / freshKnown : null, sync_share: entries.length ? sync / entries.length : 0,
    avg_delay_s: judged.length ? judged.reduce((s, e) => s + e.delay_s, 0) / judged.length : null,
    first_movers_share: judged.length ? judged.filter((e) => e.rank <= 5).length / judged.length : 0,
    last_entry_ts: entries.length ? Math.max(...entries.map((e) => e.first_buy_ts)) : null,
  };
  return { metrics: m, tokens: rows };
}

/** Rule-based score (0-100), verdict and tags from the metrics. */
export function ruleVerdict(m, size, cfg) {
  const tags = [];
  if (m.creator_linked_share >= 0.25) tags.push('insider');
  if (m.rug_share >= 0.4 && (m.win_rate_in_rugs ?? 0) >= 0.5 && m.pnl_in_rugs > 0) tags.push('rug-farmer');
  if (size >= 3 && (m.fresh_share ?? 0) >= 0.6 && m.sync_share >= 0.5) tags.push('sybil-sniper');
  if ((m.win_rate ?? 0) >= 0.55 && (m.rug_share ?? 1) <= 0.25 && m.tokens_n >= cfg.minTokens && m.creator_linked_share < 0.1) tags.push('smart-early');
  if (m.tokens_n >= cfg.minTokens && (m.win_rate ?? 1) <= 0.2) tags.push('consistent-loser');
  if (size === 1) tags.push('single-wallet');

  let score = 50;
  score += ((m.win_rate ?? 0.4) - 0.4) * 70;
  score += clamp(m.roi_weighted ?? 0, -1, 3) * 8;
  score -= (m.rug_share ?? 0) * 30;
  score -= (m.creator_linked_share ?? 0) * 40;
  if (tags.includes('rug-farmer')) score -= 20;
  if (tags.includes('sybil-sniper')) score -= 10;
  score += Math.min(m.tokens_n, 10) * 1.2;
  score = Math.round(clamp(score, 0, 100));

  let verdict;
  if (m.tokens_n < cfg.minTokens) verdict = 'unknown';
  else if (tags.includes('insider') || tags.includes('rug-farmer') || tags.includes('sybil-sniper')) verdict = 'bad';
  else if (score >= cfg.goodScore && (m.rug_share ?? 0) <= 0.4) verdict = 'good';
  else if (score <= cfg.badScore) verdict = 'bad';
  else verdict = 'neutral';
  return { score, verdict, tags };
}

/** A short fingerprint of the numbers an AI verdict depends on: re-review only when it changes enough. */
export function metricsPrint(m, size) {
  const q = (x, step) => (x == null ? 'n' : Math.round(x / step));
  return [size, m.tokens_n, q(m.win_rate, 0.1), q(m.rug_share, 0.1), q(m.creator_linked_share, 0.1), q(m.roi_weighted, 0.25), m.entries_n >> 2].join('|');
}
