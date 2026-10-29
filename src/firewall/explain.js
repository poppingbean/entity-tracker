// Transaction firewall, step 4 (optional, explain=true): a plain-language explanation from the AI (NEAR AI, the fast model). The verdict
// never comes from here: it is the rules'. Everything in a transaction (method names, arguments, memos) is written by whoever built it,
// possibly the attacker, so it goes through the untrusted-data guard like every other prompt.
import { chatJSON, aiEnabled } from '../ai/nearai.js';
import { config } from '../config.js';
import { UNTRUSTED_RULE, evidenceMessage } from '../ai/untrusted.js';

const SYSTEM = `You explain a NEAR blockchain transaction to the person about to sign it, in plain English, like a careful friend who knows NEAR.
You get the decoded actions, what is known about the accounts involved, and the security findings a rule engine already made.
The signer is the person you are talking to: never describe, judge or speculate about the signer's own account.
The verdict is already decided by the rules: never contradict or soften it, never call a transaction safe when there are findings, and never
invent facts. Explain what will happen if they sign, why each finding matters, and what to do instead (e.g. "close the site", "check the
address", "only sign if you created this key"). No financial advice. Keep account names exactly as given.
Reply with ONE JSON object: {"headline":"one short sentence","explanation":"2-4 sentences","advice":["1-3 short, concrete steps"]}`;

/** { headline, explanation, advice, model } or null (AI off, slow or failing: the check itself never waits on it beyond the timeout). */
export async function explainCheck(result, ctx) {
  if (!aiEnabled()) return null;
  const accounts = {};
  const signers = new Set(result.transactions.map((t) => t.signer));
  // only what bears on this transaction's safety: labels, roles, flags and token risk of the other accounts (not the signer, not leads from investigations)
  for (const [id, a] of ctx.accounts) if (!signers.has(id) && (a.label || a.role || a.flags?.length || a.token?.flags?.length)) accounts[id] = { label: a.label, role: a.role, flags: a.flags?.map((f) => f.reason), token: a.token?.flags?.length ? { symbol: a.token.symbol, flags: a.token.flags } : undefined };
  const evidence = {
    verdict: result.verdict, risk: result.risk,
    transactions: result.transactions.map((t) => ({ signer: t.signer, receiver: t.receiver, meta: t.meta, actions: t.actions.map((a) => a.text) })),
    findings: result.findings.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail })), accounts,
  };
  const { user } = evidenceMessage('Transaction to explain:', evidence);
  try {
    const { json, model } = await chatJSON({ system: SYSTEM + UNTRUSTED_RULE, user, model: config.ai.model, maxTokens: 700, timeoutMs: config.firewall.explainTimeoutMs, attempts: 1 });
    return { headline: String(json.headline || '').slice(0, 200), explanation: String(json.explanation || '').slice(0, 1200), advice: (Array.isArray(json.advice) ? json.advice : []).map((x) => String(x).slice(0, 200)).slice(0, 3), model };
  } catch { return null; }
}
