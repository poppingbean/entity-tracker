// NEAR AI's written assessment of a token analysis: an executive summary, key findings and a conclusion, in the voice of the hand-written
// investigations, from the numbers the analysis already holds. Stored next to the analysis in `analyses`.
import { col } from '../db.js';
import { chatJSON } from '../ai/nearai.js';
import { config } from '../config.js';

const SYSTEM = `You are an on-chain analyst writing a short investigation of a NEAR Protocol meme token (launchpads: nearly.trade, justhoot, meme.cooking).
You get one JSON evidence packet built by a tracker: launch mechanics and contract audit, the creator (age, funders, earlier launches, trades in this token, current balance),
price and flows after launch, the early buyers (entry rank, delay, NEAR in, share of supply, wallet age, win-rate tag, group), the linked GROUPS among early buyers
(wallets the tracker links by funding chains, money flow and synchronised buys; their tag and lifetime record), funders shared by several early buyers,
repeat actors seen early in other launches, the biggest sellers, the largest holders (balances checked live) and rule-based risk flags.
Tags: win80 / win50 / win30 = profitable in 80 / 50 / 30 %+ of the tokens they bought early, sniper = net profit from a few big wins, loss = lost money overall, unrated = too few tokens.
Rules: use only the supplied facts and numbers; never invent accounts, amounts or events; shares are fractions (0.05 = 5%); say "linked" for tracker groups and shared funders,
"proven common control" only when a wallet funded another directly; keep account names exactly as given (shorten 64-hex ids to their first 8 characters + "…").
Reply with ONE JSON object and nothing else, with exactly these keys:
{"summary":"3-5 sentences: what happened at launch, who bought, who is in control now","findings":["4-7 short findings, most important first"],
"risk_level":"low"|"medium"|"high","confidence":number 0..1,"conclusion":"2-3 sentences: overall assessment and what to watch"}`;

const short = (s) => (typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) ? s.slice(0, 8) + '…' : s);
const g = (x) => (x ? { id: x.id, label: x.label, tag: x.tag, rugger: x.rugger || undefined } : null);

/** The evidence packet: the analysis trimmed to what the model needs. */
export function aiPacket(a) {
  return {
    token: a.token, symbol: a.symbol, age_min: a.age_min, launch: a.launch,
    creator: a.creator && { ...a.creator, account: short(a.creator.account), funders: (a.creator.funders || []).map((f) => ({ ...f, account: short(f.account) })) },
    flows: a.flows,
    early: { wallets: a.early.wallets, near_in: a.early.near_in, first: a.early.rows.slice(0, 12).map((e) => ({ wallet: short(e.wallet), rank: e.rank, delay_s: e.delay_s, buy_near: e.buy_near, supply_share: e.supply_share, roi_now: e.roi_now, sold_share_now: e.sold_share_now, wallet_age_days: e.wallet_age_days, tag: e.tag, group: e.group?.id || null, notes: e.notes })) },
    groups: a.groups.slice(0, 6).map((x) => ({ ...g(x), size: x.size, members_here: x.members.length, near_in: x.near_in, early_near_share: x.early_near_share, supply_share: x.supply_share, realized_now: x.realized_now, unrealized_now: x.unrealized_now, lifetime: x.lifetime })),
    shared_funders: a.shared_funders.slice(0, 6).map((x) => ({ funder: short(x.funder), kind: x.kind, wallets: x.wallets.map(short), strength: x.strength, same_group: x.same_group })),
    repeat: a.repeat.slice(0, 8).map((x) => ({ ...x, wallet: short(x.wallet), group: x.group?.id || null })),
    sellers: a.sellers.slice(0, 6).map((x) => ({ ...x, account: short(x.account), group: x.group?.id || null })),
    holders: { top10_share: a.holders.top10_share, rows: a.holders.rows.slice(0, 8).map((x) => ({ account: short(x.account), tokens: x.tokens, verified: x.verified, supply_share: x.supply_share, early_rank: x.early_rank, tag: x.tag, group: x.group?.id || null, is_creator: x.is_creator || undefined })) },
    flags: a.flags,
  };
}

const clean = (j) => ({
  summary: String(j.summary || '').slice(0, 1500), findings: (Array.isArray(j.findings) ? j.findings : []).map((x) => String(x).slice(0, 400)).slice(0, 8),
  risk_level: ['low', 'medium', 'high'].includes(j.risk_level) ? j.risk_level : 'medium', confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), conclusion: String(j.conclusion || '').slice(0, 1000),
});

/** Ask NEAR AI for an assessment of `analysis` and store it. */
export async function assessWithAi(analysis) {
  const { json, model } = await chatJSON({ system: SYSTEM, user: JSON.stringify(aiPacket(analysis)), model: config.ai.analysisModel, timeoutMs: config.ai.analysisTimeoutMs, attempts: 2, stream: true });
  const ai = { ...clean(json), model, ts: Date.now(), for_built_ts: analysis.built_ts };
  await col('analyses').updateOne({ _id: analysis.token }, { $set: { ai } }, { upsert: true });
  return ai;
}
