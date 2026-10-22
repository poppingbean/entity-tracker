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
