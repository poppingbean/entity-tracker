// Gate-pass report: when a launch passes every hard gate, an alert (type gate_pass) goes out once per token. alerts/deliver.js sends it
// to every chat registered on the Telegram bot (any chat with a watchlist; /gatepass off opts out), to watchlists that hold the token
// or its creator, and to TELEGRAM_GATE_PASS_CHAT_ID when one is set. The report only states chain facts, the score and the warnings: never a gate's
// threshold (alerts are public).
import { config } from '../config.js';
import { warn } from '../log.js';
import { raise } from '../alerts/store.js';

const n0 = (x) => (x == null || !Number.isFinite(+x) ? '–' : Math.round(+x).toLocaleString('en-US'));
const pct = (x) => (x == null || !Number.isFinite(+x) ? '–' : `${Math.round(+x * 100)}%`);
const PADS = { nearlytrade: 'nearly.trade', justhoot: 'justhoot', memecooking: 'meme.cooking', tkn: 'tkn.near' };

/** The report for one passed check: { title, text }. `odds`: meta.accuracy.gate_pass (what happened to earlier passes). Pure (tests). */
export function gatePassReport(t, f, rules, { kind = 'first', minutes = null, odds = null, bot = config.alerts.telegramBot } = {}) {
  const tr = f?.trading || {}, au = f?.audit, eg = f?.intel?.early_buyer_groups;
  const name = t.symbol ? `$${t.symbol}` : t._id;
  const lines = [
    `Score ${rules.score}/100 · every hard gate passed · ${kind === 'first' ? 'first check' : 'follow-up check'}${minutes != null ? `, ${minutes} min after launch` : ''}`,
    `${PADS[t.launchpad] || t.launchpad || 'launchpad ?'} · pool ${n0(f?.pool?.nearReserve)} NEAR · market cap $${n0(f?.market?.mcapUsd)}`,
    `${n0(tr.uniqueBuyers)} buyers · bought ${n0(tr.buyNear)} / sold ${n0(tr.sellNear)} NEAR · price x${tr.priceMultipleSinceFirstTrade ?? '–'} since the first trade`,
    au?.available ? `Contract audit: risk ${au.risk_score}/100 (${au.risk_level})` : 'Contract audit: not available yet',
  ];
  if (eg) lines.push(`Early buying: known good ${pct(eg.good?.share)} · dangerous ${pct(eg.bad?.share)}${eg.rugger?.wallets ? ` · rug-linked ${pct(eg.rugger.share)}` : ''}`);
  for (const w of rules.warnings || []) lines.push(`⚠️ ${w.why || w.id}`);
  lines.push(`Contract: ${t._id}`);
  // the measured odds of a pass (the gates as they are now, replayed on every judged launch), so nobody reads a pass as "safe"
  if (odds?.n >= 10 && odds.rug_rate != null) {
    const sale = odds.creator_sale_minutes;
    lines.push(`Odds so far: of ${n0(odds.n)} earlier launches that passed these gates, ${pct(odds.rug_rate)} rugged later${sale?.median != null ? ` (the creator's first sale came a median ${n0(sale.median)} min after the check)` : ''} and ${pct(odds.double_rate)} at least doubled within a day.`);
  }
  lines.push(`Most rugs show up as the creator selling, usually within the first hour. Get an alert the moment it does: /watch ${t._id}${bot ? ` on @${bot}` : ''}, or Watch on the token page.`);
  lines.push('Passing the gates is not a buy signal or financial advice: the AI review and the risk notes follow on the page.');
  return { title: `Gate pass: ${name}`, text: lines.join('\n') };
}

/** Raise the gate-pass alert for a token (once per token; later passes of the same token do nothing). Never throws. */
export async function raiseGatePass(t, f, rules, { kind = 'first', minutes = null, scanId = null, ts = Date.now() } = {}) {
  if (!config.alerts.enabled || !config.alerts.gatePass || !rules?.pass) return false;
  try {
    const odds = (await (await import('../db.js')).metaGet('accuracy', null).catch(() => null))?.gate_pass || null;
    const { title, text } = gatePassReport(t, f, rules, { kind, minutes, odds });
    return await raise(`gate_pass|${t._id}`, { type: 'gate_pass', severity: 'info', title, text, url: `/tokens/${encodeURIComponent(t._id)}`,
      related: { tokens: [t._id], creators: [t.creator] }, data: { event_ts: ts, score: rules.score, kind, scan: scanId, warnings: (rules.warnings || []).map((w) => w.id) }, ts });
  } catch (e) { warn(`gate-pass alert for ${t._id} failed: ${e.message}`); return false; }
}
