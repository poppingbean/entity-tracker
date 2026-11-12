// NEAR AI Cloud client (OpenAI-compatible chat completions). The AI is the analysis brain; everything it is shown is data the
// tracker collected on-chain, and everything it returns is validated before use.
import { config } from '../../config.js';

export const aiEnabled = () => config.ai.keys.length > 0;

/**
 * The key pool. NEAR_AI_API_KEY may hold several keys (';' or ','). A key that is out of credits, over its quota or refused (401 / 402 / 403,
 * or a 429 that says credits or quota) is set aside for a while and the next key is used; the call itself does not fail while another
 * key is left. With a single key nothing is set aside (the next call simply tries again, as before). Keys are never logged: only their
 * position in the list.
 */
const parked = new Map(); // key -> parked until (ms)
const PARK_MS = { credits: 30 * 60e3, refused: 3600e3 };
/** Why a failed response means the KEY is the problem (not the request): 'credits', 'refused', or null. Pure. */
export function keyProblem(status, body = '') {
  const b = String(body).toLowerCase();
  if (status === 402 || /insufficient|out of credit|no credit|credit balance|balance is|billing|payment required|quota/.test(b)) return 'credits';
  if (status === 401 || status === 403) return 'refused';
  return null;
}
/** The first key that is not set aside, or null when every key is. Pure (given the pool). */
export function pickKey(keys, parkedUntil = parked, now = Date.now()) { return keys.find((k) => !((parkedUntil.get(k) || 0) > now)) || null; }
const keyNo = (k) => config.ai.keys.indexOf(k) + 1;
// ok/error: can we reach NEAR AI (network, key, outages)? A single answer that could not be read (cut off, not JSON) is not an outage:
// it goes to lastBad and is counted, but leaves ok alone, so one long answer cannot paint the whole site as "NEAR AI error"
export const aiStatus = { ok: null, checkedTs: 0, error: null, model: config.ai.model, calls: 0, failures: 0, badAnswers: 0, lastBad: null, promptTokens: 0, completionTokens: 0, keys: config.ai.keys.length, keysSetAside: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => config.ai.keys.reduce((t, k) => t.split(k).join('[key]'), String(s));

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
  let lastErr, unreadable = false, budget = maxTokens, switches = 0;
  const ceiling = Math.min(16000, maxTokens * 4);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = pickKey(config.ai.keys);
    if (!key) { lastErr = new Error(`${lastErr ? lastErr.message + ' · ' : 'NEAR AI: '}every key (${config.ai.keys.length}) is out of credits or refused right now`); break; }
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      aiStatus.calls++;
      const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature, max_tokens: budget, response_format: { type: 'json_object' },
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) }),
      });
      if (!res.ok) {
        const raw = await res.text(); lastErr = new Error(`NEAR AI ${res.status}: ${redact(raw).slice(0, 300)}`);
        const why = keyProblem(res.status, raw);
        if (why && config.ai.keys.length > 1) {
          // this key is the problem: set it aside and go on with the next one, without spending an attempt (at most once per key)
          parked.set(key, Date.now() + PARK_MS[why]);
          aiStatus.keysSetAside = config.ai.keys.map((k, i) => ((parked.get(k) || 0) > Date.now() ? { key: i + 1, why: k === key ? why : undefined, until: new Date(parked.get(k)).toISOString() } : null)).filter(Boolean);
          console.warn(`NEAR AI key #${keyNo(key)} of ${config.ai.keys.length}: ${why === 'credits' ? 'out of credits or quota' : 'refused'} (${res.status}); set aside for ${PARK_MS[why] / 3600e3} h`);
          if (switches++ < config.ai.keys.length) { attempt--; continue; }
        }
        if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1) ** 2); continue; }
        throw lastErr;
      }
      const j = stream ? await readStream(res) : JSON.parse(await res.text());
      aiStatus.promptTokens += j.usage?.prompt_tokens || 0; aiStatus.completionTokens += j.usage?.completion_tokens || 0;
      // tokens per UTC day: the Academy's business books them as its AI cost (never fails the call)
      import('../../academy/business.js').then((m) => m.countTokens(j.usage)).catch(() => {});
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
