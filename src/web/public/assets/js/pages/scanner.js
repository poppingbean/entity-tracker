// ================================================================== SCANNER
const LV = { low: 'good', medium: 'neutral', high: 'bad', critical: 'bad', unrated: 'unknown', high_trust: 'good' };
const CAT = { critical: 'Critical', ownership: 'Ownership & control', trading: 'Trading', liquidity: 'Liquidity', trust: 'Trust signals' };
const gauge = (label, score, level, kind) => {
  const v = score ?? 0, col = kind === 'risk' ? (v >= 70 ? '#dc2626' : v >= 45 ? '#ea580c' : v >= 20 ? '#d97706' : '#16a34a') : (v >= 70 ? '#16a34a' : v >= 40 ? '#0ea5e9' : v >= 15 ? '#d97706' : '#94a3b8');
  return `<div class="tile"><span>${label}</span><b style="color:${col}">${score ?? '–'}<span class="muted" style="font-size:13px;font-weight:500"> / 100 · ${esc(level || '–')}</span></b><div style="height:6px;border-radius:5px;background:var(--line-2);margin-top:8px;overflow:hidden"><div style="height:100%;width:${v}%;background:${col}"></div></div></div>`;
};
function auditBody(a) {
  if (a.error) return `<div class="card err">${esc(a.error)}</div>`;
  if (a.notFound) return `<div class="card warn">${esc(a.address)}: there is no contract deployed on this account (a plain wallet), nothing to audit.</div>`;
  const sum = a.summary || {};
  let h = `<div class="card"><div class="bar"><h2 style="margin:0">Keys, code and token checks: ${esc(a.address)}${a.tokenSymbol ? ' · ' + esc(a.tokenSymbol) : ''} <span class="chip">${esc(a.kind)}</span></h2><span class="muted">audited ${when(a.fetchedAt)}${a.cached ? ' (cached ≤ 1 h)' : ''}</span>${a.kind === 'token' ? ilink(P.tok(a.address), 'Token page →') : ''}<span class="spacer"></span><button onclick="runAudit('${esc(a.address)}',true)">Re-run</button></div>
    <div class="tiles">${gauge('Risk score (higher = riskier)', a.risk.score, a.risk.level, 'risk')}${gauge('Trust score', a.trust.score, a.trust.level, 'trust')}
    ${tile('Full-access keys', sum.full_access_keys ?? '–')}${tile('Confirmed malicious findings', (sum.confirmed_malicious || []).length, null, (sum.confirmed_malicious || []).length ? 'r' : 'g')}${tile('Recent sells', sum.sells ? sum.sells.ok + ' ok / ' + sum.sells.failed + ' failed' : '–')}</div>`;
  if ((sum.confirmed_malicious || []).length) h += `<p class="r"><b>Confirmed:</b> ${sum.confirmed_malicious.map((c) => esc(c.key) + (c.detail ? ' (' + esc(c.detail) + ')' : '')).join(' · ')}</p>`;
  h += '</div>';
  const all = [...a.risk.factors, ...a.trust.factors.filter((f) => !a.risk.factors.some((x) => x.key === f.key))];
  const groups = {};
  for (const f of all) (groups[f.category] ||= []).push(f);
  h += '<div class="card"><h2>Findings</h2>' + (all.length ? '' : '<p class="muted">Nothing found.</p>') + '<table><tr><th>Result</th><th>Finding</th><th>Detail</th></tr>' +
    ['critical', 'ownership', 'trading', 'liquidity', 'trust'].filter((c) => groups[c]).map((c) => `<tr><td colspan="3" style="background:var(--panel-2);font-weight:700;color:var(--muted);font-size:11px;letter-spacing:.7px;text-transform:uppercase">${CAT[c]}</td></tr>` + groups[c].map((f) => `<tr><td>${f.category === 'trust' ? (f.hit ? '<span class="v good">earned</span>' : '<span class="v unknown">not earned</span>') : f.hit ? (f.weight == null || f.weight > 0 ? '<span class="v bad">hit</span>' : '<span class="v unknown">note</span>') : '<span class="v good">pass</span>'}</td><td class="wrap">${esc(f.label)}</td><td class="wrap muted">${esc(f.detail || '')}</td></tr>`).join('')).join('') + '</table></div>';
  const code = a.raw?.code;
  if (code) h += `<div class="card"><h2>Code <span class="muted">${code.exports.length} exported functions</span></h2>${code.fakeStorage.length ? `<p class="r">Fake storage methods: ${code.fakeStorage.map(esc).join(', ')}</p>` : ''}${(code.privilegedNames || []).length ? `<p class="a">Privileged methods: ${code.privilegedNames.map(esc).join(', ')}</p>` : ''}${code.nonStandard.length ? `<p>Non-standard methods: ${code.nonStandard.map(esc).join(', ')}</p>` : '<p class="muted">No methods outside the standards.</p>'}</div>`;
  if (a.raw?.tax) h += `<div class="card"><h2>Launchpad tax</h2><pre>${esc(JSON.stringify(a.raw.tax, null, 1))}</pre></div>`;
  return h;
}
async function runAudit(address, force) {
  address = (address || '').trim();
  if (!address || !$('auditResult')) return;
  $('auditResult').innerHTML = '<div id="autoResult"></div><div id="legacyResult"><div class="card muted">Reading keys, code and recent transactions …</div></div>';
  setUrl(P.audit(address));
  $('auditInput').value = address;
  runAutoAudit(address, force);
  const a = await get('/api/audit', { address, force: force ? '1' : '' }).catch((e) => ({ error: e.message }));
  if ($('legacyResult')) $('legacyResult').innerHTML = auditBody(a);
}
views.audit = async () => {
  const recent = await get('/api/audits', { limit: 25 });
  return `<div class="card"><div class="bar"><input id="auditInput" type="search" style="flex:1;max-width:520px" placeholder="token or contract account, e.g. doge.neardogecoin.near" onkeydown="if(event.key==='Enter')runAudit(this.value)"><button class="primary" onclick="runAudit($('auditInput').value)">Audit</button></div>
      <p class="muted" style="margin:0">Any kind of contract: tokens, NFT collections, pools, liquid staking, lending, DAOs, bridges, smart wallets. It works out what the contract is, which powers its code gives someone over users (and what each method can really do in the code), who holds them (a DAO, a multisig, a single wallet, someone flagged), the checks for its type, recent behaviour and the source it claims; then the AI reviews what the rules can't place and writes a summary. Every contract deployed on NEAR is audited automatically (below).</p></div>
    <div id="auditResult"></div>
    ${await newContractsCard()}
    <div class="card"><h2>Recent audits</h2><table><tr><th>When</th><th>Account</th><th>Kind</th><th>Risk</th><th>Trust</th></tr>${recent.rows.map((r) => `<tr data-id="${esc(r.id)}" data-href="" onclick="runAudit(this.dataset.id)"><td>${when(r.fetchedAt)}</td><td>${r.kind === 'token' ? tokCell(r.id, r.tokenSymbol, null, 34) : acct(r.id, 34)}</td><td>${esc(r.kind)}</td><td>${r.notFound ? '<span class="muted">no contract</span>' : `<span class="v ${LV[r.risk.level] || 'unknown'}">${r.risk.score} · ${esc(r.risk.level)}</span>`}</td><td>${r.notFound ? '–' : `<span class="v ${r.trust.level === 'high' ? 'good' : r.trust.level === 'unrated' ? 'unknown' : 'neutral'}">${r.trust.score} · ${esc(r.trust.level)}</span>`}</td></tr>`).join('') || empty(5, 'none yet')}</table></div>`;
};

const lineSvg = (pts, { fmt = (v) => n(v, 2), base = null } = {}) => {
  if (pts.length < 2) return '<p class="muted">not enough data points yet (a point is stored every 5 minutes while the worker runs)</p>';
  const W = 1000, H = 120, xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys, base ?? Infinity), hi = Math.max(...ys, base ?? -Infinity);
  const sx = (x) => 8 + ((x - x0) / (x1 - x0 || 1)) * (W - 16), sy = (y) => H - 10 - ((y - lo) / (hi - lo || 1)) * (H - 20);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  const b = base != null ? `<line x1="0" x2="${W}" y1="${sy(base)}" y2="${sy(base)}" style="stroke:var(--faint)" stroke-dasharray="4 4"/>` : '';
  return `<svg class="graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:120px">${b}<path d="${d}L${sx(x1)},${H}L${sx(x0)},${H}Z" style="fill:var(--accent-soft)"/><path d="${d}" fill="none" style="stroke:var(--accent)" stroke-width="2" stroke-linejoin="round"/></svg><div class="muted small" style="display:flex;justify-content:space-between;margin-top:4px"><span>${esc(when(x0))}</span><span>min ${fmt(lo)} · max ${fmt(hi)}</span><span>${esc(when(x1))}</span></div>`;
};
const simAct = async (id, percent) => {
  if (!confirm(`Simulated sale of ${percent}% of this position (paper money). Continue?`)) return;
  const r = await fetch('/api/sim/sell', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tracker': '1' }, body: JSON.stringify({ id, percent }) });
  const j = await r.json();
  alert(j.status === 'sold' || j.status === 'closed' ? `Simulated sale done: ${n(j.near, 3)} NEAR` : `Not sold: ${j.reason || j.error || j.status}`);
  render();
};
views.sim = async () => {
  const [o, op, cl] = await Promise.all([get('/api/sim/overview'), get('/api/sim/positions', { status: 'open' }), get('/api/sim/positions', { status: 'closed' })]);
  const a = o.account; if (Math.abs(o.pnl_near) < 1e-9) o.pnl_near = 0; const pnlCls = o.pnl_near >= 0 ? 'g' : 'r'; // no "-0" from rounding noise
  const sum = (rows, f) => rows.reduce((t, p) => t + (f(p) || 0), 0);
  const closedPnl = sum(cl.rows, (p) => (p.realized_near || 0) - (p.cost_near || 0));
  return `<div class="card"><div class="tiles">${tile('Equity', n(o.equity, 2) + ' N', null, pnlCls)}${tile('P&L', signed(o.pnl_near, 2) + ' N', pct(o.pnl_pct, 1), pnlCls)}${tile('Realized P&L', signed(o.realized_pnl, 2) + ' N', 'sold: proceeds minus cost', roiCls(o.realized_pnl))}${tile('Unrealized P&L', signed(o.unrealized_pnl, 2) + ' N', 'open positions at today\'s value', roiCls(o.unrealized_pnl))}${tile('Cash', n(a.cash_near, 2) + ' N')}${tile('Open value', n(o.open_value, 2) + ' N')}${tile('Open / closed', o.open_n + ' / ' + o.closed_n)}${tile('Buys today', o.buys_today + ' / ' + o.limits.maxBuysPerDay)}</div>
    <p class="muted small" style="margin-bottom:0">Simulated wallet: started with ${n(a.start_near, 0)} NEAR on ${when(a.created_ts)}. Paper money only: buys and sells are priced with the pool's on-chain quote (price impact and pool fee included), the token's own tax and 1% extra slippage; nothing is sent to the chain. Size ${o.limits.buyNear} N (${o.limits.highRiskBuyNear} N when the AI rates the risk high), exposure cap ${o.limits.maxOpenCostNear} N, reserve ${o.limits.minReserveNear} N.</p></div>
  <div class="card"><h2>Equity curve</h2>${lineSvg(o.equity_series.map((e) => ({ x: e.ts, y: e.equity })), { fmt: (v) => n(v, 2) + ' N', base: a.start_near })}</div>
  <div class="card"><h2>Open positions <span class="muted">${op.rows.length} · click a row for fills and reviews</span></h2><table><tr><th>Token</th><th>Opened</th><th class="num">Cost N</th><th class="num">Value N</th><th class="num">ROI</th><th class="num" title="proceeds of what was sold minus its cost">Realized P&amp;L</th><th class="num" title="what is still held, at today's value, minus its cost">Unrealized P&amp;L</th><th>AI</th><th>Take profit</th><th>Sell (simulated)</th></tr>
    ${op.rows.map((p) => `<tr ${row(P.sim(p.id))}><td>${tokCell(p.token, p.symbol, p.launchpad, 22)}</td><td>${when(p.opened_ts)}</td><td class="num">${n(p.cost_near)}</td><td class="num">${n(p.value_near, 3)}</td><td class="num ${roiCls(p.roi)}"><b>${pct(p.roi)}</b></td><td class="num ${roiCls(p.realized_pnl)}">${signed(p.realized_pnl, 3)}</td><td class="num ${roiCls(p.unrealized_pnl)}">${signed(p.unrealized_pnl, 3)}</td>
      <td class="muted">${p.ai ? esc(p.ai.action) + ' ' + n(p.ai.confidence) + ' ' + esc(p.ai.risk_level) : 'rules'}</td><td class="${p.take_profit ? 'g' : 'muted'}">${p.take_profit ? 'took ' + n(p.take_profit.near, 2) + ' N' : 'waiting'}</td>
      <td onclick="event.stopPropagation()">${[25, 50, 100].map((x) => `<button data-id="${esc(p.id)}" onclick="simAct(this.dataset.id,${x})">${x === 100 ? 'All' : x + '%'}</button>`).join(' ')}</td></tr>`).join('') || empty(10, 'no open positions')}</table></div>
  <div class="card"><h2>Closed positions <span class="muted">${cl.rows.length} · cost ${n(sum(cl.rows, (p) => p.cost_near))} N · proceeds ${n(sum(cl.rows, (p) => p.realized_near), 2)} N · P&amp;L <span class="${roiCls(closedPnl)}">${signed(closedPnl, 2)} N</span></span></h2><table><tr><th>Token</th><th>Opened</th><th>Closed</th><th class="num">Cost N</th><th class="num">Proceeds N</th><th class="num">P&amp;L N</th><th class="num">ROI</th><th>Exit</th></tr>
    ${cl.rows.map((p) => { const pnl = (p.realized_near || 0) - (p.cost_near || 0), roi = p.cost_near ? pnl / p.cost_near : null; return `<tr ${row(P.sim(p.id))}><td>${tokCell(p.token, p.symbol, p.launchpad, 22)}</td><td>${when(p.opened_ts)}</td><td>${when(p.exit?.ts)}</td><td class="num">${n(p.cost_near)}</td><td class="num">${n(p.realized_near, 3)}</td><td class="num ${roiCls(pnl)}">${signed(pnl, 3)}</td><td class="num ${roiCls(roi)}"><b>${pct(roi)}</b></td><td class="muted wrap small">${esc(p.exit?.reason || '')}</td></tr>`; }).join('') || empty(8, 'no closed positions')}</table></div>`;
};

async function simPage(id) {
  const p = await get('/api/sim/position', { id });
  let h = `<div class="card">${crumbs([['Simulated wallet', '/sim'], [p.symbol || short(p.token, 20)]])}
    <div class="dh-main">${avatar(p.token, p.symbol, 48)}<div><h1>${esc(p.symbol || '')} · simulated position ${p.status === 'open' ? '<span class="v neutral">open</span>' : '<span class="v unknown">closed</span>'}</h1>
    <div class="meta">${ilink(P.tok(p.token), 'Token page →')}${ext(tokUrl(p.token, p.launchpad), 'Launchpad ↗')}<span>opened ${when(p.opened_ts)}</span><span>${esc(p.origin || '')}</span><span>route ${esc(p.route || '')}</span></div></div></div>
    <div class="tiles">${tile('Cost', n(p.cost_near) + ' N')}${tile('Value', n(p.value_near, 3) + ' N')}${tile('ROI', pct(p.roi), null, roiCls(p.roi))}${tile('Realized P&L', signed(p.realized_pnl, 3) + ' N', `${n(p.realized_near, 3)} N received`, roiCls(p.realized_pnl))}${tile('Unrealized P&L', signed(p.unrealized_pnl, 3) + ' N', null, roiCls(p.unrealized_pnl))}${tile('Held tokens', n(p.held_tokens, 0))}${p.exit ? tile('Exit', esc(p.exit.reason)) : ''}</div>
    ${p.ai ? `<p class="muted small" style="margin-bottom:0">AI at entry: ${esc(p.ai.action)} ${n(p.ai.confidence)} · risk ${esc(p.ai.risk_level)} · rule score ${p.score ?? '–'} · ${esc(p.size_reason || '')}</p>` : ''}</div>`;
  h += `<div class="grid2"><div class="card"><h2>Fills</h2><table><tr><th>When</th><th>Side</th><th class="num">NEAR</th><th class="num">Tokens</th><th>Reason</th></tr>${p.fills.map((f) => `<tr><td>${when(f.ts)}</td><td class="${f.side === 'buy' ? 'g' : 'r'}">${f.side}</td><td class="num">${n(f.near, 3)}</td><td class="num">${n(f.tokens, 0)}</td><td class="wrap muted small">${esc(f.reason || '')}</td></tr>`).join('')}</table></div>
    <div class="card"><h2>Reviews of this token</h2><table><tr><th>When</th><th>Kind</th><th class="num">Score</th><th>Rules</th><th>AI</th><th>Decision</th></tr>${p.scans.map((s) => `<tr ${row(P.scan(s.id))}><td>${when(s.ts)}</td><td>${esc(s.kind)}${s.kind === 'followup' ? ' +' + s.minutes + 'm' : ''}</td><td class="num b">${s.score}</td><td class="${s.pass ? 'g' : 'r'}">${s.pass ? 'pass' : 'fail'}</td><td>${s.ai ? esc(s.ai.action) + ' ' + n(s.ai.confidence) : '–'}</td><td class="wrap muted small">${esc(s.decision || '')}</td></tr>`).join('')}</table></div></div>`;
  return h;
}

views.scans = async () => {
  const S = ST.scans, j = await get('/api/scans', { kind: S.kind, pass: S.pass, bought: S.bought, q: S.q, limit: 50, offset: S.offset });
  return `<div class="card"><div class="bar">${seg('scans', 'pass', [['', 'All'], ['1', 'Gates pass'], ['0', 'Gates fail']])}${sel('scans', 'kind', [['', 'all kinds'], ['first', 'first check'], ['followup', 'follow-up']])}${sel('scans', 'bought', [['', 'all'], ['1', 'bought only']])}
    ${qbox('scans', 'symbol / token')}<span class="spacer"></span>${pager('scans', j.total)}</div>
    <table><tr><th>Token</th><th>At</th><th>Kind</th><th class="num">Score</th><th>Gates</th><th>Gate fail</th><th>AI</th><th>Decision</th><th>Trade</th></tr>
    ${j.rows.map((s) => `<tr ${row(P.scan(s.id))}><td>${tokCell(s.token, s.symbol, s.launchpad, 22)}</td><td>${when(s.ts)}</td><td>${esc(s.kind)}${s.kind === 'followup' ? ' +' + s.minutes + 'm' : ''}</td><td class="num b">${s.score}</td><td>${s.pass ? '<span class="v good">pass</span>' : '<span class="v bad">fail</span>'}</td>
      <td class="wrap small" title="${esc(failTitle(s))}">${gateCodes(s)}</td><td>${s.ai ? esc(s.ai.action) + ' ' + n(s.ai.confidence) + ' <span class="muted">' + esc(s.ai.risk_level) + '</span>' : '–'}</td><td class="wrap muted small">${esc(s.decision || '')}</td><td class="${s.trade?.status === 'bought' ? 'g' : 'muted'}">${s.trade ? esc(s.trade.status) + (s.trade.near ? ' ' + s.trade.near + ' N' : '') : ''}</td></tr>`).join('') || empty(9, 'no evaluations yet: tokens are checked a couple of minutes after their pool opens')}</table></div>`;
};

async function scanPage(id) {
  const s = await get('/api/scan', { id }), f = s.features || {}, ai = s.ai;
  let h = `<div class="card">${crumbs([['Evaluations', '/scans'], [`${s.symbol || short(s.token, 20)} · ${s.kind}`]])}
    <div class="dh-main">${avatar(s.token, s.symbol, 48)}<div><h1>${esc(s.symbol || '')} · ${esc(s.kind)}${s.kind === 'followup' ? ' +' + s.minutes + ' min' : ''} ${s.pass ? '<span class="v good">gates pass</span>' : '<span class="v bad">gates fail</span>'}</h1>
    <div class="meta">${ilink(P.tok(s.token), 'Token page →')}${ext(tokUrl(s.token, s.launchpad), 'Launchpad ↗')}<span>${when(s.ts)}</span><span>score <b class="b">${s.score}</b></span><span>${esc(s.decision || '')}</span></div></div></div>`;
  if (s.trade && SHOW_SIM) h += `<p>Simulated trade: <b class="${s.trade.status === 'bought' ? 'g' : ''}">${esc(s.trade.status)}</b> ${s.trade.near ? s.trade.near + ' N' : ''} ${esc(s.trade.reason || '')}</p>`;
  if (s.pass === false || s.stale || s.error) h += `<h3>Why it did not pass</h3>${failReasons(s)}`;
  h += '</div>';
  if (ai) h += `<div class="ai"><b>NEAR AI analyst</b> · ${esc(ai.action)} confidence ${n(ai.confidence)} · risk ${esc(ai.risk_level)} · quality ${ai.quality_score ?? '–'}${(ai.reasons || []).length ? '<ul class="flags">' + ai.reasons.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}${(ai.red_flags || []).length ? '<p class="a"><b>Red flags</b></p><ul class="flags">' + ai.red_flags.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}</div>`;
  else if (s.ai_pending) h += `<div class="card muted">${Date.now() - s.ts < 15 * 60e3 ? 'The AI analyst is reviewing this token (the gate result above is final) …' : 'The AI review did not finish.'}</div>`;
  else h += `<div class="card muted">${s.pass === false ? 'No AI review: the token did not pass the checks above, so the AI analyst was not asked.' : 'No AI review: NEAR AI is off or the call failed.'}</div>`;
  const ig = f.intel?.early_buyer_groups;
  if (ig) {
    h += `<div class="card"><h2>Entity intelligence <span class="muted">early buying by group verdict at the time of the check</span></h2><p class="small"><span class="g">good ${pct(ig.good.share)} (${ig.good.wallets} w)</span> · <span class="r">dangerous ${pct(ig.bad.share)} (${ig.bad.wallets} w)</span> · bots/losers ${pct(ig.bots_losers?.share)} · neutral ${pct(ig.neutral.share)} · unknown ${pct(ig.unknown.share)} · creator's earlier rugs: ${f.intel.creator_prior_rugs_or_dumps}/${f.intel.creator_prior_launches}</p></div>`;
  }
  if (s.features) h += `<div class="grid2"><div class="card"><h2>Key numbers</h2><table class="kv">${[['Pool', n(f.pool?.nearReserve, 1) + ' N · ' + (f.pool?.quoteSymbol || '') + ' · ' + (f.pool?.route || '')], ['Market cap', '$' + n(f.market?.mcapUsd, 0)], ['Buyers / sellers', `${f.trading?.uniqueBuyers} / ${f.trading?.uniqueSellers}`], ['Bought / sold', `${n(f.trading?.buyNear, 0)} / ${n(f.trading?.sellNear, 0)} N`], ['Price vs first trade', 'x' + f.trading?.priceMultipleSinceFirstTrade], ['Linked buyer share', pct(f.wallets?.linkedBuyerShare)], ['Creator sold (at scan)', f.trading?.creatorSold ? 'yes' : 'no'], ['Tax', JSON.stringify(f.launch?.tax)], ['Contract matches template', String(f.contract?.matchesTemplate)], ['Top-10 holders', pct(f.holders?.top10ShareExPool, 1)]].map(([k, v]) => `<tr><td>${k}</td><td class="wrap">${esc(v)}</td></tr>`).join('')}</table></div>
    <div class="card"><h2>All features</h2><pre style="white-space:pre-wrap;color:var(--muted);max-height:520px">${esc(JSON.stringify(f, null, 1))}</pre></div></div>`;
  return h;
}
