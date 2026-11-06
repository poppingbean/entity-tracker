// Deterministic gates + a 0-100 score (ported from the live scanner), plus two gates that only this tracker can apply because it
// knows the entities: a creator with earlier rugged / dumped launches, and early buying dominated by groups judged bad.
import { config } from '../config.js';
import { looksLikeInjection } from '../ai/tools/untrusted.js';

/** Most a rugger among the early buyers can take off the score (reached at 50 % of the early buying); dangerous money costs up to 15. */
export const RUGGER_MAX_POINTS = 5;
/**
 * Market-timing gates: few buyers yet, or a price that already ran up. Neither is a sign of a rug or a scam, so failing one never fails
 * the check: it is reported as a warning (the AI analyst sees it and weighs it). Every other gate is a hard gate.
 */
export const SOFT_GATES = new Set(['min_buyers', 'not_overextended']);
/** A gate (or gate id) that fails the check: anything but a soft gate. */
export const isHardGate = (g) => !SOFT_GATES.has(g?.id ?? g);

export function applyRules(f) {
  const R = config.rules;
  const gates = [];
  // `note`: what a failed soft gate says as a warning. Warnings reach the public API unredacted, so a note states chain facts, never the threshold.
  const gate = (ok, id, why, note) => gates.push({ id, ok: !!ok, why, ...(SOFT_GATES.has(id) ? { soft: true, note } : {}) });

  gate(f.pool.quoteAccepted && f.pool.route, 'quote_accepted', `pool quote is ${f.pool.quoteSymbol}; only wNEAR / NEARLY / RHEA / QTC pools with a known route are tradable`);
  gate(f.contract.matchesTemplate === true, 'standard_contract', 'token code differs from the launchpad template (custom contract = honeypot risk)');
  gate(f.pool.lpLocked !== false, 'lp_locked', 'liquidity is not locked by the launchpad');
  gate(f.pool.nearReserve >= R.minPoolNear, 'min_pool_near', `pool has ${f.pool.nearReserve} NEAR (< ${R.minPoolNear})`);
  gate(f.market.mcapUsd != null && f.market.mcapUsd >= R.minMcapUsd, 'min_mcap', `market cap ${f.market.mcapUsd == null ? 'unknown' : '$' + f.market.mcapUsd.toLocaleString('en-US')} (< $${R.minMcapUsd.toLocaleString('en-US')})`);
  gate(f.trading.uniqueBuyers >= R.minUniqueBuyers, 'min_buyers', `${f.trading.uniqueBuyers} distinct external buyers (< ${R.minUniqueBuyers})`,
    `only ${f.trading.uniqueBuyers} distinct external buyer(s) at the time of the check`);
  gate(!f.trading.creatorSold, 'creator_not_selling', 'creator already sold');
  // a name / symbol that addresses an AI is an attempt to manipulate automated reviewers (this one included)
  gate(!looksLikeInjection(f.name, f.symbol), 'no_ai_manipulation', 'the token name or symbol contains instruction-like text aimed at AI reviewers');
  const tax = f.launch.tax || {};
  const taxBps = (tax.buyBps || 0) + (tax.sellBps || 0) + Math.round((tax.transferFeePips || 0) / 100) * 2;
  gate(taxBps <= R.maxTaxBps, 'tax_ok', `round-trip tax ~${taxBps / 100}% (> ${R.maxTaxBps / 100}%)`);
  gate(f.wallets.linkedBuyerShare <= R.maxLinkedBuyerShare, 'no_sybil_cluster', `${(f.wallets.linkedBuyerShare * 100).toFixed(0)}% of buying comes from wallets linked to each other or the creator`);
  gate(f.wallets.creatorFundedBuyers.length === 0, 'creator_not_funding_buyers', `creator funded buyers: ${f.wallets.creatorFundedBuyers.join(', ')}`);
  const early = f.market.mcapUsd != null && f.market.mcapUsd < R.ignoreRunupBelowMcapUsd;
  gate(early || f.trading.priceMultipleSinceFirstTrade <= R.maxPriceMultipleSinceLaunch, 'not_overextended', `price already ${f.trading.priceMultipleSinceFirstTrade}x since first trade at market cap $${(f.market.mcapUsd ?? 0).toLocaleString('en-US')}`,
    `price already ${f.trading.priceMultipleSinceFirstTrade}x since the first trade: a late entry, not a rug signal`);
  gate(f.pool.quoteForBuy.tokensOut > 0, 'quote_available', 'no executable quote for the buy size');
  // contract audit: confirmed malicious findings (fake storage backdoor, sells failing, owner wiping holders ...) or a critical risk score
  const au = f.audit;
  gate(!au?.available || (au.confirmed_malicious.length === 0 && au.risk_score < R.auditMaxRisk), 'contract_audit_ok',
    au?.available ? `contract audit: risk ${au.risk_score}/100 ${au.risk_level}${au.confirmed_malicious.length ? '; confirmed: ' + au.confirmed_malicious.map((c) => c.key).join(', ') : ''}` : 'contract audit unavailable');
  // entity intelligence
  gate((f.intel?.creator_prior_rugs_or_dumps ?? 0) === 0, 'creator_clean_history', `the creator already launched ${f.intel?.creator_prior_rugs_or_dumps} token(s) that were rugged or dumped by them (${(f.intel?.creator_prior_rug_symbols || []).join(', ')})`);
  const cn = f.intel?.creator_network;
  if (R.maxNetworkRuggers >= 0 && cn?.traced) gate((cn.rugger_creators ?? 0) <= R.maxNetworkRuggers, 'creator_network_clean', `${cn.rugger_creators} other creator(s) tied to this creator by funding or payments rugged or dumped tokens (${(cn.ruggers || []).map((r) => `${r.account}: ${r.rugged}/${r.launches}${r.blacklisted ? ', blacklisted' : ''}`).join('; ')})`);
  const badShare = f.intel?.early_buyer_groups?.bad?.share ?? 0;
  gate(badShare <= R.maxBadGroupShare, 'bad_groups_not_dominant', `${(badShare * 100).toFixed(0)}% of early buying comes from groups judged bad (> ${(R.maxBadGroupShare * 100).toFixed(0)}%)`);
  // rug-linked early buyers (rug farmers, creators that rugged, groups with one): a warning shown with the check, never a gate
  const warnings = gates.filter((g) => g.soft && !g.ok).map((g) => ({ id: g.id, level: 'warning', why: g.note }));
  const rug = f.intel?.early_buyer_groups?.rugger;
  if (rug?.wallets > 0) warnings.push({ id: 'rugger_early_buyers', level: 'warning', why: `${rug.wallets} early buyer(s) linked to rugs put in ${(rug.share * 100).toFixed(0)}% of the early buying` });

  // soft score
  let score = 50;
  score += Math.min(20, f.trading.uniqueBuyers * 1.5);
  score += f.trading.buyNear > 0 ? Math.max(-15, Math.min(10, ((f.trading.buyNear - f.trading.sellNear) / f.trading.buyNear) * 10)) : -10;
  score -= f.trading.syncBuyClusters * 6;
  score -= f.wallets.creator?.fresh && !f.wallets.creator?.funderLooksGeneric ? 5 : 0;
  score += f.pool.nearReserve >= 100 ? 5 : 0;
  score -= f.wallets.linkedBuyerShare * 20;
  score += Math.min(8, (f.intel?.early_buyer_groups?.good?.share ?? 0) * 16); // known good money among the early buyers
  score -= Math.min(15, badShare * 30);
  score -= Math.min(RUGGER_MAX_POINTS, (rug?.share ?? 0) * RUGGER_MAX_POINTS * 2); // rug-linked early money: a warning, a light cut only
  score -= Math.min(15, (cn?.other_rugged_tokens ?? 0) * 3); // tokens rugged by creators tied to this one
  if (f.audit?.available) score -= Math.min(15, Math.round(f.audit.risk_score / 5)); // risk 0-100 costs up to 15 points
  if (f.audit?.available && f.audit.trust_score >= 70) score += 3;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const failed = gates.filter((g) => !g.ok && !g.soft);
  return { pass: failed.length === 0 && score >= R.minScore, score, failed, gates, warnings };
}
