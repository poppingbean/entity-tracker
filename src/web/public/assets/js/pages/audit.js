// ================================================================== AUTOMATED CONTRACT AUDIT (any kind of contract; new deploys found automatically)
const LVL = { critical: 'bad', high: 'bad', medium: 'neutral', low: 'good', info: 'unrated' };
const ROLE_OPTS = [['', 'every type'], ['token', 'fungible token'], ['nft', 'NFT collection'], ['amm', 'AMM / pool'], ['liquid_staking', 'liquid staking'], ['staking_pool', 'validator pool'], ['lending', 'lending'], ['dao', 'DAO'], ['multisig', 'multisig'], ['bridge', 'bridge'], ['router', 'intents / router'], ['factory', 'launchpad / factory'], ['account', 'smart wallet'], ['unknown', 'unknown']];
const lvl = (l) => (l ? `<span class="v ${LVL[l] || 'unknown'}">${esc(l)}</span>` : '<span class="muted">not audited</span>');
/** The automated audit of one contract (type, control, powers, findings, source, change, AI summary). */
function autoBody(a, job, id) {
  if (!a) return job?.running ? `<div class="card muted">Running the automated audit: reading the code, its type and powers, who controls it, recent behaviour, the claimed source, then the AI reviews (20-90 s) … started ${since(job.started)}</div>`
    : `<div class="card muted">${job?.error ? `<span class="r">The automated audit failed: ${esc(job.error)}</span>` : 'No automated audit yet.'}</div>`;
  if (a.no_code) return '<div class="card muted">No contract code on this account.</div>';
  const S = a.summary, C = a.control || {};
  let h = `<div class="card"><div class="bar"><h2 style="margin:0">Automated audit ${lvl(a.level)}</h2>${id ? reportBtn('contract', id) : ''}<span class="chip">${esc(a.label)}</span>${(a.standards || []).map((s) => `<span class="chip">${esc(s.toUpperCase())}</span>`).join('')}
      <span class="muted small">${a.role_source === 'ai' ? 'type from the AI · ' : ''}${esc(a.confidence || '')} confidence · audited ${since(a.ts)} · code shared by ${a.family_n} account${a.family_n > 1 ? 's' : ''}</span>
      <span class="spacer"></span>${job?.running ? '<span class="muted small">re-running …</span>' : `<button onclick="runAutoAudit('${esc(a.code_key ? '' : '')}${esc($('auditInput')?.value || '')}',true)">Re-run</button>`}</div>
    ${S ? `<p><b>${esc(S.headline)}</b></p><p class="small">${esc(S.summary)}</p>${S.risks_for_users?.length ? `<ul class="flags small">${S.risks_for_users.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}<p class="muted small" style="margin:0">Written by NEAR AI from the findings below; the level comes from the rules.</p>` : ''}</div>`;
  h += `<div class="grid2"><div class="card"><h2>Who controls it <span class="muted">${esc(C.summary || '')}</span></h2>
    <p class="small">${C.full_keys ? `<span class="r">${C.full_keys} full-access key${C.full_keys > 1 ? 's' : ''}</span>: whoever holds it can replace the code or move what the contract holds.` : 'No full-access key on the contract.'}</p>
    ${(C.controllers || []).length ? `<table class="small"><tr><th>Account</th><th>What it is</th><th>Role</th><th>Record</th></tr>${C.controllers.map((c) => `<tr><td class="acct">${esc(short(c.account, 34))}</td><td>${esc(c.kind)}</td><td>${esc(c.via || '')}</td><td class="wrap ${c.flags?.length ? 'r' : 'muted'}">${esc((c.flags || []).join('; ') || '–')}</td></tr>`).join('')}</table>` : '<p class="muted small">No owner or admin exposed by its views (the code may still check one).</p>'}
    ${a.deploy ? `<p class="small muted">Deployed by ${esc(a.deploy.deployer || '?')}${a.deploy.signer && a.deploy.signer !== a.deploy.deployer ? `, signed by ${esc(a.deploy.signer)}` : ''}${a.deploy.deployer_flags?.length ? ` <span class="r">(${esc(a.deploy.deployer_flags.join('; '))})</span>` : ''}</p>` : ''}</div>
    <div class="card"><h2>Powers over users <span class="muted">what the code lets someone do</span></h2>
    ${(a.powers || []).length ? `<table class="small"><tr><th>Power</th><th>Methods</th><th>Severity</th></tr>${a.powers.map((p) => `<tr><td>${esc(p.label)}${p.normal_for_role ? ' <span class="muted">(normal here)</span>' : ''}${p.source === 'ai' ? ' <span class="chip">AI</span>' : ''}</td><td class="wrap"><code>${p.methods.map(esc).join(', ')}</code></td><td>${lvl(p.severity)}</td></tr>`).join('')}</table>` : '<p class="muted small">No power over users found in its methods.</p>'}</div></div>`;
  const F = (a.findings || []).filter((f) => f.severity !== 'info');
  h += `<div class="card"><h2>Findings <span class="muted">${F.length}</span></h2>${F.length ? `<table class="small">${F.map((f) => `<tr><td>${lvl(f.severity)}</td><td class="wrap"><b>${esc(f.title)}</b>${f.ai ? ' <span class="chip">AI</span>' : ''}<div class="muted">${esc(f.detail || '')}${f.evidence ? ` <code>${esc(f.evidence)}</code>` : ''}</div></td></tr>`).join('')}</table>` : '<p class="muted small">Nothing beyond the notes below.</p>'}
    ${a.ai_deep?.summary ? `<p class="small"><b>AI review:</b> ${esc(a.ai_deep.summary)}</p>` : ''}
    <p class="muted small" style="margin:0">${a.source?.link ? `Source claimed: <a href="${esc(a.source.link)}" target="_blank" rel="noopener">${esc(short(a.source.link, 70))}</a>${a.source_review ? (a.source_review.error ? ` · could not be read (${esc(a.source_review.error)})` : ` · ${a.source_review.files_read} files read, ${a.source_review.missing?.length ? `<span class="r">${a.source_review.missing.length} deployed methods missing from it</span>` : 'every deployed method found in it'}`) : ''}` : 'No published source (NEP-330).'}</p></div>`;
  // what each method does: from the code, read by NEAR AI
  if ((a.functions || []).length) {
    const KIND = { view: ['unrated', 'view'], call: ['neutral', 'changes state'], callback: ['unrated', 'callback'], setup: ['unrated', 'setup'] };
    const RISKC = { none: 'good', low: 'good', medium: 'neutral', high: 'bad' };
    const WHO = { anyone: 'anyone', owner: 'owner / admin', callback: 'the contract itself', setup: 'once, at setup', unclear: 'unclear' };
    const fs = [...a.functions].sort((x, y) => ['high', 'medium', 'low', 'none'].indexOf(x.risk) - ['high', 'medium', 'low', 'none'].indexOf(y.risk) || (x.kind === 'view') - (y.kind === 'view'));
    h += `<div class="card"><div class="bar"><h2 style="margin:0">What its functions do <span class="muted">${fs.length} methods · ${fs.filter((f) => f.kind !== 'view').length} change something</span></h2>${a.ai_contract ? '<span class="chip">NEAR AI</span>' : ''}</div>
      ${a.ai_contract ? `<p class="small">${esc(a.ai_contract)}</p>` : '<p class="muted small">From what the compiled code of each method can do (state, deposits, transfers, calls to other contracts, keys and code).</p>'}
      <table class="small"><tr><th>Method</th><th>Kind</th><th>What it does</th><th>Who can call it</th><th>Risk</th></tr>
      ${fs.map((f) => `<tr><td><code>${esc(f.method)}</code></td><td><span class="v ${KIND[f.kind]?.[0] || 'unrated'}">${esc(KIND[f.kind]?.[1] || f.kind)}</span></td>
        <td class="wrap">${esc(f.purpose || f.does.join(', '))}${f.purpose ? `<div class="muted">code: ${esc(f.does.join(', '))}</div>` : ''}${f.note ? `<div class="a">${esc(f.note)}</div>` : ''}</td>
        <td>${esc(WHO[f.who] || (f.kind === 'view' ? 'anyone' : '–'))}</td><td><span class="v ${RISKC[f.risk] || 'unrated'}">${esc(f.risk)}</span></td></tr>`).join('')}</table>
      <p class="muted small" style="margin:6px 0 0">The kind and the code effects come from the compiled code${a.ai_contract ? '; the purposes are how NEAR AI reads the names, effects and strings, and the risks it gives are capped by what the code can actually do' : ''}.</p></div>`;
  }
  if (a.change) h += `<div class="card warn"><h2>Changed by the last redeploy</h2><p class="small">${a.change.added_powers?.length ? `New powers: <b>${a.change.added_powers.map(esc).join(', ')}</b>. ` : ''}${a.change.removed_powers?.length ? `Removed: ${a.change.removed_powers.map(esc).join(', ')}. ` : ''}${esc(a.change.ai?.explanation || '')}</p></div>`;
  return h;
}
let autoTimer = null;
async function runAutoAudit(address, force) {
  address = (address || '').trim();
  if (!address || !$('autoResult')) return;
  clearTimeout(autoTimer);
  const tick = async (first) => {
    if (!$('autoResult') || ($('auditInput') && $('auditInput').value.trim() !== address)) return;
    const r = await get('/api/audit-auto', { address, run: first ? '1' : '', force: first && force ? '1' : '' }).catch((e) => ({ error: e.message }));
    if (r.error) { $('autoResult').innerHTML = `<div class="card err">${esc(r.error)}</div>`; return; }
    $('autoResult').innerHTML = autoBody(r.job?.running && force ? null : r.auto, r.job, address);
    if (r.job?.running) autoTimer = setTimeout(() => tick(false), 4000);
  };
  tick(true);
}
/** A compact safety card for other pages (NFT collections): the automated audit's level, control and top findings. */
async function contractSafetyCard(id, el) {
  const r = await get('/api/audit-auto', { address: id }).catch(() => null);
  const a = r?.auto;
  if (!a || a.no_code) { el.innerHTML = `<div class="card"><div class="bar"><h2 style="margin:0">Contract safety</h2><span class="spacer"></span><button onclick="this.disabled=true;get('/api/audit-auto',{address:'${esc(id)}',run:'1'}).then(()=>setTimeout(()=>contractSafetyCard('${esc(id)}',document.getElementById('${el.id}')),20000))">Run the contract audit</button></div><p class="muted small" style="margin:0">Not audited yet: who controls this contract, what powers its code gives them (mint, change metadata, move NFTs, upgrade), and the checks for NFTs.</p></div>`; return; }
  const top = (a.findings || []).filter((f) => f.severity !== 'info').slice(0, 4);
  el.innerHTML = `<div class="card"><div class="bar"><h2 style="margin:0">Contract safety ${lvl(a.level)}</h2><span class="chip">${esc(a.label)}</span><span class="muted small">${esc(a.control?.summary || '')} · audited ${since(a.ts)}</span><span class="spacer"></span>${ilink(P.audit(id), 'Full audit →')}</div>
    ${a.summary?.headline ? `<p class="small"><b>${esc(a.summary.headline)}</b></p>` : ''}${top.length ? `<ul class="flags small">${top.map((f) => `<li>${lvl(f.severity)} ${esc(f.title)}</li>`).join('')}</ul>` : '<p class="muted small">No finding beyond the notes on the audit page.</p>'}</div>`;
}
async function newContractsCard() {
  const S = ST.newContracts;
  const j = await get('/api/contracts-new', { role: S.role, level: S.level, offset: S.offset });
  const q = j.queue || {};
  return `<div class="card"><div class="bar"><h2 style="margin:0">New contracts <span class="muted">every contract deployed on NEAR, audited automatically</span></h2>${sel('newContracts', 'role', ROLE_OPTS)}${sel('newContracts', 'level', [['', 'every level'], ['critical', 'critical'], ['high', 'high'], ['medium', 'medium'], ['low', 'low']])}<span class="spacer"></span><span class="muted small">queue: ${q.pending || 0} waiting · ${q.running || 0} running · ${q.done || 0} done${q.error ? ` · ${q.error} failed` : ''}</span>${pager('newContracts', j.total)}</div>
    <table><tr><th>When</th><th>Contract</th><th>How</th><th>Type</th><th>Level</th><th>Control</th><th>Top finding</th></tr>${j.rows.map((r) => `<tr ${row(P.audit(r.account))}><td>${when(r.ts)}<br><span class="muted small">${since(r.ts)}</span></td><td class="acct">${esc(short(r.account, 34))}<div class="muted small">by ${esc(short(r.signer || r.by || '?', 26))}</div></td>
      <td class="small">${esc(/Global/.test(r.kind) ? `shared code${r.global ? ' ' + short(typeof r.global === 'string' ? r.global : JSON.stringify(r.global), 22) : ''}` : 'own code')}</td><td>${r.audit ? esc(r.audit.label) : '<span class="muted">queued</span>'}${r.audit?.family_n > 1 ? `<div class="muted small">${r.audit.family_n} accounts share it</div>` : ''}</td><td>${lvl(r.audit?.level)}</td><td class="small">${esc(r.audit?.control?.summary || '')}</td>
      <td class="wrap small">${esc(r.audit?.summary?.headline || (r.audit?.findings || []).find((f) => f.severity !== 'info')?.title || '')}</td></tr>`).join('') || empty(7, 'none yet: the worker follows new blocks and adds them here')}</table></div>`;
}
