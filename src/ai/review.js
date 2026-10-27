// Ask NEAR AI to judge a group of early investors from the evidence the tracker collected.
import { chatJSON } from './nearai.js';
import { UNTRUSTED_RULE, evidenceMessage } from './untrusted.js';

const r2 = (x, d = 2) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export const SYSTEM = `You are an on-chain analyst for NEAR Protocol memecoin launchpads (nearly.trade, justhoot, meme.cooking).
You are shown one GROUP of wallets that repeatedly bought tokens EARLY (inside the first minutes after the pool opened), grouped by on-chain relationships:
shared funders up the funding chain, NEAR flowing between them or into a shared destination, near-simultaneous buys across several tokens, and funding by a token's creator.
Decide whether the group is GOOD or BAD early money, judging only from the evidence given. Definitions:
- good: early buyers that make money in tokens that hold up (low rug share), with no insider links. Worth watching or following.
- bad: insiders (funded by or paying the token creator), rug farmers (profit mostly from tokens that collapsed), coordinated sybil snipers (many fresh wallets buying in the same seconds), bots, or consistent losers. Worth avoiding, or a warning when they appear in a token.
- neutral: mixed or unremarkable. unknown: too few judged tokens to say.
Rules: use only the supplied numbers; do not invent facts or token names; roi values are fractions (0.5 = +50%); a token "rugged" when its price fell at least 90% from its peak. Many tokens with few wallets each is weaker evidence than few wallets across many tokens. Lower your confidence when the sample is small (fewer than 5 judged tokens) or the evidence is mixed.
Reply with ONE JSON object and nothing else, with exactly these keys:
{"verdict":"good"|"bad"|"neutral"|"unknown","confidence":number 0..1,"label":"2-4 word name for the group","archetype":"smart-early"|"insider"|"rug-farmer"|"sybil-sniper"|"bot"|"consistent-loser"|"trader"|"unclear","summary":"2-3 sentences","reasons":["short evidence-based points"],"red_flags":["things that argue against the verdict or deserve caution"],"follow_advice":"follow"|"watch"|"avoid"|"ignore"}`;

/** The compact evidence packet sent to the model. */
export function buildPacket(cluster, walletDocs, tokenRows) {
  const m = cluster.metrics, links = cluster.links || [];
  const count = (type) => links.filter((l) => l.type === type);
  const kinds = {};
  for (const w of walletDocs) { const k = w.funder_kind || 'unknown'; kinds[k] = (kinds[k] || 0) + 1; }
  return {
    group: { wallets: cluster.size, rule_score: cluster.rule?.score, rule_verdict: cluster.rule?.verdict, rule_tags: cluster.rule?.tags },
    metrics: {
      judged_tokens: m.tokens_n, entries: m.entries_n, total_buy_near: r2(m.total_buy_near, 1), pnl_near: r2(m.pnl_near, 1), roi_weighted: r2(m.roi_weighted), median_token_roi: r2(m.median_token_roi),
      win_rate: r2(m.win_rate), loss_rate: r2(m.loss_rate), rug_tokens: m.rug_tokens_n, rug_share: r2(m.rug_share), win_rate_in_rugs: r2(m.win_rate_in_rugs), pnl_in_rugs_near: r2(m.pnl_in_rugs, 1),
      creator_linked_share: r2(m.creator_linked_share), fresh_wallet_share: r2(m.fresh_share), synchronised_buy_share: r2(m.sync_share), avg_entry_delay_s: r2(m.avg_delay_s, 0), first_five_buyer_share: r2(m.first_movers_share),
    },
    structure: {
      shared_funders: count('shared_funder').slice(0, 6).map((l) => ({ funder: l.anchor, wallets: l.wallets.length })),
      funded_by_member_wallets: count('funded_by_member').length, flow_between_members: count('flow_between_members').length,
      shared_destinations: count('shared_destination').slice(0, 5).map((l) => ({ destination: l.anchor, wallets: l.wallets.length })),
      cobuy_pairs: count('cobuy').length, creator_linked_wallets: new Set(count('creator_linked').flatMap((l) => l.wallets)).size,
      first_funder_kinds: kinds,
    },
    recent_tokens: tokenRows.slice(0, 20).map((t) => ({ symbol: t.symbol, launchpad: t.launchpad, group_wallets: t.wallets, buy_near: r2(t.buy_near, 1), roi: r2(t.roi), rugged: t.rugged, peak_multiple: r2(t.peak_multiple, 1), insider_wallets: t.insider_wallets, first_buy_delay_s: t.first_delay_s, sold_within_1h: r2(t.sold_share) })),
    top_wallets: walletDocs.slice(0, 8).map((w) => ({ wallet: w._id, tx_count: w.tx_count ?? null, kind: w.kind || null, first_funder_kind: w.funder_kind || null, funded_near: r2(w.funding_near, 1), age_days: w.created_ts ? r2((Date.now() - w.created_ts) / 86400e3, 0) : null })),
  };
}

const VERDICTS = new Set(['good', 'bad', 'neutral', 'unknown']);
const ARCH = new Set(['smart-early', 'insider', 'rug-farmer', 'sybil-sniper', 'bot', 'consistent-loser', 'trader', 'unclear']);
const ADVICE = new Set(['follow', 'watch', 'avoid', 'ignore']);
const strList = (x) => (Array.isArray(x) ? x.map((s) => String(s).slice(0, 300)).slice(0, 8) : []);

/** Validate / normalise the model's answer. Returns null when it is unusable. */
export function normaliseReview(j) {
  if (!j || !VERDICTS.has(j.verdict)) return null;
  const conf = Number(j.confidence);
  return {
    verdict: j.verdict, confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5, label: String(j.label || '').slice(0, 60) || null,
    archetype: ARCH.has(j.archetype) ? j.archetype : 'unclear', summary: String(j.summary || '').slice(0, 800), reasons: strList(j.reasons), red_flags: strList(j.red_flags),
    follow_advice: ADVICE.has(j.follow_advice) ? j.follow_advice : 'watch',
  };
}

export async function reviewCluster(cluster, walletDocs, tokenRows) {
  const packet = buildPacket(cluster, walletDocs, tokenRows);
  const { user, findings } = evidenceMessage('Evidence for this group:', packet);
  const { json, model, usage } = await chatJSON({ system: SYSTEM + UNTRUSTED_RULE, user });
  const review = normaliseReview(json);
  if (!review) throw new Error('NEAR AI answer did not match the expected format');
  // data that tried to instruct the AI: the review cannot call the group good
  if (findings.length && review.verdict === 'good') { review.verdict = 'neutral'; review.confidence = Math.min(review.confidence, 0.5); }
  return { ...review, model, usage, ts: Date.now(), ...(findings.length ? { injection: findings } : {}) };
}
