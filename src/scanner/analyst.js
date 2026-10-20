// The AI analyst (NEAR AI): reviews a launch that already passed the hard gates and says whether to buy it (simulated).
import { config } from '../config.js';
import { chatJSON } from '../ai/nearai.js';

const system = (ctx) => `You review brand-new memecoins on NEAR for an automated SIMULATED buyer that spends a fixed amount per token (paper money, but judge as if it were real).
You receive on-chain features collected ${ctx.followUpMinutes ? `${ctx.followUpMinutes} minutes after` : 'a few minutes after'} the token's liquidity went live.
${ctx.holding ? `The simulated portfolio ALREADY HOLDS this token (cost ${ctx.holding.costNear} NEAR). Decide what to do with the position:
- HOLD: keep it. SELL: exit now (coordination, creator extraction, a trap, or demand fading: buyers exiting, net selling). BUY_MORE is not available: treat it as HOLD.`
  : `Nothing is held yet: the token passed the hard rules and your verdict decides whether we buy ${config.sim.buyNear} NEAR now.
- BUY_MORE: buy. Only when the evidence is clearly good: real demand from independent wallets, no sign of coordination or creator extraction.
- HOLD or SELL: do not buy (HOLD = decent but unproven; SELL = evidence of coordination, creator extraction or a trap).`}
Set confidence for the action you recommend.

What past investigations on these launchpads showed (use it, don't recite it):
- nearly.trade / justhoot launch single-sided: the pool starts with tokens only, so NEAR in the pool comes from buyers.
- Pools may be quoted in wNEAR, NEARLY, RHEA or QTC; all NEAR amounts in the features are already converted to NEAR.
- We buy in the first minutes after liquidity goes live. At that stage a few early buyers holding a large share of supply is normal and an accepted risk: do not reject for buyer or holder concentration alone. What matters is whether those buyers are coordinated with each other or the creator (shared non-exchange funders, creator-funded wallets, hand-offs to fresh wallets).
- features.market.mcapUsd is the fully diluted market cap in USD. Below ${config.rules.ignoreRunupBelowMcapUsd.toLocaleString('en-US')} USD the token is still early: a 2-3x rise since the first trade is fine. Above it, a price many multiples above the first trade usually means the buyer is late exit liquidity.
- Creators of real projects usually keep their allocation; a creator selling early or funding buyers is a strong negative.
- A non-standard token contract (code hash different from the launchpad template) was a honeypot that erased buyers' balances.
- Funding through exchanges or NEAR Intents is normal and is not evidence of a link by itself.
- features.intel is this tracker's memory of who buys early: early_buyer_groups shows how much of the early buying (wallets, NEAR, share) comes from groups it judged good, bad (dangerous: insiders, rug farmers, sybil snipers), bots_losers (bots and consistent losers that buy every launch: not a warning by themselves), neutral or unknown, and creator_prior_* shows whether this creator already launched tokens that were rugged or dumped. Money from groups judged good is a positive; money from groups judged bad (insiders, rug farmers, sybil snipers, bots) is a strong negative, and so is a creator with earlier rugs.
- features.audit is a contract audit of the token: access keys (a full-access key lets its holder redeploy or drain the contract), code findings (fake NEP-145 storage methods are the classic honeypot backdoor; privileged methods such as blacklist / freeze / mint / upgrade), launchpad buy/sell tax, and recent sell behaviour (wallets that cannot sell). confirmed_malicious findings are a strong negative; a launchpad's own tax methods and a standard template are normal. risk_score is 0-100, higher = riskier.
Be strict about coordination and creator extraction.
Reply with ONE JSON object and nothing else, with exactly these keys:
{"action":"BUY_MORE"|"HOLD"|"SELL","confidence":number 0..1,"quality_score":integer 0..100,"risk_level":"low"|"medium"|"high"|"extreme","reasons":["short evidence-based points"],"red_flags":["short points"]}`;

const ACTIONS = new Set(['BUY_MORE', 'HOLD', 'SELL']);
const RISKS = new Set(['low', 'medium', 'high', 'extreme']);
const list = (x) => (Array.isArray(x) ? x.map((s) => String(s).slice(0, 300)).slice(0, 8) : []);

export function normaliseAnalysis(j) {
  if (!j || !ACTIONS.has(j.action)) return null;
  const conf = Number(j.confidence), q = Number(j.quality_score);
  return { action: j.action, confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5, quality_score: Number.isFinite(q) ? Math.max(0, Math.min(100, Math.round(q))) : null,
    risk_level: RISKS.has(j.risk_level) ? j.risk_level : 'high', reasons: list(j.reasons), red_flags: list(j.red_flags) };
}

/** ctx: { holding: {costNear} | null, followUpMinutes?: number, previous?: [earlier verdicts] } */
export async function analyse(features, rules, ctx = {}) {
  const user = `Rule engine: score ${rules.score}/100, ${rules.failed.length ? 'failed gates: ' + rules.failed.map((g) => g.id).join(', ') : 'all gates passed'}.\n`
    + (ctx.previous?.length ? `Earlier reviews of this token: ${JSON.stringify(ctx.previous)}\n` : '') + `\nFeatures:\n${JSON.stringify(features)}`;
  const { json, model, usage } = await chatJSON({ system: system(ctx), user, maxTokens: config.ai.maxTokens });
  const a = normaliseAnalysis(json);
  if (!a) throw new Error('NEAR AI answer did not match the expected format');
  return { ...a, model, usage, ts: Date.now() };
}
