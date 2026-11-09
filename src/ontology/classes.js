// The ontology's class tree: one primary class per account (docs/ontology-design.md, 3.1). Changed by hand, here and in the doc.

export const CLASSES = {
  person: ['wallet', 'smart_wallet', 'app_user'],
  exchange: ['hot_wallet', 'cold_wallet', 'deposit_address'],
  service: ['intents_solver', 'relayer', 'bridge', 'router', 'launchpad', 'treasury_or_reward', 'factory'],
  contract: ['token', 'nft', 'amm', 'lending', 'vault_farm', 'dao', 'multisig', 'staking', 'other'],
  system: [],
};

const ALL = new Set(Object.entries(CLASSES).flatMap(([top, subs]) => [top, ...subs.map((s) => `${top}/${s}`)]));
ALL.add('unknown');

export const isClass = (c) => ALL.has(c);
export const topOf = (c) => String(c || 'unknown').split('/')[0];
/** a is b, or a subclass of b ('exchange/hot_wallet' is 'exchange'). */
export const isA = (a, b) => a === b || String(a).startsWith(b + '/');
/** Two classes that do not contradict each other: equal, or one refines the other. */
export const compatible = (a, b) => isA(a, b) || isA(b, a);

/** Classes that only pass money through: walks record them as an endpoint, and they never link owners. */
export const PASS_CLASSES = ['service/router', 'service/relayer', 'system'];
export const isPassClass = (c) => PASS_CLASSES.some((p) => isA(c, p));

/**
 * Sharing this account says nothing about who owns two wallets (an exchange, a service, a contract, the system). Only people link
 * owners; an account nothing is known about is treated like a person, as grouping does today.
 */
export const cutsLinks = (c) => !['person', 'unknown'].includes(topOf(c));

/** Audit roles (src/audit/classify.js) onto the tree. */
export const AUDIT_ROLE = {
  token: 'contract/token', multi_token: 'contract/token', nft: 'contract/nft', nft_marketplace: 'contract/nft', amm: 'contract/amm', orderbook: 'contract/amm',
  lending: 'contract/lending', farm: 'contract/vault_farm', liquid_staking: 'contract/staking', staking_pool: 'contract/staking', lockup: 'contract/other',
  dao: 'contract/dao', multisig: 'contract/multisig', oracle: 'contract/other', account: 'person/smart_wallet', factory: 'service/factory',
  bridge: 'service/bridge', router: 'service/router', unknown: null,
};
export const fromAuditRole = (role) => { const r = String(role || '').toLowerCase(); return r in AUDIT_ROLE ? AUDIT_ROLE[r] : (r ? 'contract/other' : null); };

/** Source rank: a higher source wins whatever its confidence (3.3). */
export const SOURCE_RANK = { manual: 7, public_report: 6, registry: 5, audit: 4, trace: 3, behaviour: 2, name_pattern: 1 };
export const rankOf = (s) => SOURCE_RANK[s] || 0;

export const PREDICATES = new Set(['is_a', 'operated_by', 'label', 'controls', 'deployed', 'created_by', 'funded', 'swept_to', 'solver_for', 'member_of', 'role_in', 'flagged', 'pass_through', 'trusted']);
export const SEVERITY = { critical: 3, high: 2, medium: 1, low: 0 };
