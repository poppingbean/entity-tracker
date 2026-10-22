// Public deployments must not teach a rugger what is checked: thresholds, rule names, reasons and scoring weights are removed from
// every API response before it leaves the server; a failed gate keeps only its code (e.g. min_buyers), never the condition to pass it (the data itself - prices, trades, wallets, links on chain, tags, scores - stays).
// Applied when the dashboard is public (hosted without DASHBOARD_PASSWORD) or HIDE_CRITERIA=1; with a password, or locally, everything is shown.

// group labels fall back to the first rule tag when the AI has not named the group: those are rule names
const RULE_TAGS = new Set(['insider', 'rug-farmer', 'sybil-sniper', 'smart-early', 'consistent-loser', 'single-wallet', 'creator-rug', 'token-creator']);
const label = (x) => (x && x.label && RULE_TAGS.has(x.label) ? { ...x, label: null } : x);
const HIDDEN_METRICS = ['fresh_share', 'sync_share', 'first_movers_share', 'avg_delay_s', 'creator_linked_share', 'creator_linked_tokens', 'win_rate_in_rugs', 'pnl_in_rugs'];
const exitFlag = (o) => !!o && (o === true || (typeof o === 'object' && o.share >= 0.8));

/** Token outcome without the rug rule that fired, its reason or the creator-exit numbers. */
export function outcome(o) {
  if (!o) return o;
  const x = { ...o };
  x.creator_exit = exitFlag(o.creator_exit) ? true : null;
  delete x.rug_kinds; delete x.rug_reason;
  return x;
}
/** Failed gates as their codes only: the reason text holds the threshold. */
const gateIds = (failed) => (failed || []).map((g) => ({ id: g?.id ?? g }));
/** A scan summary with the failed gate codes but without their reasons or the decision text. */
export function scanBrief(s) {
  if (!s) return s;
  const { failed, decision, ...rest } = s;
  return { ...rest, ...(failed ? { failed: gateIds(failed) } : {}), ...(decision !== undefined ? { decision: s.pass === false ? 'did not pass the checks' : s.pass ? 'passed the checks' : null } : {}) };
}
const aiBrief = (a) => (a ? { label: a.label, verdict: a.verdict, confidence: a.confidence, follow_advice: a.follow_advice, action: a.action, risk_level: a.risk_level, quality_score: a.quality_score, model: a.model, ts: a.ts } : a);
const blBrief = (b) => (b ? { ts: b.ts, token: b.token, symbol: b.symbol } : b);
const tokensBrief = (list) => (list || []).map(({ kinds, ...t }) => t);
const metricsBrief = (m) => { if (!m) return m; const x = { ...m }; for (const k of HIDDEN_METRICS) delete x[k]; return x; };
const auditSummary = (a) => (a && a.available ? { ...a, findings: (a.findings || []).map(({ weight, ...f }) => f), confirmed_malicious: (a.confirmed_malicious || []).map(({ detail, ...c }) => c) } : a);
const creatorRisk = (c) => (c ? { launches: c.launches, rugged: c.rugged, blacklisted: !!c.blacklisted } : c);
const creatorInfo = (c) => (c ? { ...c, blacklisted: blBrief(c.blacklisted), tokens: tokensBrief(c.tokens) } : c);
const clusterBase = (c) => {
  const { rule, ai, ai_print, links, ...rest } = c;
  const out = { ...rest, ai: aiBrief(ai), metrics: metricsBrief(c.metrics) };
  if (links) out.links_n = links.length;
  if (out.creators) out.creators = out.creators.map((x) => ({ ...x, blacklisted: x.blacklisted ? { ts: x.blacklisted.ts, token: x.blacklisted.token, symbol: x.blacklisted.symbol } : null, tokens: tokensBrief(x.tokens) }));
  return out;
};
const failedOnly = (rows) => (rows || []).map((s) => { const { failed, decision, features, ...r } = s; return { ...r, failed: gateIds(failed), ai: aiBrief(r.ai) }; });

/** Remove the criteria from the JSON a route returned. `path` is the API path (u.pathname). Returns the data to send. */
export function redact(path, d) {
  if (!d || typeof d !== 'object' || d.error) return d;
  switch (path) {
    case '/api/token': {
      const { rug, scanner, ...x } = d; // scanner = the imported scanner evaluation (gate ids)
      return { ...x, outcome: outcome(x.outcome), scan: scanBrief(x.scan), audit: auditSummary(x.audit), creator_info: creatorInfo(x.creator_info), entries: (x.entries || []).map((e) => (e.cluster ? { ...e, cluster: label(e.cluster) } : e)) };
    }
    case '/api/tokens': return { ...d, rows: d.rows.map(({ rug, scanner, ...t }) => ({ ...t, outcome: outcome(t.outcome), scan: scanBrief(t.scan), creator_risk: creatorRisk(t.creator_risk), groups: (t.groups || []).map(label) })) };
    case '/api/signals': return { ...d, rows: d.rows.map((s) => ({ ...s, outcome: outcome(s.outcome), groups: (s.groups || []).map(label) })) };
    case '/api/monitor': return { ...d, rows: d.rows.map((t) => ({ ...t, scan: scanBrief(t.scan) })) };
    case '/api/creators': return { ...d, rows: d.rows.map((c) => ({ ...c, blacklisted: blBrief(c.blacklisted), tokens: tokensBrief(c.tokens) })) };
    case '/api/creator': return { ...d, groups: (d.groups || []).map(label), blacklisted: blBrief(d.blacklisted), tokens: (d.tokens || []).map(({ rug, ...t }) => ({ ...t, outcome: outcome(t.outcome) })) };
    case '/api/clusters': return { ...d, rows: d.rows.map(clusterBase) };
    case '/api/cluster': {
      const x = clusterBase(d);
      x.history = (d.history || []).map(({ tags, score, ...h }) => h);
      return x;
    }
    case '/api/wallet': {
      const x = { ...d };
      if (x.cluster) { const { rule, score, ...c } = x.cluster; x.cluster = c; }
      return x;
    }
    case '/api/scans': return { ...d, rows: failedOnly(d.rows) };
    case '/api/scan': { const { features, failed, decision, ai, ...x } = d; return { ...x, failed: gateIds(failed), ai: aiBrief(ai) }; }
    case '/api/sim/position': return { ...d, scans: failedOnly(d.scans) };
    case '/api/audit': {
      const hits = (f) => (f || []).filter((x) => x.hit).map(({ weight, ...r }) => r);
      return { ...d, risk: d.risk && { ...d.risk, factors: hits(d.risk.factors) }, trust: d.trust && { ...d.trust, factors: hits(d.trust.factors) }, summary: auditSummary(d.summary) };
    }
    default: return d;
  }
}
