// The AI analyst's written assessment of a token analysis (Claude Sonnet 5.5 served by NEAR AI). Run only when someone asks for it.
// The first run writes the assessment from the whole analysis; every later run updates it from what changed since the previous run
// (new trades, price, the creator, holders, early buyers and groups selling, risk flags), the way the hand-written reports add
// "Update" sections instead of starting over. The latest is `ai` in `analyses` (with the evidence it was built from, to diff the next run
// against); every run is also kept for good in `analysis_runs`, with its evidence and, for an update, what changed since the run before.
import { col } from '../db.js';
import { chatJSON } from '../ai/nearai.js';
import { config } from '../config.js';
import { tagOf } from '../evaluate/tags.js';
import { INFRA, groupBrief } from './token.js';

const COMMON = `Tags: win80 / win50 / win30 = profitable in 80 / 50 / 30 %+ of the tokens they bought early, sniper = net profit from a few big wins, loss = lost money overall, unrated = too few tokens.
Rules: use only the supplied facts and numbers; never invent accounts, amounts or events; shares are fractions (0.05 = 5%); say "linked" for tracker groups and shared funders,
"proven common control" only when a wallet funded another directly; keep account names exactly as given (shorten 64-hex ids to their first 8 characters + "…").`;

const SYSTEM = `You are an on-chain analyst writing a short investigation of a NEAR Protocol meme token (launchpads: nearly.trade, justhoot, meme.cooking).
You get one JSON evidence packet built by a tracker: launch mechanics and contract audit, the creator (age, funders, earlier launches, trades in this token, current balance),
price and flows after launch, the early buyers (entry rank, delay, NEAR in, share of supply, wallet age, win-rate tag, group), the linked GROUPS among early buyers
(wallets the tracker links by funding chains, money flow and synchronised buys; their tag and lifetime record), funders shared by several early buyers,
repeat actors seen early in other launches, the biggest sellers, the largest holders (balances checked live), TOKEN_FLOWS and rule-based risk flags.
TOKEN_FLOWS follows tokens that left the creator and the early buyers by plain transfer (not a sale), hop by hop: each account reached has its hop, the account it
received from, the tokens received, and its outcome (sold = it sold on the pool, sold_near counts all its sales of this token; passed on; kept; exchange). Use it to say
where the dev's and insiders' tokens really ended up: a creator or early buyer that "never sold" but passed tokens to wallets that then sold is a hidden dump.
${COMMON}
Reply with ONE JSON object and nothing else, with exactly these keys:
{"summary":"3-5 sentences: what happened at launch, who bought, who is in control now","findings":["4-7 short findings, most important first"],
"risk_level":"low"|"medium"|"high","confidence":number 0..1,"conclusion":"2-3 sentences: overall assessment and what to watch"}`;

const SYSTEM_UPDATE = `You are an on-chain analyst keeping an investigation of a NEAR Protocol meme token up to date.
You get: "previous" = your last assessment and when it was written; "since" = what changed on chain between that assessment and now (trades in the window, the biggest
buyers and sellers in it with their tag and group, price, the creator, early buyers and linked groups that sold, holders that entered, left or moved, risk flags added or
removed); "now" = a compact view of the current state, with TOKEN_FLOWS (tokens that left the creator and early buyers by transfer, followed hop by hop: who received
them and whether they sold on the pool, passed them on, kept them or sent them to an exchange). Update the assessment: keep what still holds, revise what the new activity changes, and do not retell the launch.
${COMMON}
Reply with ONE JSON object and nothing else, with exactly these keys:
{"changes":["2-6 short points on what happened since the previous assessment, most important first"],"summary":"3-5 sentences: the current picture",
"findings":["4-7 short findings as they stand now, most important first"],"risk_level":"low"|"medium"|"high","confidence":number 0..1,
"conclusion":"2-3 sentences: overall assessment now, whether the risk moved and why, and what to watch"}`;

const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const short = (s) => (typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) ? s.slice(0, 8) + '…' : s);
const g = (x) => (x ? { id: x.id, label: x.label, tag: x.tag, rugger: x.rugger || undefined } : null);

/** The evidence packet: the analysis trimmed to what the model needs. Also kept as the snapshot the next update is compared with. */
export function aiPacket(a) {
  return {
    token: a.token, symbol: a.symbol, age_min: a.age_min, data_to_ts: a.data_to_ts, launch: a.launch,
    creator: a.creator && { ...a.creator, account: short(a.creator.account), funders: (a.creator.funders || []).map((f) => ({ ...f, account: short(f.account) })) },
    flows: a.flows,
    early: { wallets: a.early.wallets, near_in: a.early.near_in, first: a.early.rows.slice(0, 12).map((e) => ({ wallet: short(e.wallet), rank: e.rank, delay_s: e.delay_s, buy_near: e.buy_near, supply_share: e.supply_share, roi_now: e.roi_now, sold_share_now: e.sold_share_now, wallet_age_days: e.wallet_age_days, tag: e.tag, group: e.group?.id || null, notes: e.notes })) },
    groups: a.groups.slice(0, 6).map((x) => ({ ...g(x), size: x.size, members_here: x.members.length, near_in: x.near_in, early_near_share: x.early_near_share, supply_share: x.supply_share, realized_now: x.realized_now, unrealized_now: x.unrealized_now, lifetime: x.lifetime })),
    shared_funders: a.shared_funders.slice(0, 6).map((x) => ({ funder: short(x.funder), kind: x.kind, wallets: x.wallets.map(short), strength: x.strength, same_group: x.same_group })),
    repeat: a.repeat.slice(0, 8).map((x) => ({ ...x, wallet: short(x.wallet), group: x.group?.id || null })),
    sellers: a.sellers.slice(0, 6).map((x) => ({ ...x, account: short(x.account), group: x.group?.id || null })),
    holders: { top10_share: a.holders.top10_share, rows: a.holders.rows.slice(0, 10).map((x) => ({ account: short(x.account), tokens: x.tokens, verified: x.verified, supply_share: x.supply_share, early_rank: x.early_rank, tag: x.tag, group: x.group?.id || null, is_creator: x.is_creator || undefined })) },
    token_flows: flowsBrief(a.token_flows),
    flags: a.flags,
  };
}

/** The transfer trails, trimmed for the model: the largest trails and the accounts that matter most in each (sold, exchange, then by tokens). */
function flowsBrief(f) {
  if (!f) return null;
  const rank = { exchange: 0, sold: 1, 'passed on': 2, kept: 3 };
  return { hops: f.hops, transfers: f.transfers, trails: (f.trails || []).slice(0, 6).map((t) => ({ source: short(t.account), role: t.role, rank: t.rank ?? undefined, out_tokens: t.out_tokens, out_share: t.out_share, summary: t.summary,
    reached: [...t.reached].sort((a, b) => rank[a.outcome] - rank[b.outcome] || b.tokens - a.tokens).slice(0, 15)
      .map((x) => ({ account: short(x.account), hop: x.hop, from: short(x.from), tokens: x.tokens, supply_share: x.supply_share, outcome: x.outcome, sold_near: x.sold_near || undefined, label: x.label || undefined, tag: x.tag || undefined, group: x.group?.id || undefined })) })) };
}

/** Compare two packets (previous snapshot, current): what moved, without the trades (see changesSince). No I/O. */
export function diffPackets(prev, cur) {
  const out = {};
  const pf = prev.flows || {}, cf = cur.flows || {};
  out.price = { now_multiple: { was: pf.now_multiple ?? null, now: cf.now_multiple ?? null }, peak_multiple: { was: pf.peak_multiple ?? null, now: cf.peak_multiple ?? null } };
  const pc = prev.creator, cc = cur.creator;
  if (pc || cc) {
    const was = { balance: pc?.balance ?? null, balance_share: pc?.balance_share ?? null, sold_near: pc?.traded?.sell_near ?? 0 }, now = { balance: cc?.balance ?? null, balance_share: cc?.balance_share ?? null, sold_near: cc?.traded?.sell_near ?? 0 };
    if (was.balance !== now.balance || was.sold_near !== now.sold_near) out.creator = { was, now };
  }
  const ph = new Map((prev.holders?.rows || []).map((h) => [h.account, h])), ch = new Map((cur.holders?.rows || []).map((h) => [h.account, h]));
  const holders = { top10_share: { was: prev.holders?.top10_share ?? null, now: cur.holders?.top10_share ?? null }, entered: [], left: [], moved: [] };
  for (const [acc, h] of ch) {
    const p = ph.get(acc);
    if (!p) holders.entered.push({ account: acc, supply_share: h.supply_share, tag: h.tag, group: h.group, early_rank: h.early_rank });
    else if (Math.abs((h.supply_share ?? 0) - (p.supply_share ?? 0)) >= 0.002) holders.moved.push({ account: acc, was: p.supply_share, now: h.supply_share });
  }
  for (const [acc, p] of ph) if (!ch.has(acc)) holders.left.push({ account: acc, was: p.supply_share });
  out.holders = holders;
  const pe = new Map((prev.early?.first || []).map((e) => [e.wallet, e]));
  out.early_sold = (cur.early?.first || []).map((e) => ({ e, p: pe.get(e.wallet) })).filter(({ e, p }) => p && (e.sold_share_now ?? 0) - (p.sold_share_now ?? 0) >= 0.05)
    .map(({ e, p }) => ({ wallet: e.wallet, rank: e.rank, group: e.group, sold_share: { was: p.sold_share_now, now: e.sold_share_now } }));
  const pg = new Map((prev.groups || []).map((x) => [x.id, x]));
  out.groups = (cur.groups || []).map((x) => ({ x, p: pg.get(x.id) })).filter(({ x, p }) => !p || Math.abs((x.realized_now ?? 0) - (p.realized_now ?? 0)) >= 1)
    .map(({ x, p }) => ({ id: x.id, label: x.label, tag: x.tag, new_here: !p || undefined, realized_now: { was: p?.realized_now ?? null, now: x.realized_now }, unrealized_now: { was: p?.unrealized_now ?? null, now: x.unrealized_now } }));
  const pt = new Set((prev.flags || []).map((f) => f.text)), ct = new Set((cur.flags || []).map((f) => f.text));
  out.flags = { added: (cur.flags || []).filter((f) => !pt.has(f.text)), removed: (prev.flags || []).filter((f) => !ct.has(f.text)) };
  return out;
}

/** Trades between the previous assessment's data and now: totals, and the biggest buyers and sellers with their tag and group. */
async function tradesSince(token, fromTs, toTs) {
  const trades = await col('trades').find({ token, ts: { $gt: fromTs ?? 0, ...(toTs ? { $lte: toTs } : {}) } }, { projection: { trader: 1, buy: 1, near: 1 } }).toArray();
  const by = new Map();
  for (const t of trades) { const x = by.get(t.trader) || { account: t.trader, buy_near: 0, sell_near: 0 }; if (t.buy) x.buy_near += t.near; else x.sell_near += t.near; by.set(t.trader, x); }
  const rows = [...by.values()];
  const wallets = await col('wallets').find({ _id: { $in: rows.map((x) => x.account) } }, { projection: { cluster_id: 1, tag: 1 } }).toArray();
  const wmap = new Map(wallets.map((w) => [w._id, w]));
  const clusters = await col('clusters').find({ _id: { $in: [...new Set(wallets.map((w) => w.cluster_id).filter(Boolean))] } }, { projection: { size: 1, tag: 1, 'ai.label': 1, 'rule.tags': 1, creator_flag: 1 } }).toArray();
  const cmap = new Map(clusters.map((c) => [c._id, c]));
  const who = (x) => { const w = wmap.get(x.account), c = cmap.get(w?.cluster_id); const gb = groupBrief(c); return { account: short(x.account), tag: w ? tagOf(w.tag) : null, group: gb ? g(gb) : null, infra: INFRA.test(x.account) || undefined }; };
  const sum = (f) => r(trades.filter(f).reduce((s, t) => s + t.near, 0));
  return {
    window: { from_ts: fromTs ?? null, to_ts: toTs ?? null }, trades: trades.length, buy_near: sum((t) => t.buy), sell_near: sum((t) => !t.buy),
    buyers: rows.filter((x) => x.buy_near > 0).length, sellers: rows.filter((x) => x.sell_near > 0).length,
    top_buyers: rows.filter((x) => x.buy_near > 0).sort((a, b) => b.buy_near - a.buy_near).slice(0, 8).map((x) => ({ ...who(x), buy_near: r(x.buy_near), sell_near: r(x.sell_near) })),
    top_sellers: rows.filter((x) => x.sell_near > 0).sort((a, b) => b.sell_near - a.sell_near).slice(0, 8).map((x) => ({ ...who(x), sell_near: r(x.sell_near), buy_near: r(x.buy_near) })),
  };
}

/** What changed since the previous assessment. `material` = worth a new write-up. */
export async function changesSince(analysis, prevAi) {
  const cur = aiPacket(analysis);
  const trades = await tradesSince(analysis.token, prevAi.data_to_ts, analysis.data_to_ts);
  const diff = diffPackets(prevAi.snapshot, cur);
  // tokens moved by transfer change the picture even without a trade (and a snapshot from before the trails existed has none)
  const trailKey = (p) => JSON.stringify((p?.token_flows?.trails || []).map((t) => [t.source, t.summary]));
  const flowsMoved = trailKey(prevAi.snapshot) !== trailKey(cur);
  const material = trades.trades > 0 || diff.flags.added.length > 0 || diff.flags.removed.length > 0 || !!diff.creator || flowsMoved;
  return { cur, since: { from: { assessed_ts: prevAi.ts, data_to_ts: prevAi.data_to_ts }, to: { data_to_ts: analysis.data_to_ts }, trades, ...diff }, material };
}

const clean = (j) => ({
  summary: String(j.summary || '').slice(0, 1500), findings: (Array.isArray(j.findings) ? j.findings : []).map((x) => String(x).slice(0, 400)).slice(0, 8),
  risk_level: ['low', 'medium', 'high'].includes(j.risk_level) ? j.risk_level : 'medium', confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), conclusion: String(j.conclusion || '').slice(0, 1000),
  ...(Array.isArray(j.changes) ? { changes: j.changes.map((x) => String(x).slice(0, 400)).slice(0, 8) } : {}),
});
const ask = (system, user) => chatJSON({ system, user, model: config.ai.analysisModel, timeoutMs: config.ai.analysisTimeoutMs, attempts: 2, stream: true });

/**
 * Write (first run) or update (later runs) the assessment of `analysis`, which should be freshly built. With nothing new on chain since the
 * previous run, the model is not called and the previous assessment is kept (marked as checked). Returns the stored assessment.
 */
export async function assessWithAi(analysis) {
  const doc = await col('analyses').findOne({ _id: analysis.token }, { projection: { ai: 1 } });
  const prev = doc?.ai?.snapshot ? doc.ai : null;
  if (!prev) {
    const snapshot = aiPacket(analysis);
    const { json, model } = await ask(SYSTEM, JSON.stringify(snapshot));
    const ai = { ...clean(json), mode: 'initial', model, ts: Date.now(), data_to_ts: analysis.data_to_ts, for_built_ts: analysis.built_ts, snapshot };
    await col('analyses').updateOne({ _id: analysis.token }, { $set: { ai } }, { upsert: true });
    await saveRun(analysis.token, ai);
    return ai;
  }
  const { cur, since, material } = await changesSince(analysis, prev);
  if (!material) {
    await col('analyses').updateOne({ _id: analysis.token }, { $set: { 'ai.checked_ts': Date.now(), 'ai.checked_to_ts': analysis.data_to_ts } });
    return { ...prev, checked_ts: Date.now(), unchanged: true };
  }
  const now = { age_min: cur.age_min, flows: cur.flows, creator: cur.creator && { balance: cur.creator.balance, balance_share: cur.creator.balance_share, traded: cur.creator.traded }, holders: cur.holders, token_flows: cur.token_flows, flags: cur.flags };
  const packet = { previous: { ts: prev.ts, risk_level: prev.risk_level, confidence: prev.confidence, summary: prev.summary, findings: prev.findings, conclusion: prev.conclusion, changes: prev.changes }, since, now };
  const { json, model } = await ask(SYSTEM_UPDATE, JSON.stringify(packet));
  const ai = { ...clean(json), mode: 'update', model, ts: Date.now(), since_ts: prev.ts, since_data_to_ts: prev.data_to_ts, data_to_ts: analysis.data_to_ts, for_built_ts: analysis.built_ts,
    window: { trades: since.trades.trades, buy_near: since.trades.buy_near, sell_near: since.trades.sell_near }, previous_risk: prev.risk_level, snapshot: cur };
  await col('analyses').updateOne({ _id: analysis.token }, { $set: { ai } });
  await saveRun(analysis.token, ai, since);
  return ai;
}

// ---- every run, kept for good
const runId = (token, ts) => `${token}|${ts}`;
/** Store one run: the assessment, the evidence it was written from and, for an update, what changed since the previous run. */
export async function saveRun(token, ai, since = null) {
  const { checked_ts, checked_to_ts, unchanged, ...x } = ai;
  await col('analysis_runs').replaceOne({ _id: runId(token, ai.ts) }, { ...x, token, since: since || null }, { upsert: true });
}
/** One run with its evidence. */
export async function getRun(id) {
  const x = await col('analysis_runs').findOne({ _id: id });
  return x ? (({ _id, ...y }) => ({ id: _id, ...y }))(x) : null;
}
