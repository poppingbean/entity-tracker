// ================================================================== EXPLORE
const ASSESS = { rugger: ['r', 'Rugger in'], bullish: ['g', 'Winners in'], warning: ['r', 'Loss wallets in'], mixed: ['a', 'Mixed money'] };
// Creator sales over every stored trade (what the rug check uses); falls back to the 24 h fields on old outcomes.
const creatorSale = (o) => {
  const b = o?.rug_basis;
  if (!b) return { sold: !!o?.creator_sold, near: o?.creator_sell_near || 0, after: 0 };
  return { sold: !!b.creator_sold, near: b.creator_sell_near || 0, after: b.creator_sell_after_24h_near || 0 };
};
const rugKind = { creator_exit: 'creator exit', round_trip: 'round trip', price_crash: 'price crash', creator_dump: 'creator dump', creator_sold: 'creator sold', flagged: 'dev rug (blacklist)' };
/** The creator sold (most of) their dev buy within the first hour: a warning, not a rug by itself. */
const exitChip = (o) => {
  const x = o?.creator_exit;
  if (x === true) return '<span class="v neutral">creator exit</span>';
  return x && x.share >= 0.8 && !(o.rug_kinds || []).includes('creator_exit') ? `<span class="v neutral" title="sold ${n(x.sold_near, 1)} N of a ${n(x.dev_buy_near, 1)} N dev buy within the first hour; first sale ${x.minutes} min after launch">creator exit · ${x.minutes} min</span>` : '';
};
/** Why a token counts as rugged, in plain words with its own on-chain numbers (no rule thresholds: safe on the public dashboard). */
function rugWhy(o, rug) {
  const b = o.rug_basis || o; // the all-time numbers the rug rules used (older outcomes: the 24 h ones)
  const after = o.rug_basis?.creator_sell_after_24h_near || 0, first = o.creator_sold ? o.creator_sell_near || 0 : 0;
  const lines = (o.rug_kinds || []).map((k) => {
    const txt = k === 'price_crash' ? `The price collapsed: it fell ${pct(b.drawdown)} from its peak (x${n(b.peak_multiple, 1)} of launch${b.peak_ts ? ', ' + when(b.peak_ts) : ''}) to x${n(b.last_multiple, 2)}.`
      : k === 'creator_dump' ? `The price fell ${pct(b.drawdown)} from its peak while the creator sold ${n(b.creator_sell_near, 2)} N of the token.`
      : k === 'round_trip' ? `It pumped to x${n(b.peak_multiple, 1)} of its launch price and came back to x${n(b.last_multiple, 2)}: everyone who bought after launch is flat or under.`
      : k === 'creator_exit' ? `The creator sold ${o.creator_exit && o.creator_exit !== true ? pct(o.creator_exit.share) + ' of' : 'most of'} their dev buy within the first hour${o.creator_exit?.minutes != null ? ` (first sale ${o.creator_exit.minutes} min after launch)` : ''}, and the price is back near launch (x${n(b.last_multiple, 2)}).`
      : k === 'creator_sold' ? ([first ? `${n(first, 2)} N in the first 24 h` : '', after ? `${n(after, 2)} N after the first 24 h` : ''].filter(Boolean).length ? `The creator sold their own token: ${[first ? `${n(first, 2)} N in the first 24 h` : '', after ? `${n(after, 2)} N after the first 24 h` : ''].filter(Boolean).join(' and ')}.` : rug?.source === 'ledger' && rug.reason ? `The creator ${rug.reason}.` : 'The creator sold some of their own token.')
      : k === 'flagged' ? `The creator is on the dev-rug blacklist: their token balance dropped while the token was being held${o.rug_reason ? ` (${o.rug_reason})` : ''}.`
      : 'Flagged as rugged.';
    return `<li><b>${esc(rugKind[k] || k)}</b> · ${esc(txt)}</li>`;
  });
  if (!lines.length) lines.push(`<li>${rug?.source === 'blacklist' ? 'The creator is on the dev-rug blacklist: their token balance dropped while the token was being held.' : 'Flagged as rugged. Use Re-analyse to apply the latest rules.'}</li>`);
  if (o.rug_basis?.trades != null) lines.push(`<li class="muted small">Judged on all ${n(o.rug_basis.trades, 0)} stored trades${o.rug_basis.last_trade_ts ? ', up to ' + when(o.rug_basis.last_trade_ts) : ''}.</li>`);
  return lines.join('');
}
const rugChips = (o) => (o?.rugged ? (o.rug_kinds?.length ? o.rug_kinds : ['rug']).map((k) => `<span class="v bad" title="${esc(o.rug_reason || 'rugged')}">${esc(rugKind[k] || 'rug')}</span>`).join(' ') : '');
/** A token's latest multiple: today's price once its full ledger is read, otherwise the 24 h one (marked "24h" once that window is over). */
const xm = (m) => 'x' + n(m, m != null && m < 0.1 ? 3 : m != null && m < 10 ? 2 : 1); // a price multiple: a dead token still reads as x0.004, not x0
const nowX = (m, at24) => `<span class="${roiCls((m ?? 1) - 1)}"${at24 ? ' title="price at 24 h: trades after the first day are not read yet"' : ''}>${xm(m)}${at24 ? '<small class="muted"> 24h</small>' : ''}</span>`;
const nowOf = (t) => (t?.ledger?.last_multiple != null ? nowX(t.ledger.last_multiple, false) : nowX(t?.outcome?.last_multiple, t?.status === 'done'));
const outcomeTxt = (o) => (o ? (o.rugged ? '<span class="r">RUG</span> ' : '') + (o.now_multiple != null ? nowX(o.now_multiple, false) : nowX(o.last_multiple, o.done)) : '–');
const signalCard = (s) => `<div class="tcard" ${row(P.tok(s.token))}>
  <div class="tc-top">${tokCell(s.token, s.symbol, s.launchpad, 22)}<span class="badge ${ASSESS[s.assessment][0]}">${ASSESS[s.assessment][1]}</span></div>
  ${mixBar(s.mix)}
  <div class="tc-stats"><span><small>Early</small><b>${s.early_wallets}w · ${n(s.total_near, 0)} N</b></span><span><small>Winners</small><b class="g">${pct(s.win_share)}</b></span><span><small>Loss</small><b class="r">${pct(s.loss_share)}</b></span><span><small>Now</small><b>${outcomeTxt(s.outcome)}</b></span></div>
  ${s.rugger?.w ? `<div class="rugline" title="token creators that rugged or are blacklisted, and wallets in groups that contain one or that are rug farmers">${RUG_ICON} ${s.rugger.w} rugger${s.rugger.w > 1 ? 's' : ''} in early · ${n(s.rugger.near, 0)} N · ${pct(s.rugger_share)}</div>` : ''}
  <div class="tc-groups">${s.groups.slice(0, 4).map(gchip).join('')}</div>
  <div class="muted small">${esc(s.launchpad)} · live ${since(s.live_ts)}</div></div>`;
const groupMini = (rows, empty_) => `<table><tr><th>Group</th><th>Tag</th><th class="num">Wallets</th><th class="num">Tokens</th><th class="num">Profitable</th><th class="num">Rug</th><th class="num">P&amp;L N</th></tr>
  ${rows.map((c) => `<tr ${row(P.grp(c.id))}><td><span class="ent">${avatar(c.id, c.ai?.label || c.id, 26)}<span><b>${ilink(P.grp(c.id), esc(short(c.ai?.label || (c.rule?.tags || [])[0] || c.id, 30)))}</b><small class="acct">${esc(short(c.id, 22))}</small></span></span></td>
    <td>${tg(c.tag)}</td><td class="num">${c.size}</td><td class="num">${c.metrics?.tokens_n ?? '–'}</td><td class="num">${pct(c.metrics?.profit_rate)}</td><td class="num">${pct(c.metrics?.rug_share)}</td><td class="num ${roiCls(c.metrics?.pnl_near)}">${signed(c.metrics?.pnl_near)}</td></tr>`).join('') || empty(7, empty_)}</table>`;

/** A launch's quality gate score cell: green when the gates passed, red when they failed, – before the first check. */
const gateScore = (s) => `<td class="num ${s?.score == null ? 'muted' : s.pass ? 'g' : 'r'}"><b>${s?.score ?? '–'}</b></td>`;
views.explore = async () => {
  const [o, live, al] = await Promise.all([get('/api/overview'), get('/api/security/live').catch(() => null), get('/api/alerts', { limit: 8 }).catch(() => null)]);
  setStatus(o.worker, o.now, o.ai);
  const cv = Object.fromEntries(o.clusterTag.map((x) => [x.tag, x]));
  const gt = (v, l, c) => tile(l, n(cv[v]?.n || 0, 0), `${n(cv[v]?.wallets || 0, 0)} wallets`, c);
  const items = live?.items || [], C = live?.last24h || {};
  const hacks = items.filter((x) => x.type === 'hack' || x.type === 'drain' || x.type === 'moved').slice(0, 6);
  const contracts = items.filter((x) => x.type === 'contract').slice(0, 8);
  const W = live?.watch;
  const watchLine = live?.live ? `<span class="dot ok"></span> Watching NEAR live · block ${Number(W.height).toLocaleString('en-US')} · checked ${since(W.tick_ts)}` : `<span class="dot bad"></span> The chain watch is not running`;
  const lvl = (l, audited) => `<span class="v ${l ? LIVE_LVL[l] || 'unrated' : 'unrated'}">${esc(l || (audited ? '–' : 'auditing'))}</span>`;
  const hackRow = (x) => x.type === 'drain' && (x.verdict === 'own_funds' || (x.tags || []).slice(-1)[0] === 'safe')
    ? `<tr ${row('/firewall?q=' + encodeURIComponent(x.receiver))}><td>${since(x.ts)}</td><td>${tagTrail(x.tags?.length ? x.tags : ['drain?', 'safe'])}</td><td class="wrap"><b>${esc(short(x.protocol, 28))}</b><div class="muted small">normal: ${esc(short(x.own || x.why || '', 110))}</div></td><td class="num">${usd(x.usd)}</td></tr>`
    : x.type === 'moved'
    ? `<tr ${row('/firewall/' + encodeURIComponent(x.incident))}><td>${since(x.ts)}</td><td><span class="v bad">moved</span></td><td class="wrap"><b>${amt(x.amount)} ${esc(x.symbol)} of stolen funds</b><div class="muted small">from ${esc(short(x.from, 22))}${x.idle_h >= 24 ? `, idle ${x.idle_h >= 48 ? Math.round(x.idle_h / 24) + ' days' : x.idle_h + ' h'}` : ''}${x.swap ? ` → ${esc(x.swap.asset)} on ${esc(x.swap.chain)}` : ''}</div></td><td class="num r">${usd(x.usd)}</td></tr>`
    : x.type === 'hack'
    ? `<tr ${row('/firewall/' + encodeURIComponent(x.id))}><td>${since(x.ts)}</td><td><span class="v bad">hack</span></td><td class="wrap"><b>${esc(x.target || 'wallets')}</b><div class="muted small">${esc(short(x.attack_type || x.headline || '', 90))}</div></td><td class="num r">${usd(x.stolen_usd)}</td></tr>`
    : `<tr ${row('/firewall?q=' + encodeURIComponent(x.receiver))}><td>${since(x.ts)}</td><td><span class="v neutral">drain?</span></td><td class="wrap"><b>${esc(short(x.protocol, 28))}</b><div class="muted small">to ${esc(short(x.receiver, 30))}</div></td><td class="num a">${usd(x.usd)}</td></tr>`;
  return `<div class="hero"><h1>Know who is behind every NEAR launch</h1>
    <p class="muted">Safe Near follows the early money and the creators on NEAR launchpads, checks every new contract as it is deployed, and catches hacks as they happen: which wallet groups bought a token in its first minutes, whether its creator has rugged before, what a contract lets its owner do, and where stolen money went.</p>
    ${searchBox('heroSearch', 'big')}
    <div class="tiles">${tile('Tokens tracked', n(o.tokens, 0))}${tile('Early wallets', n(o.wallets, 0), `${n(o.profiled, 0)} profiled · ${n(o.entries, 0)} entries`)}${tile('Winning groups', n((cv.win80?.n || 0) + (cv.win50?.n || 0), 0), `win80 ${n(cv.win80?.n || 0, 0)} · win50 ${n(cv.win50?.n || 0, 0)}`, 'g')}${gt('loss', 'loss groups', 'r')}${tile('Rugged tokens', n(o.rugged, 0), `of ${n(o.tokens, 0)} tracked`, o.rugged ? 'r' : '')}${tile('Blacklisted creators', n(o.blacklisted, 0), `${n(o.groupsWithCreators, 0)} groups contain a rugger`, o.blacklisted ? 'r' : '')}${tile('Contracts audited', n(C.audited || 0, 0), `last 24 h · ${n(C.risky || 0, 0)} high risk`, C.risky ? 'a' : '')}${tile('Hacks', n(C.hacks || 0, 0), `confirmed, 24 h · ${n(C.drains || 0, 0)} large transfers checked`, C.hacks ? 'r' : '')}</div></div>
  ${aiBanner(o.ai)}
  <div class="grid2">
    <div class="card"><div class="head"><h2>Highest trading volume <span class="muted">last 24 h</span></h2><a href="/tokens" onclick="ST.tokens.tab='volume';ST.tokens.offset=0;return navA(event,this)">All →</a></div>
      <table><tr><th>Token</th><th class="num">Volume</th><th class="num">Bought / sold</th><th class="num">Traders</th><th class="num">Now</th><th>Rug</th></tr>
      ${(o.topVolume || []).slice(0, 8).map((t) => `<tr ${row(P.tok(t.id))}><td>${tokCell(t.id, t.symbol, t.launchpad, 18)}</td><td class="num b">${n(t.vol24.near, 0)} N</td><td class="num"><span class="g">${n(t.vol24.buy_near, 0)}</span> / <span class="r">${n(t.vol24.sell_near, 0)}</span></td><td class="num">${t.vol24.traders}</td><td class="num">${xm(t.now_multiple)}</td><td class="${t.rugged ? 'r' : 'muted'}">${t.rugged ? 'RUG' : '–'}</td></tr>`).join('') || empty(6, 'no trades in the last 24 h')}</table></div>
    <div class="card"><div class="head"><h2>Latest launches</h2>${ilink('/tokens', 'Tokens &amp; scanner →')}</div>
      <table><tr><th>Token</th><th>Live</th><th class="num">Early</th><th class="num">Peak</th><th class="num" title="Quality gate score from the scanner's first check (green = gates pass, red = gates fail)">Gate</th><th>Rug</th></tr>
      ${o.latest.slice(0, 8).map((t) => `<tr ${row(P.tok(t.id))}><td>${tokCell(t.id, t.symbol, t.launchpad, 18)}</td><td>${since(t.live_ts)}</td><td class="num">${t.entries_n ?? '–'}</td><td class="num">x${n(t.outcome?.peak_multiple, 1)}</td>${gateScore(t.scan)}<td class="${t.outcome?.rugged ? 'r' : 'muted'}">${t.outcome?.rugged ? 'RUG' : '–'}</td></tr>`).join('') || empty(6, 'no launches yet')}</table></div>
  </div>
  <div class="grid2">
    <div class="card"><div class="head"><h2>Large transfers &amp; hacks <span class="muted">checked from the chain</span></h2>${ilink('/firewall', 'Safety Check →')}</div>
      <table><tr><th>When</th><th></th><th>Target</th><th class="num">Taken</th></tr>${hacks.map(hackRow).join('') || empty(4, 'No hack or drain caught yet.')}</table>
      <p class="muted small" style="margin:8px 0 0">Every block is watched for money leaving a DeFi protocol for an account that looks like an attacker; each case is traced: attacker accounts, losses, victims and where the money went.</p></div>
    <div class="card"><div class="head"><h2>New contracts <span class="muted">audited as they are deployed</span></h2>${ilink('/audit', 'Contract audit →')}</div>
      <table><tr><th>When</th><th>Level</th><th>Contract</th><th>Type</th></tr>${contracts.map((x) => `<tr ${row(P.audit(x.account))}><td>${since(x.ts)}</td><td>${lvl(x.level, x.audited)}</td><td class="wrap"><span class="acct">${esc(short(x.account, 32))}</span><div class="muted small">${esc(short(x.control || x.how || '', 60))}</div></td><td class="small">${esc(x.label || '–')}</td></tr>`).join('') || empty(4, 'No contract deployed yet.')}</table></div>
  </div>
  <div class="grid2">
    <div class="card"><div class="head"><h2>Latest alerts</h2>${ilink('/alerts', 'Alerts →')}</div>
      <table>${(al?.rows || []).map((a) => `<tr ${a.url ? row(a.url.replace(/^https?:\/\/[^/]+/, '')) : ''}><td style="white-space:nowrap">${since(a.ts)}</td><td><span class="v ${SEVCLS[a.severity]}">${esc(a.severity)}</span></td><td class="wrap"><b>${esc(a.label || al.types?.[a.type] || a.type)}</b><div class="muted small">${esc(short(a.title, 110))}</div></td></tr>`).join('') || empty(3, 'No alerts yet.')}</table></div>
    <div class="card"><div class="head"><h2>Is it safe?</h2>${ilink('/firewall', 'Safety Check →')}</div>
      <p class="muted small" style="margin-top:0">Paste a wallet, a token or its name, an NFT, a contract, a transaction or a website: one plain answer, and the hacks it is linked to.</p>
      <div class="bar" style="flex-wrap:nowrap;gap:8px"><input id="exSafe" placeholder="alice.near · BLACKDRAGON · a transaction hash · https://…" style="flex:1;padding:10px 12px" onkeydown="if(event.key==='Enter')exSafe()"><button class="cta" style="padding:10px 18px" onclick="exSafe()">Check</button></div>
      <p class="small" style="margin:12px 0 0">${watchLine}</p>
      <div class="tiles" style="margin-top:8px">${tile('Contracts deployed', n(C.deploys || 0, 0), 'last 24 h')}${tile('High risk', n(C.risky || 0, 0), 'of those audited', C.risky ? 'a' : '')}${tile('Large transfers', n(C.drains || 0, 0), 'last 24 h', C.drains ? 'a' : '')}</div></div>
  </div>`;
};
function exSafe() { const q = $('exSafe').value.trim(); if (!q) return; history.pushState(null, '', '/firewall?q=' + encodeURIComponent(q)); render(); }
