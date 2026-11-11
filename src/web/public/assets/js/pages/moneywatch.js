// ================================================================== MONEY WATCH (every movement of $100k or more, followed until the reviewer calls it normal)
// Private: the dashboard only. A watch is not an accusation: nothing here is called a hack unless a person or a public report says so.
const MW_STATUS = { watching: ['neutral', 'Watching'], suspicious: ['bad', 'Looks suspicious'], normal: ['good', 'Normal'], confirmed: ['bad', 'Confirmed hack'] };
const MW_ORIGIN = { own_funds_withdrawal: 'withdrawal of its own deposit', routine_relationship: 'routine: paid by the same account before', exchange_withdrawal: 'exchange paying a customer', unusual_exchange_outflow: 'exchange paying an unusual amount', exchange_to_new_account: 'exchange paying a new account',
  fresh_receiver: 'brand-new receiver', protocol_payout: 'paid out by a protocol', established_accounts: 'old accounts, no earlier payments between them', no_history: 'no earlier history between them', reported_by_person: 'reported by a person' };
const mwUsd = (x) => (x == null ? '–' : '$' + Math.round(x).toLocaleString('en-US'));
const mwAcc = (a) => (/^reported$/.test(a) ? 'a person\'s report' : `<a href="https://nearblocks.io/address/${esc(a)}" target="_blank" rel="noopener" class="acct">${esc(short(a, 22))}</a>`);
const mwTag = (s) => { const [c, l] = MW_STATUS[s] || ['unrated', s]; return `<span class="chip ${c}">${esc(l)}</span>`; };
const mwPost = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tracker': '1' }, body: JSON.stringify(body) }).then((x) => x.json()).catch((e) => ({ error: e.message }));

async function mwReport() {
  const address = prompt('Report an address as part of a hack (a NEAR account or implicit address):', '');
  if (!address) return;
  const note = prompt('What do you know about it? (one line, optional)', '') || '';
  const source = prompt('Link to a public report (X post, news story), or leave blank. With a link the case is confirmed; without one the AI reviewer looks at it again with your note:', '') || '';
  if (source && !/^https?:\/\//i.test(source)) { alert('The link must start with https://'); return; }
  const r = await mwPost('/api/money-watch/report', { address, note, source });
  alert(r.error ? 'Error: ' + r.error : `Done (${r.where}). ${r.next || r.status || ''}`);
  render();
}

async function mwCase(id) {
  const box = document.getElementById('mw-detail');
  box.innerHTML = '<p class="muted">Loading…</p>';
  const j = await get('/api/money-watch/case', { id });
  if (j.error) { box.innerHTML = `<p class="muted">${esc(j.error)}</p>`; return; }
  const w = j.watch, o = w.origin;
  box.innerHTML = `<div class="card"><h2>${mwTag(w.status)} ${mwUsd(w.trigger.usd)} ${esc(w.trigger.symbol || w.trigger.token || '')} <span class="muted small">opened ${esc(when(w.opened_ts))}</span></h2>
    <p class="small">${mwAcc(w.trigger.from)} → ${mwAcc(w.trigger.to)} · ${w.trigger.tx && !/^reported:/.test(w.trigger.tx) ? `<a href="https://nearblocks.io/txns/${esc(w.trigger.tx)}" target="_blank" rel="noopener"><code>${esc(short(w.trigger.tx, 12))}</code></a>` : 'reported by a person'}${w.incident ? ` · <a href="/firewall/${encodeURIComponent(w.incident)}" onclick="return navA(event,this)">its incident</a>` : ''}</p>
    ${o ? `<p class="small"><b>Where the money came from:</b> ${esc(MW_ORIGIN[o.class] || o.class)} <span class="muted">(${esc((o.reasons || []).join('; '))})</span></p>` : '<p class="muted small">Not looked at yet.</p>'}
    <h3>Accounts watched</h3><table><tr><th>Account</th><th class="num">Hop</th><th class="num">Received</th><th class="num">Sent on</th><th>State</th></tr>
      ${(w.accounts || []).map((a) => `<tr><td>${mwAcc(a.account)}</td><td class="num">${a.depth}</td><td class="num">${mwUsd(a.in_usd)}</td><td class="num">${mwUsd(a.out_usd)}</td><td>${esc(a.state)}</td></tr>`).join('')}</table>
    <h3>Moves <span class="muted">(${(w.moves || []).length})</span></h3>${(w.moves || []).length ? `<table><tr><th>When</th><th>From</th><th>To</th><th class="num">USD</th><th>What happened</th></tr>
      ${(w.moves || []).slice(-40).reverse().map((m) => `<tr><td class="small">${esc(when(m.ts))}</td><td>${mwAcc(m.from)}</td><td>${mwAcc(m.to)}</td><td class="num">${mwUsd(m.usd)}</td><td class="small">${m.exit ? esc(m.exit.kind.replace(/_/g, ' ') + (m.exit.chain ? ' to ' + m.exit.chain : '') + (m.exit.label ? ' (' + m.exit.label + ')' : '')) : m.followed ? 'followed' : esc(m.why || '')}</td></tr>`).join('')}</table>` : '<p class="muted small">The money has not moved since.</p>'}
    <h3>Reviews</h3>${(w.reviews || []).length ? (w.reviews || []).slice().reverse().map((r) => `<p class="small"><b>${esc(String(r.verdict).replace(/_/g, ' '))}</b> <span class="muted">${esc(when(r.ts))} · by ${esc(r.by)}${r.confidence ? ' · ' + esc(r.confidence) + ' confidence' : ''}</span><br>${esc(r.what_it_is || '')}${(r.reasons || []).length ? '<br>' + (r.reasons || []).map((x) => '· ' + esc(x)).join('<br>') : ''}</p>`).join('') : '<p class="muted small">Not reviewed yet.</p>'}
    ${(w.reports || []).length ? `<h3>Reports from people</h3>${w.reports.map((r) => `<p class="small">${esc(when(r.ts))} · ${esc(r.by)}${r.source ? ` · <a href="${esc(r.source)}" target="_blank" rel="noopener">link</a>` : ''}<br>${esc(r.note || '')}</p>`).join('')}` : ''}
    <h3>History</h3><p class="small muted">${(w.status_history || []).map((h) => `${esc(h.status)} (${esc(h.by)}, ${esc(when(h.ts))})`).join(' → ')}</p></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

views.moneywatch = async () => {
  const st = new URLSearchParams(location.search).get('status') || '';
  const j = await get('/api/money-watch', { status: st });
  if (j.error) return `<div class="card"><p class="muted">${esc(j.error)}</p></div>`;
  const by = j.by || {}, n = (k) => by[k]?.n || 0;
  const tabs = ['', 'watching', 'suspicious', 'confirmed', 'normal'].map((k) => `<a class="chip ${k === st ? 'on' : ''}" href="/moneywatch${k ? '?status=' + k : ''}" onclick="return navA(event,this)">${k ? esc(MW_STATUS[k][1]) + ' ' + n(k) : 'All ' + (j.total && !st ? j.total : Object.values(by).reduce((s, x) => s + x.n, 0))}</a>`).join(' ');
  return `<div class="card"><div class="tiles">${tile('Watching', n('watching'), `${mwUsd(by.watching?.usd)} first movements`)}${tile('Look suspicious', n('suspicious'), 'an incident was opened', n('suspicious') ? 'r' : '')}${tile('Confirmed', n('confirmed'), 'by a person or a report')}${tile('Closed as normal', n('normal'), 'kept in the database')}
      ${tile('Opened, 24 h', j.opened_24h, `movements of ${mwUsd(j.min_usd)} or more`)}${tile('AI calls today', `${j.ai_calls_today} / ${j.ai_budget}`, 'its own budget')}</div>
    <p class="muted small" style="margin:8px 0 0">Every movement of ${mwUsd(j.min_usd)} or more, whatever the token, is watched: where the money came from, and where it goes next. A watch is not an accusation. It is closed as normal when the reviewer (rules first, then NEAR AI) says so, and stays here. ${j.enabled ? '' : '<b>The money watch is switched off (WATCH_ENABLED=false).</b>'}
    <button onclick="mwReport()" class="cta" style="margin-left:8px;padding:4px 10px">Report an address</button></p></div>
  <div class="card"><p>${tabs}</p>${j.rows.length ? `<table><tr><th>Opened</th><th>Status</th><th class="num">Movement</th><th>From → to</th><th>Where it came from</th><th class="num">Accounts</th><th>Last review</th></tr>
    ${j.rows.map((r) => `<tr style="cursor:pointer" data-id="${esc(r.id)}" onclick="mwCase(this.dataset.id)"><td class="small">${esc(when(r.opened_ts))}</td><td>${mwTag(r.status)}${r.reports ? ' <span class="chip" title="a person reported it">reported</span>' : ''}</td><td class="num">${mwUsd(r.usd)} <span class="muted small">${esc(r.token || '')}</span></td>
      <td class="small">${mwAcc(r.from)} → ${mwAcc(r.receiver)}</td><td class="small">${r.origin ? esc(MW_ORIGIN[r.origin] || r.origin) : '<span class="muted">not looked at yet</span>'}</td><td class="num">${r.active}/${r.accounts}${r.exits ? ` <span class="muted small">${r.exits} exit${r.exits === 1 ? '' : 's'}</span>` : ''}</td>
      <td class="small">${r.review ? `${esc(String(r.review.verdict).replace(/_/g, ' '))} <span class="muted">(${esc(r.review.by)})</span>` : '–'}</td></tr>`).join('')}</table>
    <p class="muted small">${j.total} watches${j.total > j.rows.length ? `, the newest ${j.rows.length} shown` : ''}. Click one for its accounts, moves and reviews.</p>` : '<p class="muted">No watches yet. The first one opens when a movement of ' + mwUsd(j.min_usd) + ' or more is seen on the chain.</p>'}</div>
  <div id="mw-detail"></div>`;
};
