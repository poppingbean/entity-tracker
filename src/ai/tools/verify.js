// Checks on what the AI says, against the evidence it was given: nothing it claims is taken on trust.
//   verifiedFindings    an audit finding is kept only when the method or string it cites really is in the contract
//   unverifiedAmounts   dollar amounts in an incident write-up that match nothing in the evidence (within 6 %, or a rounding to thousands)
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
