// Which exported methods give someone power over users, and how serious each power is for this kind of contract. Pure (unit-tested).
// The same name means different things per role: `force_withdraw` is a documented emergency path on a bridge and a rug tool on a meme
// token, so each power has a base severity per role. The audit then adjusts it by who holds it (control.js): a DAO or multisig owner, or
// no owner at all, makes it less dangerous than a single wallet.

const IS_VIEW = /^(get_|is_|view_|list_|query_)|_(get|is)_|_(of|info|list|status|count|config|state|balance|metadata|data|policy)$|(^|_)(is|all)_paused$|^(owner|version|guardians|fee|fee_collector)$/;
const IS_CALLBACK = /^on_|_callback$|^callback_|^resolve_|^after_|_resolve_|_on_call$|^(ft|nft|mt)_on_/;

export const POWERS = {
  account_control: { label: 'Adds or removes keys on the account', re: /^(add_public_key|add_full_access_key|add_access_key|delete_access_key|remove_key|add_key|rotate_key)$/ },
  upgrade: { label: 'Replaces the contract code', re: /^(upgrade|upgrade_self|owner_upgrade|platform_upgrade|upgrade_and_migrate|update_code|update_contract|deploy_code|stage_code|deploy_upgrade|approve_upgrade|upgrade_contract)$/ },
  move_user_funds: { label: "Moves or wipes users' balances", re: /force_withdraw|force_transfer|^seize|confiscate|^burn_from$|^set_balance|admin_transfer|^admin_burn|^nft_force_|^drain_(?!unstake|withdraw)|withdraw_lost|^rescue|^sweep/ },
  freeze: { label: 'Pauses, freezes or blacklists users', re: /^(?!.*mint)(?:^(pause|unpause|un_pause|pa_pause|pa_unpause)|_pause|pause_|^set_paused|freeze|blacklist|blocklist|^ban_|lock_account|^set_restricted|^(enable|disable)_trading|^set_trading(_|$)|^set_tradable|^halt)/ }, // pausing the MINT is not freezing users
  mint: { label: 'Mints new tokens', re: /^(mint|ft_mint|mint_to|issue|nft_mint|nft_batch_mint|mint_batch|airdrop_mint)$/ },
  set_fees: { label: 'Changes fees or taxes', re: /fee|tax|commission/ },
  set_oracle: { label: 'Changes the price source', re: /oracle|set_price|report_price/ },
  set_admins: { label: 'Changes owners or admins', re: /^(set|change|update|transfer|grant|add|remove|extend|propose|platform_set)_\w*(owner|admin|guardian|operator|upgrader|manager|controller|role)|^acl_(add|grant|init|transfer|revoke)|^transfer_ownership$|^grant_next_owner$/ },
  metadata_control: { label: 'Changes token metadata or media', re: /set_metadata|update_metadata|token_metadata_update|set_base_uri|set_media|update_media|upgrade_icon|upgrade_name|set_icon|reveal/ },
  royalty_control: { label: 'Changes royalties or payouts', re: /royalt|set_payout|update_payout/ },
};

// Base severity per power, then per role where it differs ("normal for this kind of contract").
const BASE = { account_control: 'critical', upgrade: 'medium', move_user_funds: 'critical', freeze: 'medium', mint: 'medium', set_fees: 'low', set_oracle: 'medium', set_admins: 'low', metadata_control: 'low', royalty_control: 'low' };
const BY_ROLE = {
  token: { mint: 'high', freeze: 'high', set_fees: 'high', upgrade: 'high' },
  nft: { mint: 'medium', metadata_control: 'high', freeze: 'high', royalty_control: 'medium', upgrade: 'high' },
  bridge: { move_user_funds: 'medium', freeze: 'low', mint: 'low' },
  router: { move_user_funds: 'medium', freeze: 'low', account_control: 'low' }, // intents: keys on users' accounts INSIDE intents
  lending: { set_oracle: 'high', freeze: 'low', move_user_funds: 'high' },
  oracle: { set_oracle: 'low' },
  amm: { freeze: 'low', move_user_funds: 'medium' },
  liquid_staking: { freeze: 'low' },
  staking_pool: { freeze: 'low' },
  account: { account_control: 'low' }, // what a smart wallet is for; anyone being able to call it is caught apart (unguarded_power)
  dao: { set_admins: 'info', upgrade: 'low' },
  multisig: { set_admins: 'info', account_control: 'low' },
  factory: { set_fees: 'info', upgrade: 'medium', move_user_funds: 'medium' },
};
export const SEV = ['critical', 'high', 'medium', 'low', 'info'];
/** How serious a power is for this kind of contract. */
export const powerSeverity = (role, power) => BY_ROLE[role]?.[power] || BASE[power] || 'medium';
const normal = (role, power) => !!BY_ROLE[role]?.[power] && SEV.indexOf(BY_ROLE[role][power]) > SEV.indexOf(BASE[power]);

/**
 * The powers in a contract's exports. Returns [{ power, label, methods, severity, normal_for_role }], worst first.
 * `fakeStorage` (from the static analysis) counts as moving users' funds: it is the classic NEAR honeypot backdoor.
 */
export function powerInventory(exports, role, { fakeStorage = [] } = {}) {
  if (!exports) return [];
  const writes = exports.filter((m) => !IS_VIEW.test(m) && !IS_CALLBACK.test(m));
  const out = [];
  for (const [power, def] of Object.entries(POWERS)) {
    let methods = writes.filter((m) => def.re.test(m));
    if (power === 'set_fees') methods = methods.filter((m) => /^(set|update|modify|change|enable|disable)_|_set_|^set$/.test(m)); // claim_fees / withdraw_fee are not powers
    if (power === 'move_user_funds' && fakeStorage.length) methods = [...new Set([...methods, ...fakeStorage])];
    if (!methods.length) continue;
    const severity = powerSeverity(role, power);
    out.push({ power, label: def.label, methods: methods.slice(0, 12), severity, normal_for_role: normal(role, power) || undefined });
  }
  return out.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
}

/** Methods the tables don't know: write methods outside the standards and the powers (for the AI to label, stage 2). */
export function unknownWrites(exports, inventory, standardMethods) {
  const known = new Set(inventory.flatMap((p) => p.methods));
  return (exports || []).filter((m) => !IS_VIEW.test(m) && !IS_CALLBACK.test(m) && !known.has(m) && !standardMethods.has(m) && !/^(new|migrate|new_default_meta|init|default)$/.test(m));
}
