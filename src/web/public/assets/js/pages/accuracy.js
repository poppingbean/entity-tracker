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
      <table><tr><th>Verdict before the buy</th><th class="num">Buys</th><th class="num">Went bad</th><th class="num">Median 24 h</th></tr>${GR.per_verdict.map((v) => `<tr><td>${esc(v.verdict)}</td><td class="num">${v.entries}</td><td class="num">${pct(v.bad_rate)}</td><td class="num">${pct(v.median_roi, 1)}</td></tr>`).join('')}</table></div></div>${securityCards(A.security)}`;
};

// ---- security verdicts (src/accuracy/security.js): hacks, live detections, the firewall, contract audits, classification, AI grounding, data health
const nNote = (b) => (b && b.n != null ? `<p class="muted small">${b.n} labelled${b.note ? ` · ${esc(b.note)}` : ''}</p>` : '');
function securityCards(S) {
  if (!S || S.error) return S?.error ? `<div class="card muted small">Security verdict numbers could not be computed: ${esc(S.error)}</div>` : '';
  const I = S.incidents, D = S.detections, F = S.firewall, AU = S.audits, O = S.ontology, G = S.ai_grounding, H = S.data_health, MW = S.money_watch;
  let h = '<h2 style="margin:18px 0 6px">Security verdicts <span class="muted small">scored against what really happened: public reports, operator confirmations and clears, hand labels</span></h2><div class="grid2">';
  if (I) h += `<div class="card"><h2>Hacks called <span class="muted">${I.called} public calls</span></h2>${cm(I)}
    <p class="small">Precision <b>${pct(I.precision)}</b> · caught by the rules before any report <b>${pct(I.recall_by_rules)}</b> of ${I.labelled_bad} real hacks · median time to detect ${I.time_to_detect_min?.median == null ? '–' : Math.round(I.time_to_detect_min.median) + ' min'} · ${I.found_later} found long after · ${I.unlabelled} cases not labelled yet</p>
    ${(I.retracted || []).length ? `<p class="small">Called and later retracted: ${I.retracted.map((x) => `${ilink('/firewall/' + encodeURIComponent(x.id), esc(short(x.id, 22)))} (${x.hours_public} h)`).join(', ')}</p>` : ''}${nNote(I)}</div>`;
  if (D) h += `<div class="card"><h2>Live detections <span class="muted">${D.unlabelled + D.n} seen</span></h2>${cm(D)}<p class="small muted">${Object.entries(D.by_kind || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p>${nNote(D)}</div>`;
  if (F) h += `<div class="card"><h2>Firewall</h2><p class="small">Known-bad accounts it blocks or warns about: <b>${pct(F.blocked_bad.share)}</b> of ${F.blocked_bad.n}. Known-good accounts it warns about by mistake: <b>${pct(F.false_alarm_good.share)}</b> of ${F.false_alarm_good.n}.</p>
    ${(F.false_alarm_good.rows || []).length ? `<table class="small"><tr><th>Account</th><th>Verdict</th><th>Finding</th></tr>${F.false_alarm_good.rows.map((x) => `<tr><td>${walLink(x.account, 28)}</td><td>${esc(x.verdict)}</td><td>${esc(x.finding || '')}</td></tr>`).join('')}</table>` : '<p class="small muted">No false alarms in the known-good set.</p>'}${nNote(F.false_alarm_good)}</div>`;
  if (AU) h += `<div class="card"><h2>Contract audits <span class="muted">${AU.coverage.labelled} of ${AU.coverage.audited} labelled</span></h2>
    <table class="small"><tr><th>Level</th><th class="num">Audited</th><th class="num">Labelled</th><th class="num">Went bad</th></tr>${Object.entries(AU.per_level).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.audited}</td><td class="num">${v.labelled}</td><td class="num">${pct(v.bad_rate)}</td></tr>`).join('')}</table>
    <p class="small">AUC with the level as the risk: ${aucTxt(AU.auc)}</p>${AU.note ? `<p class="muted small">${esc(AU.note)}</p>` : ''}</div>`;
  if (O) h += `<div class="card"><h2>Classification <span class="muted">the golden set</span></h2><p class="small"><b>${O.ok}</b> of ${O.n} known accounts are classified right.</p>
    ${(O.failures || []).length ? `<p class="small a">Wrong: ${O.failures.slice(0, 6).map((x) => `${esc(short(x.account, 24))} is ${esc(x.got)}, expected ${esc(x.expect)}`).join('; ')}</p>` : ''}</div>`;
  if (G && Object.keys(G).length) h += `<div class="card"><h2>AI texts checked against their evidence <span class="muted">30 days</span></h2><table class="small"><tr><th>Text</th><th class="num">Checked</th><th class="num">Clean</th><th class="num">Asked again</th><th class="num">Marked</th></tr>${Object.entries(G).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.checked}</td><td class="num">${v.clean}</td><td class="num">${v.retried}</td><td class="num">${v.unverified}</td></tr>`).join('')}</table></div>`;
  if (H) h += `<div class="card"><h2>Data health <span class="muted">chain data against a second source</span></h2><p class="small">Block gaps in the last 7 days: <b>${H.gaps_7d ?? 0}</b> · transactions cross-checked: <b>${H.checked ?? 0}</b>, mismatches <b class="${H.mismatches ? 'r' : ''}">${H.mismatches ?? 0}</b> · last check ${H.last_check_ts ? since(H.last_check_ts) : 'never'}</p></div>`;
  if (MW) h += `<div class="card"><h2>Money watch <span class="muted">every movement of $100k or more</span></h2><p class="small">Closed as normal, then shown to be part of a hack: <b class="${MW.normal_later_bad ? 'r' : ''}">${MW.normal_later_bad}</b> of ${MW.closed_normal} (the number to keep at zero) · looked suspicious: ${MW.escalated}, of them confirmed ${MW.escalated_confirmed}${MW.escalated_precision == null ? '' : ` (${pct(MW.escalated_precision)})`} · still watched: ${MW.open}</p>
    <p class="small muted">Closed by: ${Object.entries(MW.closed_by || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || '–'}</p>${nNote(MW)}</div>`;
  return h + '</div>';
}
