// What kind of contract is this, read from its WASM exports. Pure (unit-tested).
// A contract has STANDARDS it implements (NEP-141 token, NEP-171 NFT, NEP-245 multi-token …) and a ROLE (AMM, liquid staking, lending …).
// Meta Pool is a fungible token (stNEAR) and a liquid-staking protocol; the role decides which audit profile applies.

/** NEAR standards visible in the exports. */
export function standardsOf(exports) {
  const has = (m) => exports.includes(m);
  const out = [];
  if (has('ft_transfer') && (has('ft_total_supply') || has('ft_balance_of'))) out.push('nep141');
  if (has('ft_metadata')) out.push('nep148');
  if (has('nft_transfer') && (has('nft_token') || has('nft_tokens_for_owner'))) out.push('nep171');
  if (has('nft_approve')) out.push('nep178');
  if (has('nft_payout') || has('nft_transfer_payout')) out.push('nep199');
  if (has('mt_transfer') || has('mt_batch_transfer')) out.push('nep245');
  if (has('storage_deposit')) out.push('nep145');
  if (has('contract_source_metadata')) out.push('nep330');
  return out;
}

// Each role: required method patterns (each one present scores) and supporting ones; `not` excludes the role.
export const ROLES = {
  'amm': { label: 'AMM / liquidity pool', req: [/add_liquidity|remove_liquidity|liquidity_add|liquidity_remove|add_stable_liquidity/, /^get_pools?$|^list_pools$|^get_pool_info$|^get_number_of_pools$/], sup: [/swap/, /^mft_/, /pool_fee|total_fee/, /^ft_on_transfer$/, /^create_pool/, /liquidity/] },
  'liquid_staking': { label: 'Liquid staking', req: [/^deposit_and_stake$/, /^ft_transfer$/], sup: [/staking_pool|epoch_|validator_/, /st_near_price|^ft_price$/, /unstake/, /treasury|operator/] },
  'staking_pool': { label: 'Validator staking pool', req: [/^deposit_and_stake$/, /^get_reward_fee_fraction$/], sup: [/^on_stake_action$/, /^vote$/, /^unstake_all$/], not: [/^ft_transfer$/] },
  'lending': { label: 'Lending', req: [/borrow|liquidat|collateral|margin_execute/, /oracle|pyth|asset_config|get_assets/], sup: [/^execute$/, /asset/, /repay/, /farm/] },
  'dao': { label: 'DAO', req: [/^add_proposal$/, /^act_proposal$/], sup: [/^get_policy$|^get_proposals?$/, /delegate/] },
  'multisig': { label: 'Multisig', req: [/^add_request$|^add_request_and_confirm$/, /^confirm$/], sup: [/num_confirmations|^get_request/, /^delete_request$/] },
  'bridge': { label: 'Bridge', req: [/finish_deposit|finish_withdraw|_bridge_/], sup: [/deploy_bridge_token|bridged_token|locked_tokens|relayer/] },
  'oracle': { label: 'Price oracle', req: [/report_prices|get_price_data/], sup: [/oracle/] },
  'router': { label: 'Intents / swap router', req: [/^execute_intents$|^callback_swap$|withdraw_from_amm|withdraw_from_dcl/], sup: [/^mt_|_withdraw$/] },
  'factory': { label: 'Launchpad / factory', req: [/on_pool_created|create_locker|get_meme_stakes|deploy_token|create_token|on_lockup_create|^create$|^create_dao$|deploy_bridge_token/], sup: [/creator_fees|fee|locker|launch|code_hash/] },
  'orderbook': { label: 'Perp / order book', req: [/operator_execute_action|deposit_and_create_order|set_market_options|^swap_near$|^place_order$|^new_order$/], sup: [/withdraw|deposit/] },
  'nft_marketplace': { label: 'NFT marketplace', req: [/^nft_on_approve$/, /buy|offer|^add_market_data$|^list_market|delete_market_data/], sup: [/^storage_deposit$/, /fee|royalt/] },
  'farm': { label: 'Farm / vault', req: [/farm|seed|reward/, /^claim|^withdraw_reward|^harvest/], sup: [/stake|unstake|lock/], not: [/margin_execute|borrow|liquidat|collateral/] },
  'lockup': { label: 'Lockup / vesting', req: [/terminate_vesting|get_vesting_information|^check_transfers_vote$|^get_termination_status$/], sup: [/^transfer$|unstake|withdraw/] },
  'account': { label: 'Account contract (smart wallet)', req: [/^add_public_key$|^add_full_access_key$|^add_access_key$|^w_execute$|^execute_signed$/], sup: [/^new$/, /^execute$|signature|nonce/] },
};

/**
 * { role, label, standards, confidence: high | medium | low, candidates } or role 'unknown' with a reason.
 * `knownRole` (from a known code family) wins outright.
 */
export function classifyContract(exports, { knownRole = null } = {}) {
  if (!exports) return { role: 'unknown', label: 'Unknown', standards: [], confidence: 'low', why: 'no readable code' };
  const standards = standardsOf(exports);
  if (knownRole) return { role: knownRole, label: ROLES[knownRole]?.label || knownRole, standards, confidence: 'high', why: 'known code family' };
  if (exports.length <= 2) return { role: 'unknown', label: 'Unknown', standards, confidence: 'low', why: 'too few exports (a JS or proxy contract)' };
  const has = (re) => exports.some((m) => re.test(m));
  const scores = Object.entries(ROLES).map(([role, r]) => {
    if ((r.not || []).some(has)) return { role, score: 0 };
    // every required group must be there (a half match is how a token with a liquidity callback looked like an AMM)
    const req = r.req.every(has);
    return { role, score: req ? 2 + r.sup.filter(has).length / r.sup.length : 0 };
  }).filter((x) => x.score >= 1.5).sort((a, b) => b.score - a.score);
  const candidates = scores.slice(0, 3).map((x) => ({ role: x.role, score: +x.score.toFixed(2) }));
  if (scores.length) {
    const top = scores[0], second = scores[1];
    const confidence = top.score >= 2.5 && (!second || top.score - second.score >= 0.5) ? 'high' : top.score >= 2 ? 'medium' : 'low';
    return { role: top.role, label: ROLES[top.role].label, standards, confidence, candidates };
  }
  // no protocol role: the standard it implements is what it is
  if (standards.includes('nep171')) return { role: 'nft', label: 'NFT collection', standards, confidence: 'high', candidates };
  if (standards.includes('nep141')) return { role: 'token', label: 'Fungible token', standards, confidence: 'high', candidates };
  if (standards.includes('nep245')) return { role: 'multi_token', label: 'Multi-token', standards, confidence: 'high', candidates };
  return { role: 'unknown', label: 'Unknown', standards, confidence: 'low', candidates, why: 'no known method set' };
}
export const ROLE_LABEL = (role) => ({ nft: 'NFT collection', token: 'Fungible token', multi_token: 'Multi-token', unknown: 'Unknown' }[role] || ROLES[role]?.label || role);
