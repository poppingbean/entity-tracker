// ================================================================== on-chain analysis (a report per token, like the hand-written investigations)
const anaAcct = (a, known = true, k = 22) => (known ? walLink(a, k) : nb(a));
const grpChip = (g) => (g ? `${ilink(P.grp(g.id), esc(short(g.label || g.rule_tag || g.id, 30)), g.id)} ${tg(g.tag)}${g.rugger ? ' <span class="v bad">rugger</span>' : ''}` : '<span class="muted">–</span>');
const mins = (m) => (m == null ? '–' : m < 90 ? m + ' min' : m < 2880 ? (m / 60).toFixed(1) + ' h' : (m / 1440).toFixed(1) + ' d');
const FLAGCLS = { high: 'bad', medium: 'neutral', info: 'unrated' };
views.analysis = async () => {
  const t = await get('/api/tokens', { limit: 30 });
  return `<div class="card"><div class="bar"><input id="anaInput" type="search" style="flex:1;max-width:520px" placeholder="token account, e.g. three-de86d6.launchpad.justhoot.near" onkeydown="if(event.key==='Enter'&&this.value.trim())nav(null,P.ana(this.value.trim()))">
      <button class="btn" onclick="const v=$('anaInput').value.trim();if(v)nav(null,P.ana(v))">Analyse</button></div>
    <p class="muted" style="margin:0">Launch mechanics, the creator, price and flows, who bought early and which linked groups they belong to, repeat actors, who sold, the largest holders (checked live) and risk notes, with an optional NEAR AI assessment.</p></div>
  <div class="card"><h2>Recent launches</h2><table><tr><th>Token</th><th>Live</th><th class="num">Early</th><th class="num">Peak</th><th>Rug</th><th></th></tr>
    ${t.rows.map((x) => `<tr ${row(P.ana(x.id))}><td>${tokCell(x.id, x.symbol, x.launchpad)}</td><td>${since(x.live_ts)}</td><td class="num">${x.entries_n ?? '–'}</td><td class="num">${xm(x.outcome?.peak_multiple)}</td><td class="${x.outcome?.rugged ? 'r' : 'muted'}">${x.outcome?.rugged ? 'RUG' : '–'}</td><td>${ilink(P.ana(x.id), 'analysis →')}</td></tr>`).join('') || empty(6, 'no launches yet')}</table></div>`;
};
async function analysisPage(id, refresh) {
  const a = await get('/api/analysis', { id, refresh: refresh ? '1' : '' });
  const L = a.launch, C = a.creator, F = a.flows;
  let h = `<div class="card">${crumbs([['On-chain analysis', '/analysis'], [a.symbol || short(a.token, 24)]])}
    <div class="dh-main">${avatar(a.token, a.symbol, 54)}<div style="min-width:0"><h1>${esc(a.symbol ? '$' + a.symbol : a.token)} <span class="muted small">on-chain analysis</span></h1>
      <div class="meta"><span class="acct">${esc(a.token)}</span> ${ilink(P.tok(a.token), 'Token page →')} <span>built ${since(a.built_ts)} · data to ${when(a.data_to_ts)} · ${mins(a.age_min)} after launch</span>
      <button class="btn" onclick="this.disabled=true;$('main').classList.add('loading');analysisPage(${esc(JSON.stringify(a.token))},1).then((x)=>{$('main').innerHTML=x;$('main').classList.remove('loading');anaPoll(${esc(JSON.stringify(a.token))})})">Rebuild</button></div></div></div></div>`;
  // risk notes
  h += `<div class="card ${a.flags.some((f) => f.level === 'high') ? 'err' : a.flags.some((f) => f.level === 'medium') ? 'warn' : ''}"><h2>Risk notes</h2>${a.flags.length ? `<ul class="flags">${a.flags.map((f) => `<li><span class="v ${FLAGCLS[f.level]}">${f.level}</span> ${esc(f.text)}</li>`).join('')}</ul>` : '<p class="muted">Nothing flagged.</p>'}</div>`;
  h += `<div id="anaAi">${anaAiBody(a)}</div>`;
  // launch + creator
  const au = auShown(L.audit);
  h += `<div class="grid2"><div class="card"><h2>Launch mechanics</h2><div class="tiles">${tile('Launchpad', esc(L.launchpad || '–'), when(L.live_ts))}${tile('Supply', n(L.supply, 0))}${tile('Dev buy', L.dev_buy_near != null ? n(L.dev_buy_near, 2) + ' N' : '–')}
      ${tile('Pool', esc(L.pool ? `${L.pool.dex} · ${L.pool.quote === 'wrap.near' ? 'wNEAR' : L.pool.quote}` : '–'), L.lp_locked === true ? 'liquidity locked' : L.lp_locked === false ? 'liquidity NOT locked' : '', L.lp_locked === false ? 'r' : '')}
      ${tile('Tax', L.transfer_fee_pct != null ? 'transfer ' + L.transfer_fee_pct + '%' : [L.buy_tax_pct != null ? 'buy ' + L.buy_tax_pct + '%' : '', L.sell_tax_pct != null ? 'sell ' + L.sell_tax_pct + '%' : ''].filter(Boolean).join(' / ') || '–')}
      ${tile('Contract audit', au ? `risk ${au.risk_score} · ${esc(au.risk_level)}` : 'not audited', au ? `trust ${au.trust_score} · ${au.full_access_keys ?? '–'} full-access keys` : ilink(P.audit(a.token), 'run the audit →'), au?.risk_level === 'high' || au?.risk_level === 'critical' ? 'r' : '')}</div>
      ${au?.privileged_methods?.length ? `<p class="small muted">Owner / upgrade methods: ${au.privileged_methods.map((m) => `<code>${esc(m)}</code>`).join(' ')}</p>` : ''}${au?.confirmed_malicious?.length ? `<p class="r">Confirmed: ${esc(au.confirmed_malicious.join(', '))}</p>` : ''}
      ${L.live_tx ? `<p class="small muted">Launch tx ${txl(L.live_tx)}</p>` : ''}</div>`;
  h += C ? `<div class="card"><div class="head"><h2>Creator <span class="muted">${ilink(P.creator(C.account), esc(short(C.account, 30)))}</span></h2>${ilink(P.creator(C.account), 'All launches →')}</div>
      <div class="tiles">${tile('Wallet age at launch', C.age_days_at_launch == null ? '–' : C.age_days_at_launch < 1 ? n(C.age_days_at_launch * 24, 1) + ' h' : n(C.age_days_at_launch, 1) + ' d', C.tx_count != null ? C.tx_count + ' txs' : '')}
        ${tile('Earlier launches', C.earlier_launches ?? '–', C.earlier_rugged ? `${C.earlier_rugged} rugged` : 'none rugged', C.earlier_rugged ? 'r' : '')}${tile('Sold on the pool', C.traded ? n(C.traded.sell_near, 1) + ' N' : '0 N', C.traded?.first_sell_min != null ? `first sale ${mins(C.traded.first_sell_min)} after launch` : 'no sales', C.traded?.sell_near ? 'r' : 'g')}
        ${tile('Holds now', C.balance != null ? n(C.balance, 0) : '–', C.balance_share != null ? pct(C.balance_share, 1) + ' of supply' : '')}</div>
      ${C.blacklisted ? '<p class="r">On the dev-rug blacklist.</p>' : ''}${C.group ? `<p>Group: ${grpChip(C.group)}</p>` : ''}
      <table><tr><th>Funded by</th><th>Kind</th><th class="num">NEAR</th><th>When</th></tr>${(C.funders || []).map((f) => `<tr><td>${nb(f.account)}</td><td>${esc(f.kind || '–')}</td><td class="num">${n(f.near, 2)}</td><td>${when(f.ts)}</td></tr>`).join('') || empty(4, 'funding not traced yet')}</table>
      ${C.linked_creators?.length ? `<p class="small">Linked creators: ${C.linked_creators.map((x) => `${ilink(P.creator(x.account), esc(short(x.account, 20)))}${x.rugged ? ` <span class="r">(${x.rugged} rugged)</span>` : ''}`).join(', ')}</p>` : ''}</div></div>` : '<div class="card muted">Creator unknown.</div></div>';
  // price and flows
  h += `<div class="card"><h2>Price and flows</h2><div class="tiles">${tile('Peak', xm(F.peak_multiple), F.peak_min != null ? mins(F.peak_min) + ' after launch' : '')}${tile('Now', xm(F.now_multiple), F.drawdown_from_peak != null ? pct(F.drawdown_from_peak, 0) + ' below the peak' : '', roiCls((F.now_multiple ?? 1) - 1))}
      ${tile('Total volume', n(F.total.buy_near + F.total.sell_near, 0) + ' N', `${F.total.trades} trades · ${F.total.traders} traders`)}${F.via_intents ? tile('Through NEAR Intents', `${n(F.via_intents.buy_near, 0)} / ${n(F.via_intents.sell_near, 0)} N`, 'in-app buys / sells') : ''}</div>
    <table><tr><th>Window</th><th class="num">Buys</th><th class="num">Sells</th><th class="num">NEAR in</th><th class="num">NEAR out</th><th class="num">Buyers</th><th class="num">Sellers</th><th class="num">Net supply bought</th></tr>
      ${F.windows.map((w) => `<tr><td>first ${mins(w.minutes)}</td><td class="num">${w.buys}</td><td class="num">${w.sells}</td><td class="num">${n(w.buy_near, 1)}</td><td class="num">${n(w.sell_near, 1)}</td><td class="num">${w.buyers}</td><td class="num">${w.sellers}</td><td class="num">${pct(w.net_supply_share, 1)}</td></tr>`).join('')}</table></div>`;
  // who bought
  const E = a.early;
  h += `<div class="card"><h2>Who bought early <span class="muted">${E.wallets} wallets · ${n(E.near_in, 1)} N</span></h2><table><tr><th>#</th><th>Wallet</th><th class="num">Delay</th><th class="num">NEAR</th><th class="num">Supply</th><th class="num">ROI now</th><th class="num">Sold</th><th class="num">Age</th><th>Funded by</th><th>Tag</th><th>Group</th><th>Notes</th></tr>
    ${E.rows.map((e) => `<tr><td class="muted">${e.rank}</td><td>${anaAcct(e.wallet)}</td><td class="num">${e.delay_s}s</td><td class="num">${n(e.buy_near, 1)}</td><td class="num">${pct(e.supply_share, 2)}</td><td class="num ${roiCls(e.roi_now)}">${pct(e.roi_now)}</td><td class="num">${pct(e.sold_share_now, 0)}</td>
      <td class="num ${e.wallet_age_days != null && e.wallet_age_days < 3 ? 'r' : ''}">${e.wallet_age_days != null ? n(e.wallet_age_days, 1) + ' d' : '–'}</td><td>${e.funder ? `${nb(e.funder.account)} <span class="muted small">${esc(e.funder.kind || '')}</span>` : '–'}</td><td>${e.tag ? tg(e.tag) : '–'}</td><td>${grpChip(e.group)}</td><td class="small wrap">${esc(e.notes.join('; '))}</td></tr>`).join('') || empty(12, 'no early buyers recorded')}</table></div>`;
  // groups
  h += `<div class="card"><h2>Linked groups among the early buyers <span class="muted">wallets the tracker links by funding chains, money flow and synchronised buys</span></h2><table><tr><th>Group</th><th class="num">Wallets here</th><th class="num">NEAR in</th><th class="num">Share of early NEAR</th><th class="num">Supply bought</th><th class="num">Realized</th><th class="num">Unrealized</th><th>Record elsewhere</th><th>Members</th></tr>
    ${a.groups.map((g) => `<tr><td>${grpChip(g)}</td><td class="num">${g.members.length} / ${g.size}</td><td class="num">${n(g.near_in, 1)}</td><td class="num">${pct(g.early_near_share, 0)}</td><td class="num">${pct(g.supply_share, 2)}</td><td class="num ${roiCls(g.realized_now)}">${signed(g.realized_now)}</td><td class="num ${roiCls(g.unrealized_now)}">${signed(g.unrealized_now)}</td>
      <td class="small">${g.lifetime ? `${g.lifetime.tokens_n} tokens · ${pct(g.lifetime.profit_rate, 0)} in profit · ${signed(g.lifetime.pnl_near, 0)} N` : '–'}</td><td class="small wrap">${g.members.map((m) => ilink(P.wal(m), esc(short(m, 16)), m)).join(', ')}</td></tr>`).join('') || empty(9, 'no linked groups among the early buyers')}</table></div>`;
  // shared funders
  if (a.shared_funders.length) h += `<div class="card"><h2>Shared funders <span class="muted">one account funded several early buyers</span></h2><table><tr><th>Funder</th><th>Kind</th><th>Link</th><th>Wallets it funded</th><th>Same group in the tracker</th></tr>
    ${a.shared_funders.map((x) => `<tr><td>${nb(x.funder)}</td><td>${esc(x.kind || '–')}${x.tx_count != null ? ` <span class="muted small">${n(x.tx_count, 0)} txs</span>` : ''}</td><td><span class="v ${x.strength === 'strong' ? 'bad' : 'unrated'}">${x.strength}</span></td><td class="wrap">${x.wallets.map((w) => ilink(P.wal(w), esc(short(w, 18)), w)).join(', ')}</td><td>${x.same_group ? '<span class="g">yes</span>' : '<span class="muted">no</span>'}</td></tr>`).join('')}</table>
    <p class="small muted">Strong: a personal wallet funded them. Weak: an exchange or service wallet that funds many accounts.</p></div>`;
  // repeat actors
  h += `<div class="grid2"><div class="card"><h2>Repeat actors <span class="muted">early buyers seen early in other launches</span></h2><table><tr><th>Wallet</th><th class="num">#</th><th class="num">Other tokens</th><th class="num">In profit</th><th class="num">P&amp;L</th><th>Tag</th><th>Group</th></tr>
    ${a.repeat.map((x) => `<tr><td>${anaAcct(x.wallet, true, 18)}${x.rugger ? ' <span class="v bad">rugger</span>' : ''}</td><td class="num">${x.rank}</td><td class="num">${x.other_tokens}</td><td class="num">${pct(x.profit_rate, 0)}</td><td class="num ${roiCls(x.pnl_near)}">${signed(x.pnl_near, 0)}</td><td>${tg(x.tag)}</td><td>${grpChip(x.group)}</td></tr>`).join('') || empty(7, 'none')}</table></div>`;
  // sellers
  h += `<div class="card"><h2>Who sold <span class="muted">largest NEAR taken out</span></h2><table><tr><th>Account</th><th class="num">Bought</th><th class="num">Sold</th><th class="num">Net</th><th class="num">Early #</th><th>Group</th></tr>
    ${a.sellers.map((x) => `<tr><td>${anaAcct(x.account, x.known, 18)}${x.is_creator ? ' <span class="v bad">creator</span>' : ''}</td><td class="num">${n(x.buy_near, 1)}</td><td class="num">${n(x.sell_near, 1)}</td><td class="num ${roiCls(x.net_near)}">${signed(x.net_near)}</td><td class="num">${x.early_rank ?? '–'}</td><td>${grpChip(x.group)}</td></tr>`).join('') || empty(6, 'no sales yet')}</table></div></div>`;
  // where the tokens went: transfers out of the creator and the early buyers, hop by hop
  const TF = a.token_flows;
  if (TF) {
    const outc = { sold: '<span class="r">sold</span>', exchange: '<span class="v neutral">exchange</span>', 'passed on': '<span class="b">passed on</span>', kept: '<span class="muted">kept</span>' };
    h += `<div class="card"><h2>Where the tokens went <span class="muted">moved out by transfer (not sold) from the creator and early buyers, followed up to ${TF.hops} hops · ${n(TF.transfers, 0)} transfers stored</span></h2>
    ${TF.trails.map((t) => `<h3>${anaAcct(t.account, true, 22)} <span class="muted small">${esc(t.role)}${t.rank ? ' #' + t.rank : ''} · sent ${n(t.out_tokens, 0)} tokens${t.out_share != null ? ` (${pct(t.out_share, 2)} of supply)` : ''} · reached ${t.summary.accounts} account(s), ${t.summary.max_hop} hop(s)${t.summary.sold_near ? ` · <span class="r">${t.summary.sold_accounts} sold ${n(t.summary.sold_near, 1)} N</span>` : ''}</span></h3>
      <table><tr><th class="num">Hop</th><th>Account</th><th>From</th><th class="num">Tokens</th><th class="num">Supply</th><th>Then</th><th class="num">Sold</th><th>Group</th></tr>
      ${t.reached.slice(0, 25).map((x) => `<tr><td class="num">${x.hop}</td><td>${anaAcct(x.account, !!(x.tag || x.group), 20)}${x.label ? ` <span class="muted small">${esc(x.label)}</span>` : ''}</td><td>${anaAcct(x.from, true, 16)}</td><td class="num">${n(x.tokens, 0)}</td><td class="num">${pct(x.supply_share, 2)}</td><td>${outc[x.outcome] || esc(x.outcome)}</td><td class="num">${x.sold_near ? n(x.sold_near, 1) + ' N' : '–'}</td><td>${grpChip(x.group)}</td></tr>`).join('')}</table>`).join('') || '<p class="muted small">No tokens left the creator or the early buyers by transfer (only through trades).</p>'}
    <p class="small muted">"Sold" counts every sale of this token by that account on the pool. Transfers are read with the token's trades, so the trail is as complete as its ledger.</p></div>`;
  }
  // holders
  const H = a.holders;
  h += `<div class="card"><h2>Largest holders <span class="muted">${H.top10_share != null ? `top 10 hold ${pct(H.top10_share, 1)} of supply · ` : ''}balances read live with ft_balance_of</span></h2><table><tr><th>Account</th><th class="num">Tokens</th><th class="num">Supply</th><th>Checked</th><th class="num">Early #</th><th>Tag</th><th>Group</th></tr>
    ${H.rows.map((x) => `<tr><td>${anaAcct(x.account, x.known, 22)}${x.is_creator ? ' <span class="v neutral">creator</span>' : ''}</td><td class="num">${n(x.tokens ?? x.est_tokens, 0)}</td><td class="num">${pct(x.supply_share, 2)}</td><td>${x.verified ? '<span class="g">live</span>' : '<span class="muted">from trades</span>'}</td><td class="num">${x.early_rank ?? '–'}</td><td>${x.tag ? tg(x.tag) : '–'}</td><td>${grpChip(x.group)}</td></tr>`).join('') || empty(7, 'no holders found')}</table>
    <p class="small muted">The liquidity pool is not listed. Tokens moved by plain transfers are only seen in the live balances.</p></div>`;
  return h;
}
function anaAiBody(a) {
  const ai = a.ai, job = a.ai_job, running = !!job?.running, tok = esc(JSON.stringify(a.token || a.collection)), askFn = a.ai_kind === 'nft' ? 'nftAsk' : 'anaAsk';
  const btn = a.ai_enabled ? `<button ${running ? 'disabled' : ''} onclick="this.disabled=true;${askFn}(${tok})">${ai ? 'Update with the latest activity' : 'Ask the AI analyst'}</button>` : '';
  const checked = ai?.checked_ts && ai.checked_ts > ai.ts ? ai.checked_ts : null;
  const status = running ? `<p class="muted small">${ai ? `Updating the assessment with what changed since ${when(ai.ts)}` : 'Writing the assessment'} (started ${since(job.started)}${job.step ? ` · ${esc(job.step)}` : ''}; the latest trades are read first, then the review is written) …</p>`
    : job?.error ? `<p class="r small">Last run failed: ${esc(job.error)}</p>`
    : checked || job?.unchanged ? `<p class="muted small">No new on-chain activity since this assessment (checked ${since(checked || job.started)}).</p>` : '';
  const ul = (xs) => (xs?.length ? `<ul class="flags">${xs.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '');
  const risk = (lvl) => `<span class="v ${lvl === 'high' ? 'bad' : lvl === 'medium' ? 'neutral' : 'good'}">risk ${esc(lvl)}</span>`;
  if (!ai) return `<div class="card"><div class="head"><h2>AI analyst</h2>${btn}</div>${status}
    <p class="muted small">Runs only when asked. ${a.ai_kind === 'nft' ? "Every run first rebuilds the collection's figures from its latest mints, sales and transfers." : "Every run first reads the token's latest trades and follows tokens moved out by transfer (up to 5 hops)."} The first run writes an assessment from the figures below; every later run updates it with what changed on chain since the previous run.</p></div>`;
  let h = `<div class="card"><div class="head"><h2>NEAR AI analyst ${risk(ai.risk_level)}${ai.previous_risk && ai.previous_risk !== ai.risk_level ? ` <span class="muted small">was ${esc(ai.previous_risk)}</span>` : ''}
      <span class="muted small">${ai.mode === 'update' ? 'update' : 'first assessment'} · ${when(ai.ts)} · confidence ${n(ai.confidence, 2)} · NEAR AI</span></h2>${btn}</div>${status}`;
  if (ai.changes?.length) h += `<h3>Since the previous assessment <span class="muted small">${when(ai.since_ts)}${ai.window ? ` · ${ai.window.trades} trades · ${n(ai.window.buy_near, 1)} N in / ${n(ai.window.sell_near, 1)} N out` : ''}</span></h3>${ul(ai.changes)}`;
  h += `${ai.changes?.length ? '<h3>Current assessment</h3>' : ''}${ai.headline ? `<p><b>${esc(ai.headline)}</b></p>` : ''}<p>${esc(ai.summary)}</p>${ul(ai.findings)}<p><b>Conclusion.</b> ${esc(ai.conclusion)}</p>`;
  h += aiReport(ai.report) + aiPost(ai.telegram_post);
  const hist = a.ai_history || [];
  if (hist.length) h += `<details><summary class="muted small">Earlier runs (${hist.length}), kept with the figures they were written from</summary>${hist.map((x) => `<div style="margin:8px 0;padding-top:6px;border-top:1px solid var(--line)">
      <div class="small">${when(x.ts)} · ${x.mode === 'update' ? 'update' : 'first assessment'} · ${risk(x.risk_level)} <span class="muted">NEAR AI</span></div>
      ${x.changes?.length ? `<div class="small muted">Changes then:</div>${ul(x.changes)}` : ''}${x.headline ? `<p class="small"><b>${esc(x.headline)}</b></p>` : ''}<p class="small">${esc(x.summary)}</p>${ul(x.findings)}${aiPost(x.telegram_post)}<p class="small"><b>Conclusion.</b> ${esc(x.conclusion || '')}</p>
      <button onclick="anaRun(${esc(JSON.stringify(x.id))},this)">Show figures</button><div></div></div>`).join('')}</details>`;
  return h + '<p class="small muted">Written by the NEAR AI analyst from the figures on this page; check the tables before relying on it.</p></div>';
}
/** The analyst's full report (TrustFlow Research sections), with each cluster's evidence and whether it is proof or a pattern. */
const REPORT_SECTIONS = [['launch_safety', 'Launch and contract safety'], ['creator', 'Creator'], ['price_flows', 'Price and flows'], ['early_buyers', 'Early buyers and snipers'], ['holders', 'Holders'], ['repeat_actors', 'Repeat actors'], ['risk_notes', 'Risk notes']];
function aiReport(R) {
  if (!R) return '';
  const sec = (k, title) => (R[k] ? `<h4>${title}</h4><p class="small">${esc(R[k])}</p>` : '');
  const cl = R.clusters?.length ? `<h4>Clusters</h4><table class="small"><tr><th>Cluster</th><th>Wallets</th><th>Evidence</th><th>Strength</th></tr>${R.clusters.map((c) => `<tr><td>${esc(c.name)}${c.supply_share ? `<div class="muted">${esc(c.supply_share)}</div>` : ''}</td>
    <td class="wrap acct">${c.wallets.map(esc).join(', ')}</td><td class="wrap">${esc(c.evidence)}</td><td><span class="v ${c.strength === 'proof' ? 'bad' : 'neutral'}">${c.strength === 'proof' ? 'proof' : 'pattern, not proof'}</span></td></tr>`).join('')}</table>` : '';
  return `<details><summary><b>Full report</b> <span class="muted small">launch and safety, creator, price, early buyers, clusters with their evidence, holders, repeat actors, risks</span></summary>
    ${REPORT_SECTIONS.slice(0, 4).map(([k, t]) => sec(k, t)).join('')}${cl}${REPORT_SECTIONS.slice(4).map(([k, t]) => sec(k, t)).join('')}</details>`;
}
/** The Telegram post draft, ready to copy. */
function aiPost(post) {
  if (!post) return '';
  return `<details><summary><b>Telegram post</b> <span class="muted small">draft in house style</span></summary>
    <pre class="small" style="white-space:pre-wrap;user-select:all">${esc(post)}</pre><button onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent).then(()=>{this.textContent='Copied'})">Copy</button></details>`;
}
/** The figures an earlier run was written from (and, for an update, what changed in its window), shown under it. */
async function anaRun(id, btn) {
  const box = btn.nextElementSibling;
  if (box.innerHTML) { box.innerHTML = ''; btn.textContent = 'Show figures'; return; }
  const x = await get('/api/analysis-run', { id }).catch((e) => ({ error: e.message }));
  if (x.error) { box.innerHTML = `<p class="r small">${esc(x.error)}</p>`; return; }
  if (!x.snapshot) { box.innerHTML = '<p class="muted small">This run was written before runs were stored with their figures.</p>'; btn.textContent = 'Hide'; return; }
  if (x.snapshot.mint) { box.innerHTML = nftRunFigures(x); btn.textContent = 'Hide figures'; return; }
  const S = x.snapshot, F = S.flows || {}, T = x.since?.trades;
  let h = `<div class="tiles">${tile('Price then', xm(F.now_multiple), `peak ${xm(F.peak_multiple)}`)}${tile('Volume then', n((F.total?.buy_near || 0) + (F.total?.sell_near || 0), 0) + ' N', `${F.total?.trades ?? '–'} trades`)}
    ${tile('Early NEAR', n(S.early?.near_in, 1) + ' N', `${S.early?.wallets ?? '–'} wallets`)}${tile('Top 10 holders', pct(S.holders?.top10_share, 1))}${S.creator ? tile('Creator held', pct(S.creator.balance_share, 1), `sold ${n(S.creator.traded?.sell_near ?? 0, 1)} N`) : ''}
    ${T ? tile('Window', `${T.trades} trades`, `${n(T.buy_near, 1)} N in / ${n(T.sell_near, 1)} N out`) : ''}</div>`;
  if (T?.top_sellers?.length) h += `<div class="small"><b>Biggest sellers in the window:</b> ${T.top_sellers.slice(0, 5).map((y) => `${esc(y.account)} ${n(y.sell_near, 1)} N${y.group ? ` (${esc(y.group.label || y.group.id)})` : ''}`).join(', ')}</div>`;
  if (T?.top_buyers?.length) h += `<div class="small"><b>Biggest buyers in the window:</b> ${T.top_buyers.slice(0, 5).map((y) => `${esc(y.account)} ${n(y.buy_near, 1)} N${y.group ? ` (${esc(y.group.label || y.group.id)})` : ''}`).join(', ')}</div>`;
  if (S.flags?.length) h += `<div class="small"><b>Risk notes then:</b></div><ul class="flags small">${S.flags.map((f) => `<li><span class="v ${FLAGCLS[f.level]}">${f.level}</span> ${esc(f.text)}</li>`).join('')}</ul>`;
  if (S.holders?.rows?.length) h += `<div class="small"><b>Largest holders then:</b> ${S.holders.rows.slice(0, 6).map((y) => `${esc(y.account)} ${pct(y.supply_share, 1)}`).join(', ')}</div>`;
  box.innerHTML = h; btn.textContent = 'Hide figures';
}
/** An earlier NFT run's figures (and what changed in its window). */
function nftRunFigures(x) {
  const S = x.snapshot, M = S.market || {}, w = x.since;
  let h = `<div class="tiles">${tile('Minted then', n(S.mint?.minted, 0), `${n(S.mint?.raised_near, 0)} N raised`)}${tile('Sales then', n(M.sales, 0), `${n(M.volume_near, 0)} N volume`)}${tile('Floor (7 d)', M.floor_7d != null ? n(M.floor_7d, 2) + ' N' : '–')}
    ${tile('Suspected wash', n(M.wash?.sales, 0), M.wash?.share != null ? pct(M.wash.share, 0) + ' of volume' : '')}${tile('Top 10 holders', pct(S.holders?.top10_share, 1))}${w ? tile('Window', `${w.events} events`, `${w.mints.tokens} minted · ${w.sales.tokens} sold (${n(w.sales.near, 0)} N)`) : ''}</div>`;
  if (w?.sales?.top_buyers?.length) h += `<div class="small"><b>Biggest buyers in the window:</b> ${w.sales.top_buyers.map((y) => `${esc(y.wallet)} ${n(y.near, 1)} N`).join(', ')}</div>`;
  if (S.flags?.length) h += `<div class="small"><b>Risk notes then:</b></div><ul class="flags small">${S.flags.map((f) => `<li><span class="v ${FLAGCLS[f.level]}">${f.level}</span> ${esc(f.text)}</li>`).join('')}</ul>`;
  return h;
}
async function nftAsk(id) {
  const r = await get('/api/nft-ai', { id }).catch((e) => ({ error: e.message }));
  if (r.error) { $('anaAi').innerHTML = `<div class="card err">${esc(r.error)}</div>`; return; }
  nftPoll(id);
}
let nftTimer = null;
function nftPoll(id) {
  clearTimeout(nftTimer);
  const tick = async () => {
    if (!$('anaAi') || location.pathname !== P.nft(id)) return;
    const a = await get('/api/nft', { id }).catch(() => null);
    if (!a || a.error || !$('anaAi')) return;
    $('anaAi').innerHTML = anaAiBody(a);
    if (a.ai_job?.running) nftTimer = setTimeout(tick, 5000);
  };
  tick();
}
let anaTimer = null;
async function anaAsk(id) {
  const r = await get('/api/analysis-ai', { id }).catch((e) => ({ error: e.message }));
  if (r.error) { $('anaAi').innerHTML = `<div class="card err">${esc(r.error)}</div>`; return; }
  anaPoll(id);
}
/** While NEAR AI is writing, re-read the analysis every 5 s and show the assessment when it lands. */
function anaPoll(id) {
  clearTimeout(anaTimer);
  const tick = async () => {
    if (!$('anaAi') || location.pathname !== P.ana(id)) return;
    const a = await get('/api/analysis', { id }).catch(() => null);
    if (!a || !$('anaAi')) return;
    $('anaAi').innerHTML = anaAiBody(a);
    if (a.ai_job?.running) anaTimer = setTimeout(tick, 5000);
  };
  tick();
}
