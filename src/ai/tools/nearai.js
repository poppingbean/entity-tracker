// NEAR AI Cloud client (OpenAI-compatible chat completions). The AI is the analysis brain; everything it is shown is data the
// tracker collected on-chain, and everything it returns is validated before use.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../config.js';

export const aiEnabled = () => config.ai.keys.length > 0 || !!config.ai.operatorDir;

/** Thrown in operator mode when a request has no answer yet: it was written to <dir>/requests for the operator. */
export class QueuedForOperator extends Error { constructor(key) { super(`queued for the operator (${key})`); this.queued = true; this.key = key; } }
/** The file name of a request: the same prompt always gets the same name, so a second run finds its answer. Pure. */
export const operatorKey = (system, user) => createHash('sha1').update(`${system}
---
${user}`).digest('hex').slice(0, 20);
/**
 * The item a command is working on (cli.js operator-ai sets it: { kind, id }). Live evidence changes between two runs (a USD value moves with the
 * price), so a request about a known item is named after the item and the kind of question (a hash of the system prompt), not the whole prompt.
 */
export const operatorSubject = new AsyncLocalStorage();
const ANSWER_MAX_AGE_MS = 2 * 86400e3; // an item asked again days later (a group's weekly review) gets a new request, not last week's answer
/** The name of a request about one item. Pure. */
export const subjectKey = (kind, id, system) => `${String(kind).replace(/[^a-z0-9_-]/gi, '')}-${String(id).replace(/[^a-z0-9._-]/gi, '_').slice(0, 90)}-${createHash('sha1').update(String(system)).digest('hex').slice(0, 6)}`;
/** Operator mode: the answer from <dir>/answers/<key>.json, or the request written to <dir>/requests/<key>.json and QueuedForOperator. */
function operatorAnswer({ system, user, model, maxTokens }) {
  const sub = operatorSubject.getStore();
  const dir = config.ai.operatorDir, key = sub?.id ? subjectKey(sub.kind, sub.id, system) : operatorKey(system, user);
  const ans = path.join(dir, 'answers', `${key}.json`);
  if (fs.existsSync(ans) && (!sub?.id || Date.now() - fs.statSync(ans).mtimeMs < ANSWER_MAX_AGE_MS)) {
    const json = extractJson(fs.readFileSync(ans, 'utf8'));
    if (!json || typeof json !== 'object') throw new Error(`operator answer ${key} is not a JSON object`);
    // the same guard as a NEAR AI answer: stand-in list items dropped, a field with nothing real in it refused (the save step names it, the file is fixed)
    const { json: clean, holes } = placeholdersOut(json);
    if (holes.length) throw new Error(`operator answer ${key} has placeholders instead of content (${holes.slice(0, 3).join(', ')})`);
    // NEAR_AI_OPERATOR_MODEL: the model that actually wrote the answer (e.g. anthropic/claude-opus-5-5), recorded as is, like a NEAR AI answer's model
    return { json: clean, model: config.ai.operatorModel === 'operator' ? `operator, for ${model}` : config.ai.operatorModel, usage: null };
  }
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'requests', `${key}.json`), JSON.stringify({ key, ts: Date.now(), ...(sub?.id ? { subject: { kind: sub.kind, id: sub.id } } : {}), model, max_tokens: maxTokens, system, user }, null, 1));
  throw new QueuedForOperator(key);
}

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

// ---- answer guards (2026-11-25: one model filled a verdict's reasons with "..." and called a case a hack with high confidence; its thinking used up
// max_tokens before the answer was written, so answers were cut off even after the room was doubled)

// a stand-in instead of content: "...", "…", "TBD", "<reason>", "[explanation]" …
const PLACEHOLDER = /^\s*(\.{2,}|…+|-{2,}|_{2,}|\?{2,}|n\/?a|tbd|todo|placeholder|lorem ipsum.*|<[^<>]{0,40}>|\[[^[\]]{0,40}\]|\{[^{}]{0,40}\})\s*$/i;
const filler = (v) => typeof v === 'string' && (!v.trim() || PLACEHOLDER.test(v));
/**
 * Placeholders out of an answer. A list loses its stand-in items (the prompts show lists as ["step 1", "step 2", "..."], and a model may copy the
 * "..."); a field with nothing real left in it is a hole: a string that is only a stand-in, or a list that held only stand-ins (["..."]).
 * (An empty string in a field may mean "nothing to say", so it is not a hole.) Returns { json, holes }: the cleaned answer and the hole paths. Pure.
 */
export function placeholdersOut(json, path = '', holes = []) {
  if (Array.isArray(json)) {
    const kept = json.filter((v) => !filler(v)).map((v, i) => placeholdersOut(v, `${path}[${i}]`, holes).json);
    if (json.length && !kept.length) holes.push(path || '(answer)');
    return { json: kept, holes };
  }
  if (json && typeof json === 'object') return { json: Object.fromEntries(Object.entries(json).map(([k, v]) => [k, placeholdersOut(v, path ? `${path}.${k}` : k, holes).json])), holes };
  if (typeof json === 'string' && json.trim() && PLACEHOLDER.test(json)) holes.push(path || '(answer)');
  return { json, holes };
}

// models seen thinking before they answer (their reasoning counts against max_tokens): they start with more room, and a cut-off answer goes
// straight to the ceiling. Learned per process from the answers themselves; a larger max_tokens costs nothing unless the model uses it.
const THINKERS = new Set();
export const THINK_ROOM = 3;
/** Did this answer spend tokens thinking? Reasoning returned, reasoning tokens counted, or far more tokens billed than the answer holds. Pure. */
export function thoughtFirst(usage, content = '', reasoning = '') {
  if (reasoning && String(reasoning).trim()) return true;
  if ((usage?.completion_tokens_details?.reasoning_tokens || 0) > 0) return true;
  const billed = usage?.completion_tokens || 0, shown = Math.ceil(String(content || '').length / 4); // about 4 characters a token
  return billed > 400 && billed > 3 * shown + 200;
}
/** The room for the first try: more for a model seen thinking. Pure (given the set). */
export const firstBudget = (model, maxTokens, ceiling, thinkers = THINKERS) => (thinkers.has(model) ? Math.min(ceiling, maxTokens * THINK_ROOM) : maxTokens);

/**
 * One chat completion expected to return a JSON object. Retries on rate limits and server errors.
 * `stream` reads the answer as it is written: for long answers, since Node's fetch gives up when response headers take over 300 s.
 * An answer with placeholders instead of content counts as unreadable (retried, never returned).
 */
export async function chatJSON({ system, user, model = config.ai.model, maxTokens = config.ai.maxTokens, temperature = 0.2, timeoutMs = config.ai.timeoutMs, attempts = 3, stream = false }) {
  if (config.ai.operatorDir) return operatorAnswer({ system, user, model, maxTokens });
  if (!aiEnabled()) throw new Error('NEAR_AI_API_KEY is not set');
  const ceiling = Math.min(16000, maxTokens * 4);
  let lastErr, unreadable = false, budget = firstBudget(model, maxTokens, ceiling), switches = 0;
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
      const thinks = thoughtFirst(j.usage, msg.content, msg.reasoning_content);
      if (thinks) THINKERS.add(model);
      const parsed = extractJson(msg.content) || extractJson(msg.reasoning_content);
      if (!parsed || typeof parsed !== 'object') {
        const finish = j.choices?.[0]?.finish_reason;
        lastErr = new Error(`NEAR AI returned no JSON (finish_reason ${finish}${finish === 'length' ? `, max_tokens ${budget}` : ''})`); unreadable = true;
        // cut off before the JSON was complete: the same request would be cut off the same way, so the next one gets twice the room, and a model
        // that spent the room thinking gets the most there is (doubling once was not enough: the thinking grows with the room)
        if (finish === 'length') budget = thinks ? ceiling : Math.min(ceiling, budget * 2);
        continue;
      }
      const { json: clean, holes } = placeholdersOut(parsed);
      if (holes.length) {
        // "reasons": ["..."] is not an answer: it must never reach a verdict, a page or an alert
        lastErr = new Error(`NEAR AI answered with placeholders instead of content (${holes.slice(0, 3).join(', ')}${holes.length > 3 ? ` and ${holes.length - 3} more` : ''})`); unreadable = true;
        continue;
      }
      aiStatus.ok = true; aiStatus.error = null; aiStatus.checkedTs = Date.now();
      return { json: clean, model: j.model || model, usage: j.usage || null };
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
