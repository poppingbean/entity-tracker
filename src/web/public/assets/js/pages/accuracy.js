// ================================================================== MEASURED ACCURACY + "wrong verdict" reports
/** ⚑ button: opens a small form under itself; the report goes to a review queue and, once accepted, becomes ground truth. */
const reportBtn = (kind, id) => `<button class="watchbtn" data-r="${esc(kind)}:${esc(id)}" onclick="reportForm(this)" title="Tell us this verdict is wrong (reviewed before it counts)">⚑ Wrong verdict?</button>`;
function reportForm(btn) {
  if (btn.nextElementSibling?.classList.contains('rform')) { btn.nextElementSibling.remove(); return; }
  btn.insertAdjacentHTML('afterend', `<div class="rform card" style="position:absolute;right:0;z-index:5;width:300px;text-align:left"><b>What really happened?</b>
    <div class="bar"><label><input type="radio" name="rv" value="bad" checked> a scam / buyers lost</label><label><input type="radio" name="rv" value="good"> it was fine</label></div>
    <textarea rows="3" maxlength="500" style="width:100%" placeholder="what you saw (optional): a tx, a report, a link"></textarea>
    <div class="bar"><button onclick="sendReport(this)">Send</button><span class="muted small"></span></div></div>`);
}
async function sendReport(b) {
  const f = b.closest('.rform'), btn = f.previousElementSibling, [kind, ...rest] = btn.dataset.r.split(':');
  const r = await post('/api/feedback', { kind, id: rest.join(':'), verdict: f.querySelector('input[name=rv]:checked').value, note: f.querySelector('textarea').value });
  f.querySelector('.small').textContent = r.error || 'Thanks: queued for review.';
  if (!r.error) { b.disabled = true; setTimeout(() => f.remove(), 1500); }
}
const ratio = (x) => (x == null ? '–' : x.toFixed(2));
const xret = (x) => (x == null ? "–" : "x" + x.toFixed(3));
const cm = (c) => `<table class="small"><tr><th></th><th class="num">went bad</th><th class="num">was fine</th></tr>
  <tr><td>warned / blocked</td><td class="num g">${c.tp}</td><td class="num a">${c.fp}</td></tr><tr><td>let through</td><td class="num r">${c.fn}</td><td class="num">${c.tn}</td></tr></table>`;
const rets = (s) => (s ? `let through: <b>${xret(s.passed.median)}</b> median 24 h (${s.passed.n}) · blocked: <b>${xret(s.flagged.median)}</b> (${s.flagged.n})` : '');
const aucTxt = (a) => (a == null ? '–' : `${ratio(a)} <span class="muted small">${a >= 0.6 ? 'useful' : a > 0.4 ? 'no signal' : 'backwards'}</span>`);
views.accuracy = async () => {
  const j = await get('/api/accuracy'), A = j.accuracy;
  if (!A) return `<div class="card"><p class="muted">No accuracy pass yet: the worker computes one every hour (or run <code>node src/cli.js accuracy</code>).</p></div>`;
  const G = A.gates, AI = A.ai, GR = A.groups, R = A.replay_current_gates;
  const labels = (j.labels || []).map((x) => `${x.n} ${x.kind} ${x.label}`).join(' · ') || 'none yet';
  return `<div class="card"><div class="tiles">${tile('Checks judged', A.checks, `+${A.imported_checks} imported from the old scanner`)}${tile('Went bad', pct(A.base_rate), esc(A.truth.label))}
      ${tile('Gates: caught', pct(G.recall), `of the launches that went bad, but blocks ${pct(G.n ? (G.tp + G.fp) / G.n : null)} of all`, 'a')}${tile('Rule score AUC', ratio(A.rule_score.auc), A.rule_score.auc != null && A.rule_score.auc < 0.4 ? 'backwards: higher score, more losses' : '0.5 = no signal, 1 = perfect', A.rule_score.auc != null && A.rule_score.auc < 0.4 ? 'r' : '')}
      ${tile('Audit risk AUC', ratio(A.audit_risk.auc), `${A.audit_risk.audited} audited`)}${tile('Hand labels', (j.labels || []).reduce((s, x) => s + x.n, 0), `${j.feedback_pending} reports waiting for review`)}</div>
    <p class="muted small" style="margin:8px 0 0">Every judgment is scored against what happened after it, never before: ground truth is what a buyer at the moment of the check held 24 h later, unless a person labelled it (${esc(labels)}). Updated ${since(A.ts)}.</p></div>
  <div class="grid2"><div class="card"><h2>Quality gates <span class="muted">${G.n} own checks</span></h2>${cm(G)}<p class="small">${rets(G.returns)}</p>
      <p class="small">The current gates replayed on all ${R.n} stored checks: ${R.tn + R.fn} would pass, ${pct(R.bad_rate_passed)} of those went bad. ${rets(R.returns)}</p></div>
    <div class="card"><h2>AI analyst <span class="muted">${AI.checks} verdicts</span></h2>${cm(AI.warn_vs_outcome)}<p class="small">${rets(AI.returns)} · risk level AUC ${aucTxt(AI.risk_auc)}</p>
      <p class="small muted">${Object.entries(AI.actions || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}. ${esc(AI.note)}</p></div></div>
  <div class="card"><h2>Each gate <span class="muted">how often launches that failed it went bad</span></h2>
      <table><tr><th>Gate</th><th class="num">Failed</th><th class="num">Bad if failed</th><th class="num">Bad if passed</th><th class="num">Lift</th><th class="num">Fine launches blocked</th></tr>
      ${A.per_gate.map((g) => `<tr><td><code>${esc(g.gate)}</code></td><td class="num">${g.failed_n}</td><td class="num">${pct(g.bad_rate_failed)}</td><td class="num">${pct(g.bad_rate_passed)}</td><td class="num ${g.lift >= 1.5 ? 'g' : g.lift != null && g.lift < 0.8 ? 'r' : ''}">${ratio(g.lift)}</td><td class="num">${g.good_blocked}</td></tr>`).join('')}</table>
      <p class="muted small">Lift above 1 = launches failing the gate go bad more often than average (it catches something); below 1 = it mostly blocks fine launches.</p></div>
  <div class="grid2"><div class="card"><h2>Rule score <span class="muted">bad rate per score band</span></h2>
      <table><tr><th>Score</th><th class="num">Checks</th><th class="num">Went bad</th></tr>${A.rule_score.calibration.map((b) => `<tr><td>${b.from}–${Math.min(b.to, 100)}</td><td class="num">${b.n}</td><td class="num">${pct(b.bad_rate)}</td></tr>`).join('')}</table></div>
    <div class="card"><h2>Group verdicts <span class="muted">out of time</span></h2>
      <p class="small muted">Each early buy scored with the verdict its group had <i>before</i> the buy, against that buy's 24 h result (${GR.entries} buys).</p>
      <table><tr><th>Verdict before the buy</th><th class="num">Buys</th><th class="num">Went bad</th><th class="num">Median 24 h</th></tr>${GR.per_verdict.map((v) => `<tr><td>${esc(v.verdict)}</td><td class="num">${v.entries}</td><td class="num">${pct(v.bad_rate)}</td><td class="num">${pct(v.median_roi, 1)}</td></tr>`).join('')}</table></div></div>`;
};
