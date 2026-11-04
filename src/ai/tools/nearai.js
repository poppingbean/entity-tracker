// NEAR AI Cloud client (OpenAI-compatible chat completions). The AI is the analysis brain; everything it is shown is data the
// tracker collected on-chain, and everything it returns is validated before use.
import { config } from '../../config.js';

export const aiEnabled = () => !!config.ai.key;
// ok/error: can we reach NEAR AI (network, key, outages)? A single answer that could not be read (cut off, not JSON) is not an outage:
// it goes to lastBad and is counted, but leaves ok alone, so one long answer cannot paint the whole site as "NEAR AI error"
export const aiStatus = { ok: null, checkedTs: 0, error: null, model: config.ai.model, calls: 0, failures: 0, badAnswers: 0, lastBad: null, promptTokens: 0, completionTokens: 0 };

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

/** A streamed completion read to the end: the same shape as a non-streamed response body. */
async function readStream(res) {
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '', finish = null, usage = null, model = null;
  const line = (l) => {
    if (!l.startsWith('data:')) return;
    const d = l.slice(5).trim();
    if (!d || d === '[DONE]') return;
    let j; try { j = JSON.parse(d); } catch { return; }
    model = j.model || model; usage = j.usage || usage;
    const c = j.choices?.[0];
    if (c?.delta?.content) content += c.delta.content;
    if (c?.delta?.reasoning_content) reasoning += c.delta.reasoning_content;
    if (c?.finish_reason) finish = c.finish_reason;
  };
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
  }
  line(buf.trim());
  return { model, usage, choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: finish }] };
}

/**
 * One chat completion expected to return a JSON object. Retries on rate limits and server errors.
 * `stream` reads the answer as it is written: for long answers, since Node's fetch gives up when response headers take over 300 s.
 */
export async function chatJSON({ system, user, model = config.ai.model, maxTokens = config.ai.maxTokens, temperature = 0.2, timeoutMs = config.ai.timeoutMs, attempts = 3, stream = false }) {
  if (!aiEnabled()) throw new Error('NEAR_AI_API_KEY is not set');
  let lastErr, unreadable = false, budget = maxTokens;
  const ceiling = Math.min(16000, maxTokens * 4);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      aiStatus.calls++;
      const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ai.key}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, max_tokens: budget, response_format: { type: 'json_object' },
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) }),
      });
      if (!res.ok) { const raw = await res.text(); lastErr = new Error(`NEAR AI ${res.status}: ${redact(raw).slice(0, 300)}`); if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1) ** 2); continue; } throw lastErr; }
      const j = stream ? await readStream(res) : JSON.parse(await res.text());
      aiStatus.promptTokens += j.usage?.prompt_tokens || 0; aiStatus.completionTokens += j.usage?.completion_tokens || 0;
      const msg = j.choices?.[0]?.message || {};
      const parsed = extractJson(msg.content) || extractJson(msg.reasoning_content);
      if (!parsed || typeof parsed !== 'object') {
        const finish = j.choices?.[0]?.finish_reason;
        lastErr = new Error(`NEAR AI returned no JSON (finish_reason ${finish}${finish === 'length' ? `, max_tokens ${budget}` : ''})`); unreadable = true;
        // cut off before the JSON was complete: the same request would be cut off the same way, so the next one gets twice the room
        if (finish === 'length') budget = Math.min(ceiling, budget * 2);
        continue;
      }
      aiStatus.ok = true; aiStatus.error = null; aiStatus.checkedTs = Date.now();
      return { json: parsed, model: j.model || model, usage: j.usage || null };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`NEAR AI timed out after ${timeoutMs / 1000}s`) : e; unreadable = false;
      if (/NEAR AI 4\d\d/.test(lastErr.message) && !/429/.test(lastErr.message)) break; // auth / request errors will not improve on retry
    } finally { clearTimeout(timer); }
  }
  if (unreadable) { aiStatus.badAnswers++; aiStatus.lastBad = { error: redact(lastErr.message), ts: Date.now() }; } // reachable, the answer was the problem
  else { aiStatus.failures++; aiStatus.ok = false; aiStatus.error = redact(lastErr?.message || 'unknown error'); aiStatus.checkedTs = Date.now(); }
  throw lastErr;
}

/** Cheap health check: asks for a tiny JSON object. */
export async function checkAi() {
  if (!aiEnabled()) { aiStatus.ok = null; aiStatus.error = 'NEAR_AI_API_KEY not set'; return aiStatus; }
  try { await chatJSON({ system: 'Reply with a JSON object only.', user: 'Return {"ok": true}.', maxTokens: 400 }); } catch {}
  return aiStatus;
}
