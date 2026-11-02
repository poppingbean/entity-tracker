// ================================================================== ALERTS + WATCHLIST (this browser's watchlist: an anonymous key in localStorage)
const WKEY = 'sn_watch_key';
let WATCH = null; // Set of "kind:id" this browser watches
const post = async (path, body) => { const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tracker': '1' }, body: JSON.stringify(body) }); return r.json(); };
async function watchKey(create) {
  let k = null; try { k = localStorage.getItem(WKEY); } catch {}
  if (!k && create) { const r = await post('/api/watch/key', { kind: 'web' }); if (r.key) { k = r.key; try { localStorage.setItem(WKEY, k); } catch {} } else throw new Error(r.error || 'could not create a watchlist'); }
  return k;
}
async function loadWatch() {
  const k = await watchKey(false).catch(() => null);
  if (!k) { WATCH = new Set(); return []; }
  const w = await get('/api/watchlist', { key: k }).catch(() => ({ items: [] }));
  WATCH = new Set((w.items || []).map((x) => `${x.kind}:${x.id}`));
  return w.items || [];
}
/** A ☆ Watch / ★ Watching button for any page. */
const watchBtn = (kind, id) => { const on = WATCH?.has(`${kind}:${id}`); return `<button class="watchbtn ${on ? 'on' : ''}" data-w="${esc(kind)}:${esc(id)}" onclick="toggleWatch(this)" title="${on ? 'Stop alerts about this' : 'Get alerts about this (Alerts page, or Telegram / API with the same ids)'}">${on ? '★ Watching' : '☆ Watch'}</button>`; };
async function toggleWatch(btn) {
  const [kind, ...rest] = btn.dataset.w.split(':'), id = rest.join(':');
  btn.disabled = true;
  try {
    const key = await watchKey(true), on = WATCH?.has(`${kind}:${id}`);
    const r = await post('/api/watch', { key, kind, id, remove: on });
    if (r.error) { alert(r.error); return; }
    WATCH = new Set(r.items.map((x) => `${x.kind}:${x.id}`));
    btn.outerHTML = watchBtn(kind, id);
  } catch (e) { alert(e.message); } finally { btn.disabled = false; }
}
const SEVCLS = { high: 'bad', medium: 'neutral', info: 'unrated' };
/** How to get alerts in Telegram from the bot (its own watchlist per chat). */
function tgGuide(bot, channel) {
  if (!bot) return '';
  const link = `https://t.me/${encodeURIComponent(bot)}`, cmd = (c, what) => `<tr><td><code>${c}</code></td><td>${what}</td></tr>`;
  return `<div class="card"><h2>Get alerts on Telegram</h2>
    <div class="bar"><a class="cta" href="${esc(link)}" target="_blank" rel="noopener" style="text-decoration:none">Open @${esc(bot)} ↗</a></div>
    <ol class="small" style="margin:8px 0;padding-left:18px">
      <li>Open <a href="${esc(link)}" target="_blank" rel="noopener">@${esc(bot)}</a> in Telegram and press <b>Start</b>.</li>
      <li>Send <code>/watch</code> with what to follow: a token symbol or contract (<code>/watch THREE</code>), a wallet, a creator, an NFT contract or a <code>c_…</code> group id.</li>
      <li>Alerts arrive in that chat a few minutes after the on-chain event, with a link to the page and the transaction.</li>
    </ol>
    <table class="small">${cmd('/watch &lt;id&gt;', 'watch it (up to 50 per chat)')}${cmd('/unwatch &lt;id&gt;', 'stop')}${cmd('/list', "this chat's watchlist")}${cmd('/alerts', 'the latest alerts for it')}${cmd('/check &lt;token&gt;', 'current risk notes of a token or NFT collection')}${cmd('/hack &lt;wallet | tx&gt;', 'is it part of a hack? The summary and an evidence file to forward')}${cmd('/hacks', 'the latest hacks on NEAR')}${cmd('/report &lt;wallet | tx&gt;', 'report a hack: it is investigated from the chain')}${cmd('/help', 'all commands')}</table>
    <p class="muted small" style="margin:8px 0 0">Add the bot to a group to share one watchlist there (any member can change it). The Telegram watchlist is separate from this browser's. Only events of the last 10 minutes are sent, never old ones.${channel ? ` High-severity alerts also go to <a href="https://t.me/${esc(channel)}" target="_blank" rel="noopener">@${esc(channel)}</a>.` : ''}</p></div>`;
}
// the watch picker: suggestions come from what the tracker has (GET /api/watch/pick), so only existing tokens etc. can be picked
let pickTimer = null, pickSeq = 0;
function pickSuggest() {
  clearTimeout(pickTimer);
  pickTimer = setTimeout(async () => {
    const q = $('watchId').value.trim(), kind = $('watchKind').value, my = ++pickSeq, box = $('watchPick');
    if (q.length < 2) { box.innerHTML = 'Only what the tracker has can be watched: type at least 2 characters and pick from the list.'; return; }
    const j = await get('/api/watch/pick', { q, kind }).catch(() => ({ rows: [] }));
    if (my !== pickSeq) return; // a newer keystroke already asked
    box.innerHTML = j.rows.length ? `<table>${j.rows.map((x) => `<tr><td>${esc(x.kind)}</td><td class="wrap"><b>${esc(short(x.label, 30))}</b>${x.label !== x.id ? ` <span class="acct">${esc(short(x.id, 34))}</span>` : ''}<div class="muted small">${esc(x.sub || '')}</div></td>
      <td class="num small">${x.kind !== 'token' ? '' : x.mcap ? `<b>${x.mcap.usd != null ? '$' + n(x.mcap.usd, 0) : n(x.mcap.near, 0) + ' N'}</b><div class="muted" title="market cap at the last trade">mcap · ${since(x.mcap.last_ts)}</div>` : '<span class="muted">no trades</span>'}</td>
      <td>${WATCH?.has(`${x.kind}:${x.id}`) ? '<span class="muted">watching</span>' : `<button data-k="${esc(x.kind)}" data-i="${esc(x.id)}" onclick="pickWatch(this)">＋ Watch</button>`}</td></tr>`).join('')}</table>`
      : `Nothing in the system matches <b>${esc(q)}</b>${kind ? ` (${esc(kind)})` : ''}. Only tokens the tracker follows can be watched.`;
  }, 250);
}
async function pickWatch(b) {
  b.disabled = true;
  const key = await watchKey(true), r = await post('/api/watch', { key, kind: b.dataset.k, id: b.dataset.i });
  if (r.error) { alert(r.error); b.disabled = false; } else render();
}
// what each kind of watched item raises (keep in step with src/alerts/detect.js)
const WATCH_ON = {
  token: 'rug, creator selling or buying, buys and sells of 25+ NEAR, transfers worth 250+ NEAR or 1%+ of supply, a 30% drop within an hour, contract code or full-access key changes',
  untracked: 'not a launch the tracker follows: only contract code or full-access key changes',
  wallet: 'buys and sells of 2+ NEAR (early buys in a new launch said so), a new launch by it',
  group: 'buys and sells of 2+ NEAR by any of its wallets',
  creator: 'a new launch, its tokens rugged or sold by it',
  collection: 'the team selling, wash trades, contract changes',
};
const alertRow = (a) => `<tr ${a.url ? row(a.url.replace(/^https?:\/\/[^/]+/, '')) : ''}><td>${when(a.ts)}<br><span class="muted small">${since(a.ts)}</span></td><td><span class="v ${SEVCLS[a.severity]}">${esc(a.severity)}</span></td><td>${esc(a.label || a.type)}</td>
  <td class="wrap"><b>${esc(a.title)}</b><div class="muted small">${esc(a.text)}${a.tx_url ? ` <a href="${esc(a.tx_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Transaction on NearBlocks ↗</a>` : ''}</div></td></tr>`;
views.alerts = async () => {
  const S = ST.alerts;
  const items = await loadWatch();
  const key = await watchKey(false).catch(() => null);
  const mine = S.tab === 'mine';
  const j = mine ? (key ? await get('/api/alerts', { key, limit: 100 }) : { rows: [] }) : await get('/api/alerts', { severity: S.tab === 'high' ? 'high' : '', group: S.group, limit: 50, offset: S.offset });
  const meta = mine ? await get('/api/alerts', { limit: 1 }) : j;
  return `<div class="grid2 main-l"><div class="card"><div class="bar">${seg('alerts', 'tab', [['', 'All'], ['high', 'High only'], ['mine', `My watchlist (${items.length})`]])}
      ${mine ? '' : sel('alerts', 'group', [['', 'every kind'], ['rug', 'rug in progress'], ['contract', 'contract changes'], ['activity', 'watched / ruggers'], ['nft', 'NFT team / wash']])}<span class="spacer"></span>${mine ? '' : pager('alerts', j.total)}</div>
    <table><tr><th>When</th><th>Severity</th><th>Kind</th><th>Alert</th></tr>${(j.rows || []).map(alertRow).join('') || empty(4, mine ? (items.length ? '<span style="white-space:normal;display:block">no alerts for your watchlist yet. Alerts are events, not prices: they appear when something on the list happens (see "Alerts on"). Trades of watched tokens are re-read every 10 minutes.</span>' : 'your watchlist is empty: add something on the right, or press ☆ Watch on any token, wallet, group, creator or NFT page') : 'no alerts yet')}</table></div>
  <div>${tgGuide(meta.telegram_bot, meta.telegram_channel)}<div class="card"><h2>My watchlist <span class="muted">this browser</span></h2>
    <div class="bar"><input id="watchId" type="search" autocomplete="off" style="flex:1" placeholder="search a token symbol or contract, group, wallet, creator, NFT collection" oninput="pickSuggest()"><select id="watchKind" onchange="pickSuggest()"><option value="">anything</option>${['token', 'group', 'wallet', 'creator', 'collection'].map((k) => `<option>${k}</option>`).join('')}</select></div>
    <div id="watchPick" class="muted small" style="margin-bottom:8px">Only what the tracker has can be watched: type at least 2 characters and pick from the list.</div>
    <table><tr><th>Kind</th><th>Id</th><th>Alerts on</th><th></th></tr>${items.map((x) => `<tr><td>${esc(x.kind)}</td><td class="acct">${x.symbol ? `<b>${esc(x.symbol)}</b> ` : ''}${esc(short(x.id, 34))}</td><td class="small wrap ${x.tracked === false ? 'a' : 'muted'}" style="white-space:normal;min-width:180px">${esc(WATCH_ON[x.tracked === false ? 'untracked' : x.kind] || '')}</td><td>${watchBtn(x.kind, x.id)}</td></tr>`).join('') || empty(4, 'nothing yet')}</table>
    <p class="muted small" style="margin:8px 0 0">Kept on this browser only (an anonymous key, no account).</p></div>
  <div class="card"><h2>API and webhooks</h2>
    <p class="small"> <code>GET /api/alerts?severity=high&amp;group=rug</code> (everything) · <code>POST /api/watch/key {"kind":"api"}</code> → key · <code>POST /api/watch {"key","id"}</code> · <code>GET /api/alerts?key=…</code> · <code>POST /api/watch/webhook {"key","url"}</code> (https, public hosts only). POSTs need the header <code>x-tracker: 1</code>.</p></div></div></div>`;
};
views.creators = async () => {
  const S = ST.creators, j = await get('/api/creators', { q: S.q, filter: S.filter, sort: S.sort, limit: 50, offset: S.offset });
  const sm = j.summary;
  return `<div class="card"><div class="tiles">${tile('Creators', n(sm.creators, 0), 'launched at least one tracked token')}${tile('Rugged a launch', n(sm.ruggers, 0), `${n(sm.rugged_tokens, 0)} rugged tokens`, sm.ruggers ? 'r' : '')}${tile('Blacklisted', n(sm.blacklisted, 0), 'dev-rug blacklist', sm.blacklisted ? 'r' : '')}</div></div>
  <div class="card"><div class="bar">${seg('creators', 'filter', [['', 'All'], ['blacklisted', 'Blacklisted'], ['rugger', 'Rugged a launch'], ['clean', 'No rugs']])}
    ${sel('creators', 'sort', [['', 'worst first'], ['launches', 'by launches'], ['recent', 'most recent']])}${qbox('creators', 'creator / token symbol')}<span class="spacer"></span>${pager('creators', j.total)}</div>
    <table><tr><th>Creator</th><th>Status</th><th class="num">Launches</th><th class="num">Rugged</th><th class="num">Rug rate</th><th>Tokens</th><th>Group</th><th>Blacklist</th></tr>
    ${j.rows.map((c) => `<tr ${row(P.creator(c.account))}><td>${nb(c.account)}</td><td>${crFlag(c.flag)}</td><td class="num">${c.launches}</td><td class="num ${c.rugged ? 'r' : 'muted'}">${c.rugged}</td><td class="num">${pct(c.rug_rate)}</td>
      <td class="wrap">${c.tokens.map((t) => `<a class="gchip" href="${esc(P.tok(t.id))}" onclick="event.stopPropagation();return navA(event,this)"><i style="background:${t.rugged ? 'var(--loss)' : 'var(--unknown)'}"></i><span>${esc(t.symbol || short(t.id, 12))}${t.rugged ? ' · rug' : ''}</span></a>`).join('')}</td>
      <td>${c.group ? tg(c.group.tag) + ' ' + ilink(P.grp(c.group.id), esc(short(c.group.id, 16))) : '<span class="muted">–</span>'}</td>
      <td class="wrap small">${c.blacklisted ? `<span class="r">${esc(c.blacklisted.reason || 'blacklisted')}</span><br><span class="muted">${esc(c.blacklisted.symbol || '')} · ${since(c.blacklisted.ts)}</span>` : '<span class="muted">–</span>'}</td></tr>`).join('') || empty(8, 'no creators match')}</table></div>`;
};

async function creatorPage(id) {
  const c = await get('/api/creator', { id });
  let h = `<div class="card">${crumbs([['Creators', '/creators'], [short(id, 40)]])}<div style="float:right">${watchBtn('creator', id)}</div>${''}
    <div class="dh-main">${avatar(id, id, 54)}<div style="min-width:0"><h1 class="acct">${esc(id)} ${crFlag(c.flag)}</h1>
      <div class="meta">${ext(nbAddr(id), 'NearBlocks ↗')}${c.wallet?.is_early ? ilink(P.wal(id), 'Wallet page →') : ''}${c.wallet?.tag ? tg(c.wallet.tag) : ''}</div></div></div>
    <div class="tiles">${tile('Launches', c.launches)}${tile('Rugged', c.rugged, pct(c.rug_rate) + ' of its launches', c.rugged ? 'r' : 'g')}${tile('Dev-rug blacklist', c.blacklisted ? 'yes' : 'no', c.blacklisted ? since(c.blacklisted.ts) : null, c.blacklisted ? 'r' : 'g')}${tile('Groups', c.groups.length, 'it belongs to or is linked to')}</div>
    ${c.blacklisted ? `<p class="r" style="margin-bottom:0">${esc(c.blacklisted.reason || 'creator emptied their balance')} <span class="muted">· token ${c.blacklisted.token ? ilink(P.tok(c.blacklisted.token), esc(c.blacklisted.symbol || short(c.blacklisted.token, 20))) : '–'} · ${when(c.blacklisted.ts)} · ${esc(c.blacklisted.source)}</span></p>` : ''}</div>`;
  h += creatorNetHtml(c.network);
  if (c.groups.length) h += `<div class="card"><h2>Groups this creator is part of</h2><table><tr><th>Group</th><th>Tag</th><th class="num">Wallets</th><th>Role</th></tr>${c.groups.map((g) => `<tr ${row(P.grp(g.id))}><td>${ilink(P.grp(g.id), esc(short(g.label || g.id, 36)))}</td><td>${tg(g.tag)}</td><td class="num">${g.size}</td><td>${g.role === 'member' ? 'member wallet' : `linked wallet · ${g.depth ?? '?'} hops`}</td></tr>`).join('')}</table></div>`;
  h += `<div class="card"><h2>Tokens launched <span class="muted">${c.tokens.length}</span></h2><table><tr><th>Token</th><th>Live</th><th class="num">Peak</th><th class="num">Now</th><th>Rug</th><th>Creator sold</th></tr>
    ${c.tokens.map((t) => `<tr ${row(P.tok(t.id))}><td>${tokCell(t.id, t.symbol, t.launchpad, 22)}</td><td>${when(t.live_ts)}</td><td class="num">x${n(t.outcome?.peak_multiple, 1)}</td><td class="num">${nowOf(t)}</td><td>${rugChips(t.outcome) || '<span class="muted">–</span>'}</td><td>${creatorSale(t.outcome).sold ? `<span class="r">${n(creatorSale(t.outcome).near, 1)} N</span>` : '<span class="muted">no</span>'}</td></tr>`).join('') || empty(6, 'no tracked launches')}</table></div>`;
  return h;
}
