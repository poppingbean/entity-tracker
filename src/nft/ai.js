// The AI analyst's assessment of an NFT collection (Claude Sonnet 5.5 served by NEAR AI, like the token analysis). Run only on request:
// the first run writes the assessment from the whole analysis; later runs update it from what changed since the previous run.
// Latest in nft_analyses.ai (with its evidence snapshot); every run kept in analysis_runs (see analysis/ai.js saveRun).
import { col } from '../db.js';
import { chatJSON } from '../ai/tools/nearai.js';
import { grounded } from '../ai/tools/grounding.js';
import { config } from '../config.js';
import { UNTRUSTED_RULE, evidenceMessage, maxRisk, riskFloor } from '../ai/tools/untrusted.js';
import { saveRun } from '../analysis/ai.js';


import { prompt } from '../ai/prompts/index.js';
const SYSTEM = prompt('nft-analyst'); // src/ai/prompts/nft-analyst.md (+ nft-analyst-common.md)
const SYSTEM_UPDATE = prompt('nft-analyst-update');

const short = (s) => (typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) ? s.slice(0, 8) + '…' : s);
const sh = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'string' ? short(v) : v)));

/** The evidence packet (also the snapshot the next update is compared with). */
export function nftPacket(a) {
  return sh({
    collection: a.collection, info: a.info, mint: { ...a.mint, top_minters: a.mint.top_minters.slice(0, 10) }, team: { ...a.team, minters: a.team.minters.slice(0, 10) },
    minter_groups: { ...a.minter_groups, groups: a.minter_groups.groups.slice(0, 8).map(({ members, ...g }) => g) },
    market: { ...a.market, top_buyers: a.market.top_buyers.slice(0, 6), top_sellers: a.market.top_sellers.slice(0, 6), wash: { ...a.market.wash, rows: a.market.wash.rows.slice(0, 8) } },
    holders: { ...a.holders, top: a.holders.top.slice(0, 10) }, flags: a.flags, data_to_ts: a.data_to_ts,
  });
}

/** What changed between the previous run's data and now. */
async function sinceFor(a, prev) {
  const ev = await col('nft_events').find({ collection: a.collection, ts: { $gt: prev.data_to_ts ?? 0 } }, { projection: { kind: 1, count: 1, pay_near: 1, to: 1, from: 1, price_near: 1 } }).toArray();
  const k = (x) => ev.filter((e) => e.kind === x);
  const sales = k('sale'), mints = k('mint');
  const by = (list, f) => { const m = new Map(); for (const e of list) m.set(f(e), (m.get(f(e)) || 0) + (e.pay_near || 0)); return [...m].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([w, near]) => ({ wallet: short(w), near: Math.round(near * 100) / 100 })); };
  const ph = new Set((prev.snapshot.holders?.top || []).map((h) => h.wallet)), ch = new Set((nftPacket(a).holders.top || []).map((h) => h.wallet));
  const pf = new Set((prev.snapshot.flags || []).map((f) => f.text)), cf = new Set(a.flags.map((f) => f.text));
  return {
    from: { assessed_ts: prev.ts, data_to_ts: prev.data_to_ts }, events: ev.length,
    mints: { tokens: mints.reduce((s, e) => s + e.count, 0), near: Math.round(mints.reduce((s, e) => s + (e.pay_near || 0), 0)) },
    sales: { tokens: sales.reduce((s, e) => s + e.count, 0), near: Math.round(sales.reduce((s, e) => s + (e.pay_near || 0), 0)), top_buyers: by(sales, (e) => e.to), top_sellers: by(sales, (e) => e.from) },
    wash: { was: prev.snapshot.market?.wash?.sales ?? 0, now: a.market.wash.sales },
    floor_7d: { was: prev.snapshot.market?.floor_7d ?? null, now: a.market.floor_7d },
    holders: { entered: [...ch].filter((w) => !ph.has(w)), left: [...ph].filter((w) => !ch.has(w)), top10_share: { was: prev.snapshot.holders?.top10_share ?? null, now: a.holders.top10_share } },
    flags: { added: a.flags.filter((f) => !pf.has(f.text)), removed: (prev.snapshot.flags || []).filter((f) => !cf.has(f.text)) },
  };
}

const clean = (j) => ({
  summary: String(j.summary || '').slice(0, 1500), findings: (Array.isArray(j.findings) ? j.findings : []).map((x) => String(x).slice(0, 400)).slice(0, 8),
  risk_level: ['low', 'medium', 'high'].includes(j.risk_level) ? j.risk_level : 'medium', confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), conclusion: String(j.conclusion || '').slice(0, 1000),
  ...(Array.isArray(j.changes) ? { changes: j.changes.map((x) => String(x).slice(0, 400)).slice(0, 8) } : {}),
});
/** Ask the model with the evidence cleaned and wrapped as untrusted data; the risk level can only go up from the rule-based flags. */
async function ask(system, preamble, evidence, flags) {
  const { user, findings } = evidenceMessage(preamble, evidence, { trusted: ['previous'] });
  const { json, model, unverified } = await grounded({ path: 'nft', evidence, run: (extra) => chatJSON({ system: system + UNTRUSTED_RULE, user: user + extra, model: config.ai.analysisModel, timeoutMs: config.ai.analysisTimeoutMs, attempts: 2, stream: true }) });
  const floor = maxRisk(riskFloor(flags), findings.length ? 'high' : 'low');
  const raised = ['low', 'medium', 'high'].indexOf(floor) > ['low', 'medium', 'high'].indexOf(json?.risk_level);
  return { json: { ...json, risk_level: raised ? floor : json?.risk_level }, model, unverified, guard: { floor, raised, ...(findings.length ? { injection: findings } : {}) } };
}

/** Write (first run) or update (later runs) the assessment of a freshly built NFT analysis; no model call when nothing happened. */
export async function assessNftWithAi(a) {
  const doc = await col('nft_analyses').findOne({ _id: a.collection }, { projection: { ai: 1 } });
  const prev = doc?.ai?.snapshot ? doc.ai : null;
  const snapshot = nftPacket(a);
  if (!prev) {
    const { json, model, guard, unverified } = await ask(SYSTEM, 'Evidence packet for this NFT collection:', snapshot, a.flags);
    const ai = { ...clean(json), guard, ...(unverified ? { unverified } : {}), mode: 'initial', model, ts: Date.now(), data_to_ts: a.data_to_ts, for_built_ts: a.built_ts, snapshot };
    await col('nft_analyses').updateOne({ _id: a.collection }, { $set: { ai } }, { upsert: true });
    await saveRun(a.collection, ai);
    return ai;
  }
  const since = await sinceFor(a, prev);
  if (!since.events && !since.flags.added.length && !since.flags.removed.length) {
    await col('nft_analyses').updateOne({ _id: a.collection }, { $set: { 'ai.checked_ts': Date.now() } });
    return { ...prev, checked_ts: Date.now(), unchanged: true };
  }
  const now = { info: snapshot.info, mint: { minted: snapshot.mint.minted, raised_near: snapshot.mint.raised_near }, market: { sales: snapshot.market.sales, volume_near: snapshot.market.volume_near, floor_7d: snapshot.market.floor_7d, wash: { sales: snapshot.market.wash.sales, share: snapshot.market.wash.share } }, holders: snapshot.holders, flags: snapshot.flags };
  const { json, model, guard, unverified } = await ask(SYSTEM_UPDATE, 'Previous assessment, what changed since, and the current state:', { previous: { ts: prev.ts, risk_level: prev.risk_level, summary: prev.summary, findings: prev.findings, conclusion: prev.conclusion }, since, now }, a.flags);
  const ai = { ...clean(json), guard, ...(unverified ? { unverified } : {}), mode: 'update', model, ts: Date.now(), since_ts: prev.ts, data_to_ts: a.data_to_ts, for_built_ts: a.built_ts, previous_risk: prev.risk_level,
    window: { trades: since.events, buy_near: since.sales.near, sell_near: since.sales.near }, snapshot };
  await col('nft_analyses').updateOne({ _id: a.collection }, { $set: { ai } });
  await saveRun(a.collection, ai, since);
  return ai;
}
