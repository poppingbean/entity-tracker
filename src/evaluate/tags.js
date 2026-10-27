// Win-rate tags and rugger checks shared by the dashboard API and the token analysis.

// tags: loss = lost money overall; net profit: win80 / win50 / win30 = profitable in 80 / 50 / 30 %+ of the tokens bought early, sniper = under
// 30 % (a few big wins); unrated = too few tokens judged yet
export const TAGS = ['win80', 'win50', 'win30', 'sniper', 'loss', 'unrated'];
export const tagOf = (t) => (TAGS.includes(t) ? t : 'unrated');
// rugger wallets: a token creator that rugged or is blacklisted, or a member of a group that contains one (creator-rug) or that the rules
// call rug farmers. Independent of the win / loss tag: a rugger can make money.
const RUG_TAGS = new Set(['creator-rug', 'rug-farmer']);
export const ruggerGroup = (c) => !!c && (c.creator_flag === 'rugger' || c.creator_flag === 'blacklisted' || (c.rule?.tags || []).some((t) => RUG_TAGS.has(t)));
export const ruggerWallet = (w, c) => !!(w?.creator && (w.creator.rugged > 0 || w.creator.blacklisted)) || ruggerGroup(c);

// ---- tag groups: wallets grouped by what they DO, not by who owns them (that is a linked group). Every early wallet sits in the group
// of its win-rate tag and in each behaviour group that fits it; a wallet linked to nobody lives only here.
export const BEHAVIOURS = {
  cobuy: 'Co-buy swarm: bought within seconds of the same wallets in several launches',
  insider: 'Insider: funded by, or paid, the creator of a token it bought early',
  'rug-linked': 'Rug-linked: a creator that rugged or is blacklisted, or in a group with one',
};
export const TAG_GROUPS = [...TAGS, ...Object.keys(BEHAVIOURS)];

/** A wallet's behaviour groups. */
export const walletBehaviours = ({ cobuyPartners = 0, insider = false, rugger = false }) =>
  [cobuyPartners > 0 ? 'cobuy' : null, insider ? 'insider' : null, rugger ? 'rug-linked' : null].filter(Boolean);

/**
 * What a wallet's tag groups say about its early money, for the gate: dangerous (an insider, or itself a creator that rugged or is
 * blacklisted; "rug-linked" through its group alone is left to the group's verdict), good (win80 / win50), bots (loss, or a co-buy swarm
 * wallet that is not a winner), or null.
 */
export function tagVerdict(tag, behaviours = [], { selfRugger = false } = {}) {
  if (behaviours.includes('insider') || selfRugger) return 'dangerous';
  if (tag === 'win80' || tag === 'win50') return 'good';
  if (tag === 'loss' || behaviours.includes('cobuy')) return 'bots';
  return null;
}
