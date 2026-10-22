// NEAR AI Cloud client (OpenAI-compatible chat completions). The AI is the analysis brain; everything it is shown is data the
// tracker collected on-chain, and everything it returns is validated before use.
import { config } from '../config.js';

export const aiEnabled = () => !!config.ai.key;
export const aiStatus = { ok: null, checkedTs: 0, error: null, model: config.ai.model, calls: 0, failures: 0, promptTokens: 0, completionTokens: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => String(s).split(config.ai.key || '\u0000').join('[key]');

/** Pull a JSON object out of a model reply (plain, fenced, or surrounded by prose). */
export function extractJson(text) {
  if (!text) return null;
  const t = String(text).trim();
  try { return JSON.parse(t); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

/** One chat completion expected to return a JSON object. Retries on rate limits and server errors. */
export async function chatJSON({ system, user, maxTokens = config.ai.maxTokens, temperature = 0.2, timeoutMs = config.ai.timeoutMs, attempts = 3 }) {
  if (!aiEnabled()) throw new Error('NEAR_AI_API_KEY is not set');
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      aiStatus.calls++;
      const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ai.key}` },
        body: JSON.stringify({ model: config.ai.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, max_tokens: maxTokens, response_format: { type: 'json_object' } }),
      });
      const raw = await res.text();
      if (!res.ok) { lastErr = new Error(`NEAR AI ${res.status}: ${redact(raw).slice(0, 300)}`); if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1) ** 2); continue; } throw lastErr; }
      const j = JSON.parse(raw);
      aiStatus.promptTokens += j.usage?.prompt_tokens || 0; aiStatus.completionTokens += j.usage?.completion_tokens || 0;
      const msg = j.choices?.[0]?.message || {};
      const parsed = extractJson(msg.content) || extractJson(msg.reasoning_content);
      if (!parsed || typeof parsed !== 'object') { lastErr = new Error(`NEAR AI returned no JSON (finish_reason ${j.choices?.[0]?.finish_reason})`); continue; }
      aiStatus.ok = true; aiStatus.error = null; aiStatus.checkedTs = Date.now();
      return { json: parsed, model: j.model || config.ai.model, usage: j.usage || null };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`NEAR AI timed out after ${timeoutMs / 1000}s`) : e;
      if (/NEAR AI 4\d\d/.test(lastErr.message) && !/429/.test(lastErr.message)) break; // auth / request errors will not improve on retry
    } finally { clearTimeout(timer); }
  }
  aiStatus.failures++; aiStatus.ok = false; aiStatus.error = redact(lastErr?.message || 'unknown error'); aiStatus.checkedTs = Date.now();
  throw lastErr;
}

/** Cheap health check: asks for a tiny JSON object. */
export async function checkAi() {
  if (!aiEnabled()) { aiStatus.ok = null; aiStatus.error = 'NEAR_AI_API_KEY not set'; return aiStatus; }
  try { await chatJSON({ system: 'Reply with a JSON object only.', user: 'Return {"ok": true}.', maxTokens: 400 }); } catch {}
  return aiStatus;
}
