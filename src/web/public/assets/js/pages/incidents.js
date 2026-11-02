// ================================================================== HACKS & INCIDENTS (traced exploits and drainers, live detection)
const INC_KIND = { exchange_drain: 'Exchange hot-wallet drain', protocol_exploit: 'Protocol exploit', wallet_drainer: 'Wallet drainer', suspicious_transfers: 'Suspicious transfers', none: '–' };
const INC_ROLE = { attacker: 'attacker', fake_token: 'fake token it deployed', sub_account: 'its sub-account', contract: 'contract it deployed', intents_account: 'its NEAR Intents account', cash_out_wallet: 'cash-out wallet', funder: 'funded the attacker' };
const usd = (x) => (x == null ? '–' : '$' + Math.round(x).toLocaleString('en-US'));
const amt = (x) => (x == null ? '–' : x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : Number(x).toLocaleString('en-US', { maximumFractionDigits: 3 }));
const nbTx = (h) => `<a href="https://nearblocks.io/txns/${esc(h)}" target="_blank" rel="noopener"><code>${esc(short(h, 12))}</code></a>`;
const nbAcc = (a) => (/^(chain|intents|mint|burn):/.test(a) ? `<code>${esc(short(a, 30))}</code>` : `<a href="https://nearblocks.io/address/${esc(a)}" target="_blank" rel="noopener" class="acct">${esc(short(a, 34))}</a>`);
const CHAIN_EXPLORER = { Ethereum: 'https://etherscan.io', Base: 'https://basescan.org', Arbitrum: 'https://arbiscan.io', 'BNB Chain': 'https://bscscan.com', Polygon: 'https://polygonscan.com', Optimism: 'https://optimistic.etherscan.io', Gnosis: 'https://gnosisscan.io', Avalanche: 'https://snowtrace.io', Berachain: 'https://berascan.com' };
const chainLink = (chain, kind, v) => {
  if (!v) return '–';
  const e = CHAIN_EXPLORER[chain];
  if (e) return `<a href="${e}/${kind}/${esc(v)}" target="_blank" rel="noopener"><code>${esc(short(v, 16))}</code></a>`;
  if (chain === 'Solana') return `<a href="https://solscan.io/${kind === 'tx' ? 'tx' : 'account'}/${esc(v)}" target="_blank" rel="noopener"><code>${esc(short(v, 16))}</code></a>`;
  if (chain === 'Bitcoin') return `<a href="https://mempool.space/${kind === 'tx' ? 'tx' : 'address'}/${esc(v)}" target="_blank" rel="noopener"><code>${esc(short(v, 16))}</code></a>`;
  if (chain === 'Tron') return `<a href="https://tronscan.org/#/${kind === 'tx' ? 'transaction' : 'address'}/${esc(v)}" target="_blank" rel="noopener"><code>${esc(short(v, 16))}</code></a>`;
  return `<code>${esc(short(v, 16))}</code>`;
};
const TAG = { 'drain?': ['neutral', 'Drain?'], review: ['neutral', 'Under review'], unconfirmed: ['neutral', 'Unconfirmed'], hack: ['bad', 'Hack'], safe: ['good', 'Safe'] };
const tagChip = (t) => { const [c, l] = TAG[t] || ['unknown', t]; return `<span class="v ${c}">${esc(l)}</span>`; };
/** A tag with its history: "Drain? → Safe". */
const tagTrail = (tags) => { const seq = []; for (const t of tags || []) if (seq[seq.length - 1] !== t) seq.push(t); return seq.map((t, i) => (i < seq.length - 1 ? `<span style="opacity:.55;text-decoration:line-through">${tagChip(t)}</span>` : tagChip(t))).join(' <span class="muted">→</span> '); };
/** An incident's tag now: only a confirmed case the deep review did not dispute is a Hack. */
const incTag = (d) => (d.status === 'confirmed' ? (d.review?.tag === 'review' ? 'review' : 'hack') : d.status === 'suspected' ? 'unconfirmed' : 'safe');
const incStatus = (s, d = null) => (d ? tagTrail([...(d.tags || []).map((t) => t.tag), incTag(d)]) : tagChip(s === 'confirmed' ? 'hack' : s === 'suspected' ? 'unconfirmed' : 'safe'));

// ---- one feature: the answer also shows the hacks it touches, can investigate one, and the live feed watches the chain
const INC_ROLE_TXT = { attack_tx: 'one of the attack transactions', attacker: 'the attacker', fake_token: 'a fake token the attacker made', sub_account: "the attacker's sub-account", contract: 'a contract the attacker deployed',
  cash_out_wallet: 'a wallet the stolen money went through', intents_account: "the attacker's NEAR Intents account", funder: 'the account that funded the attacker', target: 'the contract that was hit' };
function scIncidents(r) {
  let h = '';
  if (r.incidents?.length) h += `<div class="banner bad" style="margin:12px 0 0;display:block"><b>Linked to ${r.incidents.length > 1 ? `${r.incidents.length} hacks` : 'a hack'}</b>${r.incidents.map((i) => `<div class="small" style="margin-top:6px">This is <b>${esc(INC_ROLE_TXT[i.role] || i.role)}</b>${i.when ? ` (${when(i.when).split(',')[0]})` : ''}: ${esc(i.headline || `~${usd(i.stolen_usd)} taken from ${i.target || 'wallets'}`)}
      ${Object.keys(i.exits || {}).length ? `<div class="muted">Money went: ${Object.entries(i.exits).map(([k, v]) => `${esc(k)} ${usd(v)}`).join(', ')}${i.held_usd ? ` · ${usd(i.held_usd)} still on NEAR` : ''}</div>` : ''} ${ilink('/firewall/' + encodeURIComponent(i.id), 'Full investigation →')}</div>`).join('')}</div>`;
  const q = r.investigate?.q || (['contract', 'token', 'nft_collection'].includes(r.kind) && r.account ? 'target:' + r.account : null);
  if (q && !r.incidents?.some((i) => i.role === 'attack_tx' || i.role === 'target')) h += `<div class="bar" style="margin-top:12px"><button onclick="scInvestigate('${esc(q)}')">${r.investigate ? 'Investigate as a hack' : 'Look for hacks on this contract (last 24 h)'}</button><span class="muted small" id="scInv">${r.investigate ? 'Traces who got the money, where it went and who lost it (1-3 minutes).' : 'Finds who it paid the most and traces them.'}</span></div>`;
  return h;
}
let scInvTimer = null;
/** Investigate a hack from the check box (an account, a tx, or target:<contract>): runs the trace, then opens the investigation. */
async function scInvestigate(q, force) {
  clearTimeout(scInvTimer);
  const el = () => $('scInv') || $('scOut');
  const tick = async () => {
    const r = await fetch('/api/incident/investigate?' + new URLSearchParams({ q, run: '1', ...(force ? { force: '1' } : {}) })).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (!el()) return;
    if (r.error) { el().innerHTML = `<span class="r">${esc(r.error)}</span>`; return; }
    if (r.job?.running) { el().innerHTML = `<span class="muted">Tracing … ${esc(r.job.step || '')} (started ${since(r.job.started)})</span>`; scInvTimer = setTimeout(tick, 4000); return; }
    if (r.job?.error) { el().innerHTML = `<span class="r">The trace failed: ${esc(r.job.error)}</span>`; return; }
    const id = r.job?.id || r.existing;
    if (id) { history.pushState(null, '', '/firewall/' + encodeURIComponent(id)); render(); return; }
    el().innerHTML = '<span class="muted">No hack found: nobody took value from it for nothing in return.</span>';
  };
  tick();
}

// the live feed: what the chain watch saw, newest first, refreshed every 15 s while the page is open
const LIVE = { only: '' };
const LIVE_LVL = { critical: 'bad', high: 'bad', medium: 'neutral', low: 'good', info: 'unrated' };
async function liveFeed() {
  const el = $('liveFeed');
  if (!el) return;
  const j = await get('/api/security/live', { only: LIVE.only }).catch((e) => ({ error: e.message }));
  if (!$('liveFeed')) return;
  if (j.error) { el.innerHTML = `<div class="card err">${esc(j.error)}</div>`; return; }
  const W = j.watch, C = j.last24h;
  const status = j.live ? `<span class="dot ok"></span> Watching NEAR live · block ${Number(W.height).toLocaleString('en-US')}${W.behind > 5 ? `, ${W.behind} behind` : ''} · checked ${since(W.tick_ts)}`
    : `<span class="dot bad"></span> ${W ? `The chain watch stopped ${since(W.tick_ts)} (the worker is not running)` : 'The chain watch has not run yet (it runs in the worker)'}`;
  const tab = (v, l) => `<button class="${LIVE.only === v ? 'on' : ''}" style="${LIVE.only === v ? 'border-color:var(--accent)' : ''}" onclick="LIVE.only='${v}';liveFeed()">${l}</button>`;
  const item = (x) => {
    if (x.type === 'hack') return `<div class="lv" onclick="history.pushState(null,'','/firewall/${encodeURIComponent(x.id)}');render()" style="cursor:pointer"><span class="v bad">HACK</span> <b>${esc(x.attack_type || 'Exploit')}</b>${x.target ? ` on <span class="acct">${esc(short(x.target, 30))}</span>` : ''} · <b class="r">${usd(x.stolen_usd)}</b>${x.caught_live ? ' <span class="chip">caught live</span>' : ''}
      <div class="muted small">${esc(short(x.headline || `by ${x.attacker}`, 160))}${Object.keys(x.exits || {}).length ? ` · ${Object.entries(x.exits).map(([k, v]) => `${esc(k)} ${usd(v)}`).join(', ')}` : ''}</div></div>`;
    if (x.type === 'moved') return `<div class="lv" onclick="history.pushState(null,'','/firewall/${encodeURIComponent(x.incident)}');render()" style="cursor:pointer"><span class="v bad">MOVED</span> ${x.idle_h >= 24 ? `<b class="r">woke up after ${x.idle_h >= 48 ? Math.round(x.idle_h / 24) + ' days' : x.idle_h + ' h'}:</b> ` : ''}<b>${amt(x.amount)} ${esc(x.symbol)}</b> (${usd(x.usd)}) of stolen funds from <span class="acct">${esc(short(x.from, 18))}</span>
      <div class="muted small">to ${x.swap ? `a 1Click swap to ${esc(x.swap.asset)} on ${esc(x.swap.chain)}${x.swap.recipient ? ` (${esc(short(x.swap.recipient, 18))})` : ''}` : esc(short(x.to, 30))}</div></div>`;
    if (x.type === 'news') return `<div class="lv"><span class="v neutral">NEWS</span> <a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(short(x.title, 120))}</a>
      <div class="muted small">${esc(x.source)}${x.exchange ? ` · mentions ${esc(x.exchange)}` : ''}${(x.accounts || []).length ? ` · names ${x.accounts.map((a) => esc(short(a, 20))).join(', ')} (investigating)` : ''}</div></div>`;
    if (x.type === 'report') { const q = x.input?.account || x.input?.tx || (x.input?.target ? 'target:' + x.input.target : ''); return `<div class="lv" onclick="$('scInput').value='${esc(q)}';scCheck()" style="cursor:pointer"><span class="v unrated">REPORT</span> <span class="acct">${esc(short(q, 34))}</span>${x.count > 1 ? ` <span class="muted">· ${x.count} reports</span>` : ''}
      <div class="muted small">reported by people; investigated from the chain</div></div>`; }
    if (x.type === 'drain') {
      const tags = x.tags?.length ? x.tags : x.verdict === 'own_funds' ? ['drain?', 'safe'] : ['drain?'];
      const last = tags[tags.length - 1], due = (x.ts || 0) + 10 * 60e3;
      const note = last === 'safe' ? `<b class="g">not a hack</b>: ${esc(x.own || x.why || '')}` : last === 'hack' ? `<b class="r">confirmed</b> ${x.incident ? ilink('/firewall/' + encodeURIComponent(x.incident), 'investigation →') : ''}`
        : `${esc((x.reasons || []).slice(1).join('; '))}${Date.now() < due ? ` · deep review in ${Math.max(1, Math.round((due - Date.now()) / 60e3))} min` : x.why ? ` · ${esc(x.why)}` : ' · deep review pending'}`;
      return `<div class="lv" onclick="$('scInput').value='${esc(x.receiver)}';scCheck()" style="cursor:pointer">${tagTrail(tags)} <span class="acct">${esc(short(x.receiver, 26))}</span> took <b>${usd(x.usd)}</b> from ${x.kind === 'exchange' ? `<b>${esc(x.exchange || 'an exchange')}</b> hot wallet ` : ''}<span class="acct">${esc(short(x.protocol, 24))}</span>
      <div class="muted small">${note}</div></div>`;
    }
    return `<div class="lv" onclick="$('scInput').value='${esc(x.account)}';scCheck()" style="cursor:pointer"><span class="v ${x.level ? LIVE_LVL[x.level] || 'unrated' : 'unrated'}">${esc(x.level || (x.audited ? '–' : 'auditing'))}</span> New contract <span class="acct">${esc(short(x.account, 34))}</span>${x.label ? ` <span class="chip">${esc(x.label)}</span>` : ''}
      <div class="muted small">${esc(x.how)}${x.family_n > 1 ? ` (${x.family_n} accounts)` : ''} · by ${esc(short(x.by || '?', 24))}${x.control ? ` · ${esc(x.control)}` : ''}${x.headline ? ` · ${esc(short(x.headline, 110))}` : ''}</div></div>`;
  };
  // a refresh must not move what the reader is looking at: unchanged items only update the status and counts; new items keep the scroll
  const sig = LIVE.only + '|' + JSON.stringify(j.items.map((x) => [x.type, x.ts, x.id || x.account || x.receiver, x.verdict, (x.tags || []).join(), x.level, x.status]));
  const tiles = `${tile('Contracts deployed', C.deploys, 'last 24 h')}${tile('Audited', C.audited, `${C.risky} high risk`, C.risky ? 'a' : '')}${tile('Drains caught', C.drains, 'last 24 h', C.drains ? 'a' : '')}${tile('Hacks', C.hacks, `confirmed · ${C.moves || 0} moves of stolen funds`, C.hacks || C.moves ? 'r' : '')}`;
  const list = $('liveList');
  if (list && LIVE.sig === sig) { $('liveStatus').innerHTML = status; $('liveTiles').innerHTML = tiles; for (const t of list.querySelectorAll('.lvt')) if (t.dataset.ts) t.textContent = since(+t.dataset.ts).replace(' ago', ''); return; }
  const keep = list && LIVE.sigOnly === LIVE.only ? { top: list.scrollTop, height: list.scrollHeight } : null;
  LIVE.sig = sig; LIVE.sigOnly = LIVE.only;
  el.innerHTML = `<div class="card"><div class="bar"><h2 style="margin:0">Live</h2><span class="small" id="liveStatus">${status}</span></div>
    <div class="tiles" id="liveTiles" style="margin:10px 0">${tiles}</div>
    <div class="bar small" style="gap:6px">${tab('', 'Everything')}${tab('hacks', 'Hacks & drains')}${tab('risky', 'High-risk contracts')}${tab('contracts', 'New contracts')}<span class="spacer"></span><span class="muted">updates every 15 s</span></div>
    <div id="liveList" style="max-height:720px;overflow:auto;margin-top:6px">${j.items.map((x) => `<div style="display:flex;gap:10px;padding:8px 2px;border-bottom:1px solid var(--line)"><span class="muted small lvt" data-ts="${x.ts || ''}" style="width:64px;flex:none" title="${esc(when(x.ts))}">${esc(since(x.ts).replace(' ago', ''))}</span><div style="flex:1;min-width:0">${item(x)}</div></div>`).join('') || '<p class="muted small">Nothing yet.</p>'}</div></div>`;
  if (keep && keep.top > 0) { const nl = $('liveList'); if (nl) nl.scrollTop = keep.top + Math.max(0, nl.scrollHeight - keep.height); }
}
let liveTimer = null;
function liveStart() { clearInterval(liveTimer); liveFeed(); liveTimer = setInterval(() => { if (!$('liveFeed')) { clearInterval(liveTimer); return; } if (!document.hidden) liveFeed(); }, 15000); }

async function incidentPage(id) {
  const { incident: d, moved_from, live_moves } = await get('/api/incident', { id });
  const A = d.ai, T = d.trail || {}, ex = T.exits || [], drain = d.kind === 'exchange_drain';
  const offNear = ex.filter((e) => e.chain && e.chain !== 'NEAR').reduce((s, e) => s + (e.usd || 0), 0);
  const freezeUsd = (d.freezable || []).reduce((s, f) => s + (f.usd || 0), 0);
  const pasted = moved_from || d.pasted;
  let h = pasted && pasted !== d.attacker.account ? `<div class="banner neutral" style="display:block"><b>${esc(short(pasted, 40))}</b> is part of this incident: ${esc(INC_ROLE_TXT[(d.accounts || []).find((a) => a.account === pasted)?.role] || 'one of its wallets')}. The investigation follows the money from where it first arrived.</div>` : '';
  const isHack = incTag(d) === 'hack';
  h = `<div style="margin-bottom:10px"><a href="/firewall" onclick="return navA(event,this)" class="cta" style="padding:7px 14px;font-size:13px">← Safety Check</a></div>` + h;
  h += `<div class="card"><div class="bar"><h2 style="margin:0">${esc(incTag(d) === 'safe' ? `Not a hack${d.review?.ai?.what_it_is ? `: ${d.review.ai.what_it_is}` : ''}` : drain || !isHack ? `${INC_KIND[d.kind] || 'Incident'}${isHack ? '' : ' (not confirmed)'}` : A?.attack_type || INC_KIND[d.kind] || 'Incident')}${drain ? ` from ${esc(d.drain?.exchange || 'an exchange')}` : d.target?.account ? ` on ${esc(d.target.account)}` : ''}</h2>${incStatus(d.status, d)}${d.detected ? '<span class="chip">caught live</span>' : ''}<span class="spacer"></span>
      <span class="muted small">traced ${since(d.traced_ts)} · ${d.stats?.txs || 0} transactions read</span><button onclick="incRetrace('${esc(d.attacker.account)}', this)" ${retracing ? 'disabled' : ''}>${retracing ? 'Tracing …' : 'Trace again'}</button></div>
    <p style="font-size:16px;margin:10px 0"><b>${esc(incTag(d) === 'safe' ? `Checked: not a hack. ${d.review?.why || ''}` : A?.headline || d.signals?.[0] || '')}</b></p>
    <div class="tiles">${tile('Taken', usd(d.stolen_usd), esc(d.prices_note || ''), 'r')}${tile('Victims', (d.victims || []).length, (d.victims || []).filter((v) => !v.contract).length ? `${(d.victims || []).filter((v) => !v.contract).length} wallets` : 'contracts')}${tile('Attacker accounts', (d.accounts || []).length, `${(d.accounts || []).filter((a) => a.role === 'fake_token').length} fake tokens`)}
      ${tile('Sent off NEAR', usd(offNear), [...new Set(ex.filter((e) => e.chain && e.chain !== 'NEAR').map((e) => e.chain))].join(', ') || 'nothing yet', offNear ? 'r' : '')}${tile('Still held', usd(d.held_usd), 'on the attacker\'s NEAR accounts')}${tile('Freezable', usd(freezeUsd), freezeUsd ? 'an issuer can freeze it' : 'nothing an issuer can freeze', freezeUsd ? 'g' : '')}</div>
    <ul class="flags small" style="margin-top:10px">${(d.signals || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  const R = d.review;
  if (R) h += `<div class="card" style="border:2px solid var(--${R.tag === 'safe' ? 'good' : R.tag === 'hack' ? 'bad' : 'neutral'})"><div class="bar"><h2 style="margin:0">Deep review</h2>${tagChip(R.tag)}<span class="muted small">${since(R.ts)}${R.ai ? ` · NEAR AI: ${esc(R.ai.verdict.replace('_', ' '))}, ${esc(R.ai.confidence)} confidence` : ''}</span></div>
    <p><b>${esc(R.tag === 'safe' ? 'Not a hack' : R.tag === 'hack' ? 'Confirmed hack' : 'Not confirmed: still under review')}</b>: ${esc(R.why || '')}</p>
    ${R.ai?.reasons?.length ? `<ul class="small">${R.ai.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${R.past?.length ? `<table class="small"><tr><th>Who paid it</th><th class="num">Earlier transfers</th><th class="num">USD</th><th>Since</th></tr>${R.past.map((p) => `<tr><td class="acct">${esc(short(p.account, 30))}</td><td class="num">${p.n}</td><td class="num">${usd(p.usd)}</td><td>${p.first_ts ? new Date(p.first_ts).toISOString().slice(0, 10) : '–'}</td></tr>`).join('')}</table>` : ''}
    <p class="muted small" style="margin:6px 0 0">Run 10 minutes after the finding: the full trace again, the receiver's past with whoever paid it, then NEAR AI. A hack needs the rules' attacker signal; NEAR AI can clear an unconfirmed case.</p></div>`;
  else if (!isHack) h += `<div class="card"><p class="small" style="margin:0">${tagChip(incTag(d))} This case is not a confirmed hack. Its deep review runs 10 minutes after it was found.</p></div>`;
  if (A) h += `<div class="card"><div class="bar"><h2 style="margin:0">NEAR AI analyst</h2><span class="muted small">confidence ${esc(A.confidence)} · ${A.unverified_amounts?.length ? `<span class="r">unverified amounts: ${esc(A.unverified_amounts.join(', '))}</span>` : 'every amount checked against the evidence'}</span></div>
    <p>${esc(A.summary)}</p>
    <div class="grid2"><div><h3>How it worked</h3><ol class="small" style="padding-left:20px">${A.how_it_worked.map((s) => `<li style="margin:4px 0">${esc(s)}</li>`).join('')}</ol></div>
      <div><h3>Impact</h3><p class="small">${esc(A.impact)}</p><h3>Where the money went</h3><p class="small">${esc(A.money_trail)}</p><h3>What can still be done</h3><p class="small">${esc(A.still_recoverable)}</p></div></div>
    <div class="grid2"><div><h3>Recommendations</h3><ul class="small">${A.recommendations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div><div><h3>Open questions</h3><ul class="small muted">${A.open_questions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div></div>
    <p class="muted small" style="margin:0">Written from the traced evidence below; the numbers, status and flags come from the rules.</p></div>`;
  // losses and victims
  h += `<div class="grid2"><div class="card"><h2>What was taken <span class="muted">${esc(drain ? `${(d.victims || []).filter((v) => v.exchange).length} hot wallets` : d.target?.account || '')}</span></h2><table class="small"><tr><th>Token</th><th class="num">Amount</th><th class="num">USD</th></tr>
      ${(drain ? Object.values((d.victims || []).filter((v) => v.exchange).flatMap((v) => v.tokens).reduce((m, t) => { const k = t.symbol; m[k] = m[k] || { ...t, amount: 0, usd: 0 }; m[k].amount += t.amount || 0; m[k].usd += t.usd || 0; return m; }, {})) : d.losses || []).map((l) => `<tr><td>${esc(l.symbol)} <span class="muted">${esc(short(l.token, 28))}</span></td><td class="num">${amt(l.amount)}</td><td class="num">${usd(l.usd)}</td></tr>`).join('') || empty(3, '–')}</table></div>
    <div class="card"><h2>Victims <span class="muted">who lost value to the attacker</span></h2><table class="small"><tr><th>Account</th><th>Kind</th><th class="num">Lost</th><th>Transactions</th></tr>
      ${(d.victims || []).map((v) => `<tr><td>${nbAcc(v.account)}${v.label ? ` <span class="muted">${esc(v.label)}</span>` : ''}</td><td>${v.exchange ? `exchange hot wallet${v.how ? `<div class="muted">${esc(v.how)}</div>` : ''}` : v.contract ? 'contract (its users / liquidity providers)' : 'wallet'}</td><td class="num r">${usd(v.lost_usd)}</td><td>${(v.txs || []).slice(0, 3).map(nbTx).join(' ')}</td></tr>`).join('') || empty(4, '–')}</table></div></div>`;
  // the money moving now: every transfer out of the incident's accounts since it was traced, seen block by block
  h += `<div class="card"><h2>Live: stolen funds moving <span class="muted">${(live_moves || []).length ? `${live_moves.length} move${live_moves.length > 1 ? 's' : ''} seen as they happened` : 'watched block by block'}</span></h2>
    ${(live_moves || []).length ? `<table class="small"><tr><th>When</th><th>From</th><th>To</th><th class="num">Amount</th><th class="num">USD</th><th>Idle before</th><th>Tx</th></tr>${live_moves.map((m) => `<tr><td>${when(m.ts)}</td><td>${nbAcc(m.from)}</td><td>${m.swap ? `1Click → ${esc(m.swap.asset)} on ${esc(m.swap.chain)}${m.swap.recipient ? `<div>${chainLink(m.swap.chain, 'address', m.swap.recipient)}</div>` : ''}` : nbAcc(m.to)}</td><td class="num">${amt(m.amount)} ${esc(m.symbol)}</td><td class="num">${usd(m.usd)}</td><td>${m.idle_h != null ? (m.idle_h >= 48 ? Math.round(m.idle_h / 24) + ' days' : m.idle_h + ' h') : '–'}</td><td>${nbTx(m.tx)}</td></tr>`).join('')}</table>`
    : `<p class="muted small" style="margin:0">Every account of this incident is watched: the next transfer out of any of them raises an alert at once, the receiver is flagged and followed, and the trace is redone.</p>`}</div>`;
  // where the money came from (the upstream trace), origin first
  const SRC_KIND = { exchange: 'exchange', contract: 'contract', wallet: 'wallet' };
  if ((d.sources || []).length) h += `<div class="card"><h2>Where the money came from <span class="muted">followed back from ${esc(short(pasted || d.attacker.account, 30))}</span></h2>
    <table class="small"><tr><th>Hop</th><th>From</th><th>What it is</th><th></th><th>To</th><th class="num">Amount</th><th class="num">USD</th><th>When</th><th>Transactions</th></tr>
    ${[...d.sources].sort((a, b) => b.hop - a.hop || b.usd - a.usd).map((x) => `<tr><td>${x.hop}</td><td>${nbAcc(x.account)}</td><td><span class="v ${x.kind === 'exchange' ? 'neutral' : 'unrated'}">${esc(SRC_KIND[x.kind] || x.kind)}</span> <b>${esc(x.name || '')}</b>${x.how ? `<div class="muted">${esc(x.how)}${x.tx_count ? '' : ''}</div>` : ''}</td><td>→</td><td>${nbAcc(x.to)}</td>
      <td class="num">${(x.tokens || []).map((t) => `${amt(t.amount)} ${esc(t.symbol)}`).join('<br>')}</td><td class="num">${usd(x.usd)}</td><td>${when(x.first_ts)}</td><td>${(x.txs || []).slice(0, 3).map(nbTx).join(' ')}</td></tr>`).join('')}</table>
    ${drain ? `<p class="small" style="margin:8px 0 0">The hot wallets sent the money to <b>${esc(short(d.attacker.account, 40))}</b>, ${esc((d.signals || [])[0]?.includes('created by the first') ? 'an account created by the first of these transfers' : 'an account created just before')}. That is where the investigation starts; every wallet it paid out to is followed below.</p>` : ''}</div>`;
  // money trail
  h += `<div class="card"><h2>Where the money went</h2>${T.capped ? `<p class="muted small" style="margin-top:0">Partial trail (${esc(T.capped)}): this account pays many others, so only the largest moves were followed.</p>` : ''}
    ${ex.length ? `<table class="small"><tr><th>When</th><th>What</th><th class="num">Sent</th><th class="num">USD</th><th>Recipient</th><th>Received</th><th>Transactions</th></tr>${ex.map((e) => `<tr><td>${when(e.ts)}</td><td><b>${esc(e.kind)}</b>${e.deposit_address ? `<div class="muted">1Click deposit ${esc(short(e.deposit_address, 14))}</div>` : ''}</td><td class="num">${amt(e.amount)} ${esc(e.symbol)}</td><td class="num">${usd(e.usd)}</td>
      <td>${e.recipient ? chainLink(e.chain, 'address', e.recipient) : nbAcc(e.to)}</td><td>${e.amount_out ? `${amt(Number(e.amount_out))} ${esc(e.asset || '')}` : '–'}</td><td>${nbTx(e.tx)}${(e.dest_txs || []).map((x) => ' → ' + chainLink(e.chain, 'tx', x)).join('')}</td></tr>`).join('')}</table>` : '<p class="muted small">No exit found yet: the money is still on NEAR (see the hops below).</p>'}
    <details style="margin-top:10px"><summary class="small">Every hop (${(T.moves || []).length})</summary><table class="small"><tr><th>When</th><th>Hop</th><th>From</th><th>To</th><th class="num">Amount</th><th class="num">USD</th><th>Where</th><th>Tx</th></tr>
      ${(T.moves || []).map((m) => `<tr><td>${when(m.ts)}</td><td>${m.hop}</td><td>${nbAcc(m.from)}</td><td>${nbAcc(m.to)}</td><td class="num">${amt(m.amount)} ${esc(m.symbol)}</td><td class="num">${usd(m.usd)}</td><td>${esc(m.dest_kind)}</td><td>${nbTx(m.tx)}</td></tr>`).join('')}</table></details></div>`;
  // accounts, holdings
  h += `<div class="grid2"><div class="card"><h2>Attacker's accounts <span class="muted">${(d.accounts || []).length}</span></h2>
      <p class="small muted" style="margin-top:0">${d.attacker.creator ? `${esc(d.attacker.account)} was created by ${esc(d.attacker.creator.by)}${d.attacker.creator.signer !== d.attacker.creator.by ? ` (signed by ${esc(d.attacker.creator.signer)})` : ''} ${d.attacker.created_ts ? when(d.attacker.created_ts) : ''}.` : ''} These accounts are flagged: Safety Check and the transaction firewall warn about any transaction that touches them.</p>
      <table class="small"><tr><th>Account</th><th>Role</th></tr>${(d.accounts || []).map((a) => `<tr><td>${nbAcc(a.account)}</td><td>${esc(INC_ROLE[a.role] || a.role)}</td></tr>`).join('')}</table></div>
    <div class="card"><h2>Still held <span class="muted">${usd(d.held_usd)}</span></h2>
      ${(d.held || []).length ? (d.held || []).map((x) => `<p class="small" style="margin:6px 0 2px"><b>${nbAcc(x.account)}</b> ${usd(x.usd)}</p><table class="small">${x.tokens.map((t) => `<tr><td>${esc(t.symbol)}</td><td class="num">${amt(t.amount)}</td><td class="num">${usd(t.usd)}</td><td class="${t.freeze ? 'g' : 'muted'}">${esc(t.freeze || '')}</td></tr>`).join('')}</table>`).join('') : '<p class="muted small">Nothing left on the attacker\'s NEAR accounts.</p>'}</div></div>`;
  // attack transactions, timeline
  h += `<div class="card"><h2>Attack transactions</h2><table class="small"><tr><th>When</th><th>Tx</th><th>Called</th></tr>${(d.attack_txs || []).map((t) => `<tr><td>${when(t.ts)}</td><td>${nbTx(t.tx)}</td><td class="wrap"><code>${esc(t.receiver)}</code>: ${esc(t.methods.join(', '))}<details><summary class="muted">arguments</summary><pre class="small" style="white-space:pre-wrap;max-height:260px;overflow:auto">${esc(JSON.stringify(t.args, null, 1))}</pre></details></td></tr>`).join('') || empty(3, '–')}</table></div>
    <div class="card"><h2>Timeline</h2><table class="small">${(d.timeline || []).map((e) => `<tr><td style="white-space:nowrap">${when(e.ts)}</td><td><span class="chip">${esc(e.kind.replace('_', ' '))}</span></td><td class="wrap">${esc(e.text)}</td><td>${e.tx ? nbTx(e.tx) : ''}</td></tr>`).join('')}</table></div>`;
  return h;
}
let retracing = null;
async function incRetrace(account, btn) {
  if (retracing) return; // one trace at a time
  retracing = account;
  if (btn) { btn.disabled = true; btn.textContent = 'Tracing …'; }
  const status = (t) => { const el = $('incRe') || ($('main').insertAdjacentHTML('afterbegin', '<div class="card muted" id="incRe"></div>'), $('incRe')); el.textContent = t; };
  status('Tracing again (1-3 minutes) …');
  const q = new URLSearchParams({ q: account });
  try {
    let r = await fetch('/api/incident/investigate?' + new URLSearchParams({ q: account, run: '1', force: '1' })).then((x) => x.json());
    if (r.error) { status(r.error); return; }
    while (true) {
      await new Promise((res) => setTimeout(res, 4000));
      r = await fetch('/api/incident/investigate?' + q).then((x) => x.json());
      if (!r.job?.running) break;
      status(`Tracing again … ${r.job.step || ''} (started ${since(r.job.started)})`);
    }
    if (r.job?.error) { status(`The trace failed: ${r.job.error}`); return; }
    render();
  } finally { retracing = null; }
}
