// Checks on what the AI says, against the evidence it was given: nothing it claims is taken on trust.
//   verifiedFindings    an audit finding is kept only when the method or string it cites really is in the contract
//   unverifiedAmounts   dollar amounts in an incident write-up that match nothing in the evidence (within 6 %, or a rounding to thousands)
//   groundingReport     accounts and quantities in any write-up that the evidence does not have (accountsIn, unverifiedAccounts, unverifiedNumbers)
import { SEV } from '../../audit/powers.js';

/** Keep only AI findings whose evidence (a method or a string) is really in the contract; severities capped at high (rules decide critical). */
export function verifiedFindings(items, { exports = [], strings = [], sourceText = '' } = {}) {
  const ex = new Set(exports), hay = strings.join('\n') + '\n' + sourceText;
  return (Array.isArray(items) ? items : []).map((x) => ({ severity: SEV.includes(x?.severity) ? x.severity : 'medium', title: String(x?.title || '').slice(0, 140), detail: String(x?.detail || '').slice(0, 600), evidence: String(x?.evidence || '').slice(0, 120) }))
    .filter((x) => x.title && x.evidence && (ex.has(x.evidence) || (x.evidence.length >= 6 && hay.includes(x.evidence))))
    .map((x) => ({ ...x, severity: x.severity === 'critical' ? 'high' : x.severity, key: 'ai_finding', ai: true }));
}

/** Every number a write-up may quote: those in the evidence (and their roundings). */
function knownNumbers(p) {
  const out = [];
  JSON.stringify(p).replace(/-?\d+(\.\d+)?/g, (m) => { const x = Math.abs(Number(m)); if (x >= 100) out.push(x); return m; });
  // totals the model may reasonably add up: per-kind exit sums and per-victim sums
  const exits = p.exits || []; out.push(exits.reduce((s, e) => s + (e.usd || 0), 0));
  return out;
}
/** Dollar figures in the write-up that match nothing in the evidence (within 6 % or a rounding to thousands). */
export function unverifiedAmounts(report, p) {
  const known = knownNumbers(p), text = JSON.stringify(report);
  const bad = [];
  for (const m of text.matchAll(/\$\s?(\d(?:[\d,]*\d)?(?:\.\d+)?)(?:\s?(k|K|thousand|m|M|million)\b)?/g)) {
    let x = Number(m[1].replace(/,/g, '')); const u = (m[2] || '').toLowerCase();
    if (u === 'k' || u === 'thousand') x *= 1e3; else if (u === 'm' || u === 'million') x *= 1e6;
    if (x < 100) continue;
    if (!known.some((k) => Math.abs(k - x) <= Math.max(0.06 * k, u ? 600 : 1))) bad.push(m[0]);
  }
  return bad;
}

// ---- grounding: every account and number a write-up quotes must be in the evidence it was given

const HEX64 = /\b[0-9a-f]{64}\b/g, HEX8 = /\b([0-9a-f]{8})(?:…|\.\.\.)/g, NAMED = /\b[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:near|tg)\b/g;
/** Every NEAR account-like string in a text: `name.near`, `name.tg`, sub-accounts, 64-hex implicit ids, and `first 8 hex + …`. Lower-cased, unique. */
export function accountsIn(text) {
  const t = String(typeof text === 'string' ? text : JSON.stringify(text ?? '')).toLowerCase(), out = new Set();
  for (const m of t.matchAll(HEX64)) out.add(m[0]);
  for (const m of t.matchAll(HEX8)) out.add(m[1] + '…');
  for (const m of t.replace(HEX64, ' ').matchAll(NAMED)) out.add(m[0]);
  return [...out];
}
/** Accounts in the output that appear nowhere in the evidence (a shortened id matches any evidence id with that prefix; `allow` lists accounts that may always be named). */
export function unverifiedAccounts(output, evidence, { allow = [] } = {}) {
  const hay = JSON.stringify(evidence ?? '').toLowerCase(), ok = new Set(allow.map((a) => String(a).toLowerCase()));
  return accountsIn(output).filter((a) => !(ok.has(a) || (a.endsWith('…') ? hay.includes(a.slice(0, -1)) : hay.includes(a))));
}

const MAG = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
/** Every number in the evidence, including ones written as `12.4M` or `$51k` in its text (the model may quote either form). */
function evidenceNumbers(evidence) {
  const s = JSON.stringify(evidence ?? ''), out = [];
  s.replace(/-?\d+(?:\.\d+)?/g, (m) => { out.push(Math.abs(Number(m))); return m; });
  s.replace(/(\d+(?:\.\d+)?)\s?(k|thousand|m|million|b|billion)\b/gi, (_, n, u) => { out.push(Number(n) * MAG[u.toLowerCase()]); return _; });
  const exits = (evidence && evidence.exits) || []; if (exits.length) out.push(exits.reduce((a, e) => a + (e.usd || 0), 0));
  return out;
}
const UNIT = /(\d(?:[\d,]*\d)?(?:\.\d+)?)\s?(k|K|thousand|m|M|million|b|B|billion)?\s?(NEAR\b|N\b|%|x\b)/g;
/**
 * Quantities with a unit (NEAR, N, %, x) in the output that match nothing in the evidence, within 6 %. A percentage matches a fraction
 * (`5%` ↔ `0.05`) or the same percent; amounts under `minValue` (and % under 1, x under 2) are too small to check.
 */
export function unverifiedNumbers(output, evidence, { minValue = 100 } = {}) {
  const known = evidenceNumbers(evidence), text = JSON.stringify(output ?? ''), bad = [];
  for (const m of text.matchAll(UNIT)) {
    const unit = m[3].replace(/\b/, ''); let x = Number(m[1].replace(/,/g, '')); const mag = m[2] ? MAG[m[2].toLowerCase()] : 1; x *= mag;
    if (unit === '%') { if (x < 1) continue; if (!known.some((k) => Math.abs(k - x) <= Math.max(0.06 * x, 0.5) || Math.abs(k * 100 - x) <= Math.max(0.06 * x, 0.5))) bad.push(m[0]); continue; }
    if (unit === 'x') { if (x < 2) continue; } else if (x < minValue) continue;
    if (!known.some((k) => Math.abs(k - x) <= Math.max(0.06 * k, mag > 1 ? 600 : 1))) bad.push(m[0]);
  }
  return bad;
}

/** One verdict on a write-up: `{ ok, accounts, amounts }` (`amounts` = dollar figures and quantities with a unit that the evidence does not have). */
export function groundingReport(output, evidence, { allow = [] } = {}) {
  const accounts = unverifiedAccounts(output, evidence, { allow }), amounts = [...unverifiedAmounts(output, evidence), ...unverifiedNumbers(output, evidence)];
  return { ok: !accounts.length && !amounts.length, accounts, amounts };
}
