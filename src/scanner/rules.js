// Deterministic gates + a 0-100 score (ported from the live scanner), plus two gates that only this tracker can apply because it
// knows the entities: a creator with earlier rugged / dumped launches, and early buying dominated by groups judged bad.
import { config } from '../config.js';

export function applyRules(f) {
  const R = config.rules;
  const gates = [];
  const gate = (ok, id, why) => gates.push({ id, ok: !!ok, why });

  gate(f.pool.quoteAccepted && f.pool.route, 'quote_accepted', `pool quote is ${f.pool.quoteSymbol}; only wNEAR / NEARLY / RHEA / QTC pools with a known route are tradable`);
  gate(f.contract.matchesTemplate === true, 'standard_contract', 'token code differs from the launchpad template (custom contract = honeypot risk)');
  gate(f.pool.lpLocked !== false, 'lp_locked', 'liquidity is not locked by the launchpad');
  gate(f.pool.nearReserve >= R.minPoolNear, 'min_pool_near', `pool has ${f.pool.nearReserve} NEAR (< ${R.minPoolNear})`);
  gate(f.market.mcapUsd != null && f.market.mcapUsd >= R.minMcapUsd, 'min_mcap', `market cap ${f.market.mcapUsd == null ? 'unknown' : '$' + f.market.mcapUsd.toLocaleString('en-US')} (< $${R.minMcapUsd.toLocaleString('en-US')})`);
  gate(f.trading.uniqueBuyers >= R.minUniqueBuyers, 'min_buyers', `${f.trading.uniqueBuyers} distinct external buyers (< ${R.minUniqueBuyers})`);
  gate(!f.trading.creatorSold, 'creator_not_selling', 'creator already sold');
  const tax = f.launch.tax || {};
  const taxBps = (tax.buyBps || 0) + (tax.sellBps || 0) + Math.round((tax.transferFeePips || 0) / 100) * 2;
  gate(taxBps <= R.maxTaxBps, 'tax_ok', `round-trip tax ~${taxBps / 100}% (> ${R.maxTaxBps / 100}%)`);
  gate(f.wallets.linkedBuyerShare <= R.maxLinkedBuyerShare, 'no_sybil_cluster', `${(f.wallets.linkedBuyerShare * 100).toFixed(0)}% of buying comes from wallets linked to each other or the creator`);
  gate(f.wallets.creatorFundedBuyers.length === 0, 'creator_not_funding_buyers', `creator funded buyers: ${f.wallets.creatorFundedBuyers.join(', ')}`);
  const early = f.market.mcapUsd != null && f.market.mcapUsd < R.ignoreRunupBelowMcapUsd;
  gate(early || f.trading.priceMultipleSinceFirstTrade <= R.maxPriceMultipleSinceLaunch, 'not_overextended', `price already ${f.trading.priceMultipleSinceFirstTrade}x since first trade at market cap $${(f.market.mcapUsd ?? 0).toLocaleString('en-US')}`);
  gate(f.pool.quoteForBuy.tokensOut > 0, 'quote_available', 'no executable quote for the buy size');
  // entity intelligence
  gate((f.intel?.creator_prior_rugs_or_dumps ?? 0) === 0, 'creator_clean_history', `the creator already launched ${f.intel?.creator_prior_rugs_or_dumps} token(s) that were rugged or dumped by them (${(f.intel?.creator_prior_rug_symbols || []).join(', ')})`);
  const badShare = f.intel?.early_buyer_groups?.bad?.share ?? 0;
  gate(badShare <= R.maxBadGroupShare, 'bad_groups_not_dominant', `${(badShare * 100).toFixed(0)}% of early buying comes from groups judged bad (> ${(R.maxBadGroupShare * 100).toFixed(0)}%)`);

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
  score = Math.max(0, Math.min(100, Math.round(score)));

  const failed = gates.filter((g) => !g.ok);
  return { pass: failed.length === 0 && score >= R.minScore, score, failed, gates };
}
