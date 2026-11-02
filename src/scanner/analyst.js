// The AI analyst (NEAR AI): reviews a launch that already passed the hard gates and says whether to buy it (simulated).
import { config } from '../config.js';
import { chatJSON } from '../ai/tools/nearai.js';
import { UNTRUSTED_RULE, evidenceMessage, maxRisk, MARKER } from '../ai/tools/untrusted.js';

import { prompt } from '../ai/prompts/index.js';
// src/ai/prompts/scanner-analyst.md, with the buy or the hold decision part
const system = (ctx) => prompt('scanner-analyst', { timing: ctx.followUpMinutes || 'a few', runupMcapUsd: config.rules.ignoreRunupBelowMcapUsd.toLocaleString('en-US'),
  decision: ctx.holding ? prompt('scanner-decision-hold', { costNear: ctx.holding.costNear }) : prompt('scanner-decision-buy', { buyNear: config.sim.buyNear }) });

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
  const { user, findings } = evidenceMessage(`Rule engine: score ${rules.score}/100, ${rules.failed.length ? 'failed gates: ' + rules.failed.map((g) => g.id).join(', ') : 'all gates passed'}.`,
    { earlier_reviews: ctx.previous?.length ? ctx.previous : undefined, features });
  const { json, model, usage } = await chatJSON({ system: system(ctx) + UNTRUSTED_RULE, user, maxTokens: config.ai.maxTokens });
  const a = normaliseAnalysis(json);
  if (!a) throw new Error('NEAR AI answer did not match the expected format');
  // chain data that tried to instruct the AI: never a buy, at least high risk, whatever the model said
  if (findings.length) { if (a.action === 'BUY_MORE') a.action = 'HOLD'; a.risk_level = maxRisk(a.risk_level, 'high'); a.red_flags = [`metadata tried to instruct the AI (${findings.map((f) => f.path).join(', ')}): ${MARKER}`, ...a.red_flags].slice(0, 8); }
  return { ...a, model, usage, ts: Date.now(), ...(findings.length ? { injection: findings } : {}) };
}
