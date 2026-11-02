// ================================================================== TOKENS + SCANNER (one page)
/** Scanner state of a launch: observing / checking / gates fail / pass / bought (simulated). */
// ---- why a token failed the scanner: a plain explanation per gate. This is what the public dashboard shows: it names the check that
// failed without its threshold, so a rugger cannot learn the numbers to get past it. (When running locally the server also sends the
// exact reason, shown under it.)
const GATE_TEXT = {
  quote_accepted: 'Its pool is quoted in a token the scanner cannot trade.',
  standard_contract: "The token contract is not the launchpad's standard code (custom code can hide a honeypot).",
  lp_locked: 'Liquidity is not locked by the launchpad, so it can be pulled.',
  min_pool_near: 'Too little NEAR in the pool.',
  min_mcap: 'Market cap too small.',
  min_buyers: 'Too few independent wallets had bought it at the time of the check.',
  creator_not_selling: 'The creator had already sold some of the token.',
  tax_ok: 'The buy / sell tax is too high.',
  no_sybil_cluster: 'Too much of the buying came from wallets linked to each other or to the creator.',
  creator_not_funding_buyers: 'The creator funded some of the buyers.',
  not_overextended: 'The price had already run up too far since the first trade.',
  quote_available: 'No tradable quote for the buy size (the pool is too thin).',
  contract_audit_ok: 'The contract audit found a dangerous finding or a high risk score.',
  creator_clean_history: 'The creator launched tokens before that were rugged or dumped.',
  creator_network_clean: 'Other token creators tied to this one by funding or payments have rugged.',
  bad_groups_not_dominant: 'Wallets from groups judged dangerous made up too much of the early buying.',
  no_ai_manipulation: 'The token name or symbol tries to give instructions to AI reviewers.',
};
const gateId = (g) => (typeof g === 'string' ? g : g?.id);
const gateText = (g) => GATE_TEXT[gateId(g)] || String(gateId(g) || 'unknown check').replace(/_/g, ' ');
/** The reasons a scanner check failed, readable: one line per failed gate, or the low score when every gate passed. */
function failReasons(s) {
  if (!s) return '';
  if (s.stale) return '<p class="muted">Not checked: the token was not checked within its first hour.</p>';
  if (s.error) return `<p class="r">The check could not run${typeof s.error === 'string' ? ': ' + esc(s.error) : ''}.</p>`;
  if (s.pass !== false) return '';
  const failed = s.failed || [];
  const items = failed.map((g) => `<li><b class="r">${esc(gateId(g))}</b> <span class="muted">${esc(gateText(g))}</span>${g?.why ? `<div class="muted small">${esc(g.why)}</div>` : ''}</li>`);
  if (!failed.length) items.push(`<li><b class="r">score</b> <span class="muted">Every gate passed, but the overall rule score${s.score != null ? ` (${esc(s.score)})` : ''} was too low to buy.</span></li>`);
  return `<ul class="flags">${items.join('')}</ul>`;
}
/** The failed gate codes in one red line, e.g. "min_pool_near, min_mcap, min_buyers" (the explanations are in the tooltip). */
const gateCodes = (s) => (s?.pass !== false ? '' : (s.failed || []).length ? `<span class="r">${esc(s.failed.map(gateId).join(', '))}</span>` : '<span class="r">score</span>');
const failTitle = (s) => (s?.pass === false ? ((s.failed || []).length ? s.failed.map(gateText).join('\n') : 'every gate passed, but the rule score was too low') : '');

const scanState = (t, scanCfg) => {
  if (t.status === 'skipped_quote') return '<span class="muted">skipped (quote not tradable)</span>';
  if (t.status === 'awaiting_pool') return '<span class="muted">waiting for its pool</span>';
  if (t.track_only) return '<span class="chip">tracking only</span>';
  const s = t.scan;
  if (s?.stale) return '<span class="muted">stale</span>';
  if (s?.error) return '<span class="r">error</span>';
  if (s?.score != null && s.ai_pending) return Date.now() - s.ts < 15 * 60e3 ? '<span class="v good">gates pass</span> <span class="b small">AI reviewing…</span>' : '<span class="v good">gates pass</span> <span class="muted small">AI review did not finish</span>';
  if (s?.score != null) return s.bought && SHOW_SIM ? '<span class="v good">bought (sim)</span>' : s.pass ? `<span class="v neutral">${SHOW_SIM ? 'pass, no buy' : 'gates pass'}</span>` : '<span class="v bad">gates fail</span>';
  const minAge = Math.max(scanCfg.observeSeconds, t.launchpad === 'justhoot' ? scanCfg.justhootMinAgeSeconds : 0) * 1000;
  const left = minAge - (Date.now() - t.live_ts);
  return left > 0 ? '<span class="b">observing</span>' : '<span class="b">checking…</span>';
};
/** Last-24 h trading volume of a token: NEAR bought + sold, with the split, trades and traders on hover. */
const volCell = (v) => (v ? `<td class="num" title="${esc(`${n(v.buy_near, 1)} N bought / ${n(v.sell_near, 1)} N sold · ${v.trades} trades · ${v.traders} traders`)}">${n(v.near, 0)} N</td>` : '<td class="num muted">–</td>');
views.tokens = async () => {
  const S = ST.tokens;
  const [j, m] = await Promise.all([get('/api/tokens', { q: S.q, status: S.status, tab: S.tab, launchpad: S.launchpad, limit: 50, offset: S.offset }), get('/api/monitor')]);
  setStatus(m.worker, m.now, m.ai);
  const W = m.window24h;
  return `<div class="card"><div class="tiles">${tile('Tokens tracked', n(m.tokensTotal, 0), `${m.launchesLast3h} in the last 3 h`)}${tile('Launches (24 h)', W.launches)}${tile('Checked', W.scanned)}${tile('Passed the gates', W.passed, null, 'a')}${SHOW_SIM ? tile('Bought (simulated)', W.bought, null, 'g') : ''}${tile('Rugged tokens', n(m.ruggedTotal, 0), null, m.ruggedTotal ? 'r' : '')}
    ${m.polls.map((p) => tile(esc(p.launchpad), p.ts ? ago(m.now - p.ts) + ' ago' : '–', p.ok === false ? esc(short(p.error || 'failed', 30)) : 'last poll ok', p.ok === false ? 'r' : '')).join('')}</div></div>
  <div class="card"><div class="bar">${seg('tokens', 'tab', [['', 'All'], ['new', 'New (24 h)'], ['checked', 'Checked'], ['passed', 'Passed gates'], ...(SHOW_SIM ? [['bought', 'Bought (sim)']] : []), ['rugged', 'Rugged'], ['volume', 'Top volume (24 h)']])}
    ${qbox('tokens', 'symbol / token / creator')}
    ${sel('tokens', 'launchpad', [['', 'all launchpads'], ['nearlytrade', 'nearly.trade'], ['justhoot', 'justhoot'], ['memecooking', 'meme.cooking'], ['gaypad', 'gaypad'], ['tkn', 'tkn.near'], ['qlyphs', 'qlyphs']])}
    ${sel('tokens', 'status', [['', 'any status'], ...['new', 'entries_open', 'tracking', 'done', 'awaiting_pool'].map((v) => [v, v])])}<span class="spacer"></span>${pager('tokens', j.total)}</div>
    <table><tr><th>Token</th><th>Pad</th><th>Age</th><th>Early money by tag</th><th>Scanner</th><th class="num">Score</th><th>Gate fail / decision</th><th class="num">Buyers</th><th class="num">Peak</th><th class="num">Now</th><th class="num" title="NEAR bought + sold in the last 24 h">Vol 24 h</th><th>Flags</th></tr>
    ${j.rows.map((t) => `<tr ${row(P.tok(t.id))}><td>${tokCell(t.id, t.symbol, t.launchpad)}</td><td>${esc(t.launchpad)}</td><td>${ago(m.now - t.live_ts)}</td><td>${mixCell(t.mix, t.rugger)}</td>
      <td>${scanState(t, m.scan)}</td><td class="num ${t.scan?.score == null ? 'muted' : 'b'}">${t.scan?.score ?? '–'}</td>
      <td class="wrap small" style="min-width:170px" title="${esc(failTitle(t.scan))}">${t.scan?.pass === false ? gateCodes(t.scan) + '<br>' : ''}${t.scan?.decision && t.scan.decision !== 'did not pass the checks' ? `<span class="muted">${esc(t.scan.decision)}</span>` : ''}${t.scan?.id ? ' ' + ilink(P.scan(t.scan.id), 'evaluation →') : ''}</td>
      <td class="num">${t.outcome?.buyers ?? '–'}</td><td class="num">x${n(t.outcome?.peak_multiple, 1)}</td><td class="num">${nowOf(t)}</td>${volCell(t.vol24)}
      <td>${crChip(t.creator_risk)} ${rugChips(t.outcome)} ${t.outcome?.rugged ? '' : exitChip(t.outcome) || (creatorSale(t.outcome).sold ? '<span class="v neutral">creator sold</span>' : '')}${!t.outcome?.rugged && !creatorSale(t.outcome).sold ? `<span class="chip">${esc(t.status)}</span>` : ''}</td></tr>`).join('') || empty(12, 'no tokens')}</table>
    <div class="legend">${MIXV.map(([v, l]) => `<span><span class="lg-dot ${v}"></span>${l}</span>`).join('')}<span>· green / red % = early NEAR from winners (win80 + win50 + sniper) / loss wallets</span></div></div>`;
};

views.signals = async () => {
  const j = await get('/api/signals', { hours: ST.signals.hours });
  const by = (a) => j.rows.filter((s) => s.assessment === a);
  const block = (a, title) => (by(a).length ? `<div class="card"><h2>${title} <span class="muted">${by(a).length}</span></h2><div class="tokgrid">${by(a).map(signalCard).join('')}</div></div>` : '');
  return `<div class="bar">${seg('signals', 'hours', [[24, '24 h'], [72, '72 h'], [168, '7 days']])}<span class="muted">${j.rows.length} tokens with rated wallets among the early buyers</span></div>
    ${block('rugger', 'Ruggers in: wallets tied to rugs bought early')}${block('bullish', 'Winners in (win80 / win50 / sniper), little loss money')}${block('warning', 'Loss wallets hold 25 %+ of early NEAR')}${block('mixed', 'Mixed')}
    ${j.rows.length ? '' : '<div class="card muted">No signals yet: needs profiled wallets and evaluated groups.</div>'}`;
};

/** A token we have never seen: fetch it from chain (launch, trades, early buyers, audit, analysis) and show the progress. */
function fetchPage(id) {
  setTimeout(() => startFetch(id), 0);
  return `<div class="card">${crumbs([['Tokens', '/tokens'], [short(id, 40)]])}<h2>${esc(id)}</h2>
    <p class="muted">This token is not in the database yet. Fetching it from the chain: its launch, trades and early buyers, the contract audit and the analysis.</p>
    <p id="fetchState"><span class="b">starting…</span></p></div>`;
}
let fetchTimer = null;
/** "Re-analyse": re-apply the latest rug rules to the stored trades of this token, then show the page again. */
async function reanalyse(id) {
  const box = document.getElementById('fetchState');
  if (box) box.innerHTML = '<span class="b">re-analysing with the latest rules…</span>';
  try {
    const j = await get('/api/reanalyse', { id });
    if (j.error) { if (box) box.innerHTML = `<span class="r">${esc(j.error)}</span>`; return; }
    if (box) box.innerHTML = `<span class="${j.rugged ? 'r' : 'g'}">Re-analysed${j.trades != null ? ` ${n(j.trades, 0)} trades` : ''} with the latest rules: ${j.rugged ? 'rugged (' + esc((j.rug_kinds || []).map((k) => rugKind[k] || k).join(', ')) + ')' : 'not rugged'}${j.was_rugged !== j.rugged ? ` · was ${j.was_rugged ? 'rugged' : 'not rugged'} before` : ' · no change'}</span>`;
    setTimeout(render, 1500);
  } catch (e) { if (box) box.innerHTML = `<span class="r">${esc(e.message)}</span>`; }
}
async function startFetch(id) {
  const box = () => document.getElementById('fetchState');
  if (!box()) return;
  clearTimeout(fetchTimer);
  const show = (html) => { if (box()) box().innerHTML = html; };
  try {
    let j = await get('/api/fetch-token', { id });
    const poll = async () => {
      if (location.pathname !== P.tok(id) && decodeURIComponent(location.pathname) !== P.tok(id)) return; // the user went elsewhere
      if (j.error) { show(`<span class="r">${esc(j.error)}</span>`); return; }
      if (j.state === 'running') { show(`<span class="b">${esc(j.step || 'working')}…</span>`); fetchTimer = setTimeout(async () => { j = await get('/api/fetch-status', { id }).catch(() => j); if (j.exists && (j.state !== 'running' || /auditing|analysis/.test(j.step || ''))) render(); else poll(); }, 2500); return; }
      if (j.state === 'error') { show(`<span class="r">Could not fetch it: ${esc(j.message || 'unknown error')}</span> <button onclick="startFetch('${esc(id)}')">Try again</button>`); return; }
      if (j.exists) { render(); return; }
      show(`<span class="muted">${esc(j.message || 'Nothing was stored.')}</span>`);
    };
    await poll();
  } catch (e) { show(`<span class="r">${esc(e.message)}</span>`); }
}

/** When the token's data was last synced and when it is next; "Sync now" reads it from the chain right away and re-runs the analysis. */
function syncBanner(t) {
  const due = t.next_process_ts != null && t.next_process_ts <= Date.now();
  let txt, cls = 'unrated';
  if (t.status === 'awaiting_pool') txt = 'Waiting for its pool: checked again every 10 minutes. Sync now looks for it right away.';
  else if (t.status === 'no_pool') txt = 'No pool found in its first week. Sync now looks for it again.';
  else if (t.status === 'skipped_quote') txt = 'Not synced: its pool is quoted in a token that cannot be valued in NEAR.';
  else if (!t.processed_ts) { txt = 'Not synced yet: queued for its first sync (the newest launches go first). Trades and early buyers appear after it.'; cls = 'win30'; }
  else if (t.status === 'done') {
    // first 24 h read (what verdicts use); the full ledger follows it up to today
    const L = t.ledger;
    txt = `Rug check uses every stored trade${t.outcome?.rug_basis?.trades != null ? ` (${n(t.outcome.rug_basis.trades, 0)})` : ''}; win / loss tags use the first 24 h · `;
    if (!L) txt += 'full ledger: queued, the newest tokens are read first';
    else if (L.error && !L.caught_up) txt += `full ledger: last pass failed (${L.error}), retried in ${ago(Math.max(0, (L.next_ts ?? Date.now()) - Date.now()))}`;
    else if (!L.caught_up) txt += `full ledger: reading, ${n(t.trades_n, 0)} trades so far, up to ${when(L.synced_to_ts)}`;
    else txt += `full ledger up to date · synced ${since(L.synced_ts)} · ${L.stopped ? `no longer followed (${L.stopped}): use Sync now to read it again` : `next sync in ${ago(Math.max(0, L.next_ts - Date.now()))}`}`;
    if (L?.caught_up) cls = 'win80';
  }
  else txt = `Last synced ${since(t.processed_ts)} · next sync ${due ? 'due now' : 'in ' + ago(t.next_process_ts - Date.now())}`;
  return `<div class="banner"><span class="v ${cls}">sync</span><div style="flex:1;min-width:0"><span class="small">${esc(txt)}</span><div id="fetchState" class="small"></div></div>${t.processed_ts ? `<button title="Re-apply the latest rug rules to every stored trade of this token (no chain reads)" onclick="reanalyse('${esc(t.id)}')">Re-analyse</button>` : ''}${t.status === 'skipped_quote' ? '' : `<button onclick="startFetch('${esc(t.id)}')">Sync now</button>`}</div>`;
}

async function tokenPage(id) {
  let t0;
  try { t0 = await get('/api/token', { id }); } catch (e) { if (/not found/.test(e.message)) return fetchPage(id); throw e; }
  const t = t0, o = t.outcome || {}, es = t.entries || [], au = t.audit;
  const mix = Object.fromEntries(MIXV.map(([v]) => [v, { w: 0, near: 0 }])), groups = new Map();
  for (const e of es) {
    const v = tagOk(e.tag);
    mix[v].w++; mix[v].near += e.buy_near || 0;
    if (e.cluster) { const g = groups.get(e.cluster.id) || { ...e.cluster, wallets: 0, near: 0, roi: [] }; g.wallets++; g.near += e.buy_near || 0; if (e.roi_now != null) g.roi.push([e.roi_now, e.buy_near]); groups.set(e.cluster.id, g); }
  }
  const total = mixTotal(mix), gl = [...groups.values()].sort((a, b) => b.near - a.near);
  const L = t.ledger, at24 = t.status === 'done'; // L: the full ledger, read past the first 24 h
  const riskCls = au?.available ? (au.risk_level === 'low' ? 'g' : au.risk_level === 'medium' ? 'a' : 'r') : 'muted';
  let h = `<div class="card">${crumbs([['Tokens', '/tokens'], [t.symbol || short(t.id, 20)]])}<div style="float:right;position:relative">${reportBtn('token', t.id)} ${watchBtn('token', t.id)}</div>
    <div class="dh-main">${avatar(t.id, t.symbol, 54)}<div style="min-width:0"><h1>${esc(t.symbol || short(t.id, 24))} <span class="muted">${esc(t.name || '')}</span> ${rugChips(o)} ${exitChip(o)}</h1>
      <div class="meta"><span class="chip">${esc(t.launchpad)}</span><span class="chip">${esc(t.status)}</span><span class="acct">${esc(t.id)}</span><span>live ${when(t.live_ts)} (${since(t.live_ts)})</span></div>
      <div class="meta"><span>creator ${t.creator ? ilink(P.creator(t.creator), esc(short(t.creator, 30)), t.creator) + ' ' + ext(nbAddr(t.creator), '↗', 'NearBlocks') + ' ' + crChip(t.creator_info) : '–'}</span><span>launch tx ${txl(t.live_tx)}</span>${ext(tokUrl(t.id, t.launchpad), 'Launchpad page ↗')}${ext(`${NB}/token/${encodeURIComponent(t.id)}`, 'NearBlocks ↗')}${ilink(P.audit(t.id), 'Full audit →')}</div></div></div>
    <div class="cta-row"><a class="cta" href="${esc(P.ana(t.id))}" onclick="return navA(event,this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>On-chain analysis →</a>
      <span class="cta-note">Launch, creator, flows, who bought early and the groups behind them, who sold, who holds, risk notes and the AI analyst.</span></div>
    <div class="tiles">${L?.last_multiple != null ? tile('All-time high', 'x' + n(L.ath_multiple, 1), `x${n(o.peak_multiple, 1)} in the first 24 h${L.ath_after_cp ? ' · ATH ' + since(L.ath_ts) : ''}`)
        + tile('Now', xm(L.last_multiple), `${L.drawdown != null ? pct(L.drawdown, L.drawdown > 0.99 ? 1 : 0) + ' below ATH · ' : ''}last trade ${since(L.last_trade_ts)}`, roiCls(L.last_multiple - 1))
        + tile('At 24 h', 'x' + n(o.last_multiple, 1), o.drawdown != null ? `drawdown ${pct(o.drawdown)} · what verdicts use` : 'what verdicts use', roiCls((o.last_multiple ?? 1) - 1))
      : tile('Peak', 'x' + n(o.peak_multiple, 1)) + tile(at24 ? 'At 24 h' : 'Now', 'x' + n(o.last_multiple, 1), o.drawdown != null ? `drawdown ${pct(o.drawdown)}` : null, roiCls((o.last_multiple ?? 1) - 1))}
      ${L?.last_multiple != null ? tile('Buyers (all time)', n(L.buyers, 0), `${n(L.buy_near, 0)} N in · ${n(L.sell_near, 0)} N out · ${n(L.trades, 0)} trades`) : tile('Buyers', o.buyers ?? '–', `${n(o.buy_near, 0)} N in · ${n(o.sell_near, 0)} N out`)}${tile('Early wallets', es.length, `${n(total, 0)} N in the first minutes`)}
      ${tile('From winners (win80 / win50 / sniper)', pct(total ? (mix.win80.near + mix.win50.near + mix.sniper.near) / total : null), `${mix.win80.w + mix.win50.w + mix.sniper.w} wallets`, 'g')}${tile('From loss wallets', pct(total ? mix.loss.near / total : null), `${mix.loss.w} wallets`, 'r')}${(() => { const rg = es.filter((e) => e.rugger), rn = rg.reduce((x, e) => x + (e.buy_near || 0), 0); return tile(`From ruggers ${RUG_ICON}`, pct(total ? rn / total : null), `${rg.length} wallets tied to rugs`, rg.length ? 'r' : 'g'); })()}
      ${(() => { const cs = creatorSale(o); return tile('Creator sold', cs.sold ? 'yes' : 'no', cs.sold ? n(cs.near, 1) + ' N' + (!cs.after ? ' · first 24 h' : cs.after >= cs.near ? ' · after 24 h' : ` · ${n(cs.after, 1)} after 24 h`) : o.rug_basis ? 'all stored trades' : null, cs.sold ? 'r' : 'g'); })()}${tile('Contract risk', au?.available ? au.risk_score : '–', au?.available ? au.risk_level : 'not audited', riskCls)}</div></div>`;
  h += syncBanner(t);
  if (L?.collapsed && !o.rugged) h += `<div class="card warn"><b>Collapsed after its first day.</b> The price is ${pct(L.drawdown, 1)} below its all-time high (${xm(L.ath_multiple)}, ${when(L.ath_ts)}) and now ${xm(L.last_multiple)} of launch. Verdicts and tags judge the first 24 h only, so they do not count this.</div>`;
  h += `<div class="grid2 wide-l"><div class="card"><h2>Early money by tag <span class="muted">who put NEAR in during the first minutes</span></h2>${mixBar(mix, 'lg')}${mixLegend(mix)}
      <h3>Groups in this token (${gl.length})</h3>${gl.length ? `<div class="glist">${gl.map((g) => { const r = wavg(g.roi); return `<div class="gitem" ${row(P.grp(g.id))}>${tg(g.tag)}<div style="min-width:0"><b>${esc(g.label || g.id)}</b><small>${g.wallets} of ${g.size} wallets · ${n(g.near, 1)} N (${pct(total ? g.near / total : null)})</small></div><span class="${roiCls(r)}" title="NEAR-weighted ROI now">${pct(r)}</span></div>`; }).join('')}</div>` : '<p class="muted">None of the early buyers belongs to a known group yet.</p>'}</div>
    <div class="card"><h2>Bubble map <span class="muted">early buyers clustered by group · size = NEAR in · click a bubble</span></h2>${bubbleMap(es)}
      <div class="legend">${MIXV.map(([v, l]) => `<span><span class="lg-dot ${v}"></span>${l}</span>`).join('')}<span><span class="lg-dot" style="background:transparent;box-shadow:inset 0 0 0 2px var(--bad)"></span>creator</span></div></div></div>`;
  h += `<div class="card"><h2>Early buyers <span class="muted">${es.length} wallets, by entry rank</span></h2><table><tr><th>#</th><th>Wallet</th><th>Tag</th><th>Group</th><th class="num">Delay</th><th>Buy tx</th><th class="num">NEAR in</th><th class="num">Wallet age</th><th>Funded by</th><th class="num">ROI 1h</th><th class="num">ROI 24h</th><th class="num" title="${L?.last_multiple != null ? 'ROI at the latest price (full ledger)' : at24 ? 'trades after 24 h are not read yet: this is the ROI at 24 h' : 'ROI at the latest price'}">${L?.last_multiple == null && at24 ? 'At 24 h' : 'Now'}</th></tr>
    ${es.map((e) => `<tr ${row(P.wal(e.wallet))}><td class="muted">${e.rank}</td><td>${walLink(e.wallet)}${e.is_creator ? ' <span class="v bad">creator</span>' : ''}${e.rugger ? ` <span class="v bad" title="a creator that rugged, or in a group that contains one or that are rug farmers">${RUG_ICON} rugger</span>` : ''}</td>
      <td>${tg(e.wallet_tag)} <span class="muted small">${pct(e.wallet_profit_rate)}</span></td><td>${e.cluster ? `${tg(e.cluster.tag)} ${ilink(P.grp(e.cluster.id), esc(short(e.cluster.label || e.cluster.id, 26)))} <span class="muted">(${e.cluster.size})</span>` : '<span class="muted">unlinked</span>'}</td><td class="num">${e.delay_s}s</td><td>${txl(e.first_buy_hash)}</td><td class="num">${n(e.buy_near, 1)}</td>
      <td class="num">${e.wallet_age_days != null ? e.wallet_age_days + ' d' : '–'}</td><td>${esc(e.funder_kind || '–')}</td><td class="num ${roiCls(e.roi?.['60'])}">${pct(e.roi?.['60'])}</td><td class="num ${roiCls(e.roi?.['1440'])}">${pct(e.roi?.['1440'])}</td><td class="num ${roiCls(e.roi_now)}">${pct(e.roi_now)}</td></tr>`).join('') || empty(12, 'no early buyers recorded')}</table></div>`;
  if (t.creator_info && (t.creator_info.launches > 1 || t.creator_info.blacklisted || t.creator_info.rugged)) {
    const ci = t.creator_info;
    h += `<div class="card"><div class="head"><h2>Creator <span class="muted">${ilink(P.creator(ci.account), esc(short(ci.account, 36)))}</span></h2>${ilink(P.creator(ci.account), 'All launches →')}</div>
      <p>${ci.launches} launches, <b class="${ci.rugged ? 'r' : ''}">${ci.rugged} rugged</b> ${crChip(ci)}${t.creator_wallet?.cluster_id ? ` · in group ${tg(t.creator_wallet.cluster_tag)} ${ilink(P.grp(t.creator_wallet.cluster_id), esc(short(t.creator_wallet.cluster_id, 20)))}` : ''}</p>
      ${ci.blacklisted ? `<p class="r">On the dev-rug blacklist${ci.blacklisted.reason ? ': ' + esc(ci.blacklisted.reason) : ''} <span class="muted">(${esc(ci.blacklisted.symbol || '')} · ${when(ci.blacklisted.ts)}${ci.blacklisted.source ? ' · ' + esc(ci.blacklisted.source) : ''})</span></p>` : ''}
      <div>${ci.tokens.filter((x) => x.id !== t.id).slice(0, 8).map((x) => `<a class="gchip" href="${esc(P.tok(x.id))}" onclick="return navA(event,this)"><i style="background:${x.rugged ? 'var(--loss)' : 'var(--unknown)'}"></i><span>${esc(x.symbol || short(x.id, 14))}${x.rugged ? ' · rug' : ''}</span></a>`).join('')}</div></div>`;
  }
  const cn = t.creator_network;
  if (t.scan && (t.scan.score != null || t.scan.stale || t.scan.error)) {
    const sc = t.scan;
    h += `<div class="card ${sc.pass === false ? 'err' : ''}"><div class="head"><h2>Scanner check ${sc.bought && SHOW_SIM ? '<span class="v good">bought (simulated)</span>' : sc.pass ? `<span class="v neutral">${SHOW_SIM ? 'passed, not bought' : 'gates passed'}</span>` : sc.pass === false ? '<span class="v bad">did not pass</span>' : ''}${sc.score != null ? ` <span class="muted">rule score ${esc(sc.score)}</span>` : ''}</h2>${sc.id ? ilink(P.scan(sc.id), 'Full evaluation →') : ''}</div>
      ${sc.pass === false || sc.stale || sc.error ? failReasons(sc) : `<p class="muted" style="margin-bottom:0">${esc(sc.decision || 'Passed every check.')}</p>`}</div>`;
  }
  if (t.creator && cn?.profiled) {
    const f = cn.funder, N = cn.network;
    h += `<div class="card ${N.ruggers ? 'warn' : ''}"><div class="head"><h2>Who is behind the creator</h2>${ilink(P.creator(t.creator), 'Creator network →')}</div>
      <p>${f ? `Funded by ${entAcct(f.account, f.label)} ${fundNote(f)} (hop ${f.hop}${f.near ? ', ' + n(f.near, 2) + ' N' : ''})${f.creators_funded_n > 1 ? ` · that account funded <b>${f.creators_funded_n}</b> token creators, <b class="${f.creators_rugged_n ? 'r' : ''}">${f.creators_rugged_n} of them rugged</b>` : ''}` : 'No funder found.'}</p>
      <p style="margin-bottom:0">${N.creators > 1 ? `<b>${N.creators - 1}</b> other creator(s) tied to it by funding or payments launched ${N.others_launches} tokens, <b class="${N.others_rugged ? 'r' : 'g'}">${N.others_rugged} rugged</b>${N.ruggers ? ` · ${N.ruggers} of those creators rugged` : ''}.` : 'No other token creator is tied to it.'}</p>
      ${cn.siblings.length ? `<div style="margin-top:8px">${cn.siblings.map((s) => `<a class="gchip" href="${esc(P.creator(s.account))}" onclick="return navA(event,this)" title="${esc(s.relations.map((r) => REL[r.type] || r.type).join(', '))}"><i style="background:${s.rugged || s.blacklisted ? 'var(--loss)' : 'var(--unknown)'}"></i><span>${esc(short(s.account, 22))} · ${s.rugged}/${s.launches}</span></a>`).join('')}</div>` : ''}</div>`;
  }
  if (o.rugged) h += `<div class="card err"><h2>Why it counts as rugged</h2><ul class="flags">${rugWhy(o, t.rug)}</ul></div>`;
  h += `<div class="card"><div class="head"><h2>Contract audit</h2>${ilink(P.audit(t.id), 'Open the full audit →')}</div>` + (au?.available ? `<p><span class="v ${riskCls === 'g' ? 'good' : riskCls === 'a' ? 'neutral' : 'bad'}">risk ${au.risk_score} · ${esc(au.risk_level)}</span> <span class="v ${au.trust_level === 'high' ? 'good' : 'unknown'}">trust ${au.trust_score}</span> · full-access keys ${au.full_access_keys ?? '–'} · ${(au.confirmed_malicious || []).length ? '<span class="r">confirmed: ' + au.confirmed_malicious.map((c) => esc(c.key)).join(', ') + '</span>' : 'no confirmed malicious finding'}</p>${(au.findings || []).length ? '<ul class="flags">' + au.findings.map((f) => `<li>${esc(f.key)}${f.weight != null ? ` (+${f.weight})` : ''}${f.detail ? ' <span class="muted">' + esc(f.detail) + '</span>' : ''}</li>`).join('') + '</ul>' : ''}` : '<p class="muted">Not audited yet.</p>') + '</div>';
  return h;
}

/** Bubble map: one bubble per early buyer (area ~ NEAR in), packed inside one circle per group, groups packed around the biggest. */
function bubbleMap(entries) {
  if (!entries.length) return '<p class="muted">no early buyers recorded</p>';
  const buckets = new Map();
  for (const e of entries) { const k = e.cluster ? e.cluster.id : ''; const b = buckets.get(k) || { key: k, c: e.cluster, items: [], near: 0 }; b.items.push(e); b.near += e.buy_near || 0; buckets.set(k, b); }
  const maxN = Math.max(...entries.map((e) => e.buy_near || 0), 0.01);
  const pack = (cs, gap) => { // greedy: biggest first, each next one at the first free spot on an outward spiral
    const done = [];
    for (const c of cs) {
      if (!done.length) { c.x = 0; c.y = 0; done.push(c); continue; }
      for (let a = 0; ; a += 0.2) { const d = 0.9 * a, x = d * Math.cos(a), y = d * Math.sin(a); if (done.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + c.r + gap)) { c.x = x; c.y = y; break; } }
      done.push(c);
    }
    return done;
  };
  const groups = [...buckets.values()].sort((a, b) => b.near - a.near).map((b) => {
    const cs = pack(b.items.map((e) => ({ e, r: 4 + 18 * Math.sqrt((e.buy_near || 0) / maxN) })).sort((x, y) => y.r - x.r), 1.5);
    return { ...b, cs, r: Math.max(...cs.map((c) => Math.hypot(c.x, c.y) + c.r)) + 7 };
  });
  pack(groups, 30);
  const x0 = Math.min(...groups.map((g) => g.x - g.r)) - 6, x1 = Math.max(...groups.map((g) => g.x + g.r)) + 6;
  const y0 = Math.min(...groups.map((g) => g.y - g.r)) - 20, y1 = Math.max(...groups.map((g) => g.y + g.r)) + 6;
  const W = Math.max(x1 - x0, 320), fs = Math.max(9, W / 85);
  const svg = groups.map((g) => {
    const v = g.c ? tagOk(g.c.tag) : 'solo', col = VCOL[v];
    const label = g.c ? `${short(g.c.label || g.c.id, 24)} · ${g.items.length}` : `unlinked · ${g.items.length}`;
    const ring = `<circle cx="${g.x}" cy="${g.y}" r="${g.r}" style="fill:${col};fill-opacity:.07;stroke:${col};stroke-opacity:.55" stroke-width="1.2" ${g.c ? '' : 'stroke-dasharray="4 4"'}/>`;
    const lbl = `<text x="${g.x}" y="${g.y - g.r - 5}" text-anchor="middle" font-size="${fs}" style="fill:var(--muted)" font-weight="600">${esc(label)}</text>`;
    const dots = g.cs.map((c) => `<a href="${esc(P.wal(c.e.wallet))}" onclick="return navA(event,this)"><circle cx="${g.x + c.x}" cy="${g.y + c.y}" r="${c.r}" style="fill:${VCOL[tagOk(c.e.tag)]}" fill-opacity="${g.c ? 0.85 : 0.9}" ${c.e.is_creator ? 'stroke="var(--bad)" stroke-width="2.5"' : ''}><title>${esc(c.e.wallet)}\n${n(c.e.buy_near, 2)} N in · rank #${c.e.rank} · ${c.e.delay_s}s after open\nROI now ${pct(c.e.roi_now)}\n${esc(tagOk(c.e.tag))}${g.c ? ' - group ' + esc(g.c.label || g.c.id) : ''}${c.e.is_creator ? '\nCREATOR' : ''}</title></circle></a>`).join('');
    return (g.c ? `<a href="${esc(P.grp(g.c.id))}" onclick="return navA(event,this)">${ring}${lbl}</a>` : ring + lbl) + dots;
  }).join('');
  return `<svg class="bubbles" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" preserveAspectRatio="xMidYMid meet">${svg}</svg>`;
}
