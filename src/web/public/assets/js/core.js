// Safe Near UI: shared helpers, formatting, API access, routes and state (loaded first; the pages and app.js use them).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x, d = 2) => (x == null || Number.isNaN(+x) ? '–' : (+x).toLocaleString('en-US', { maximumFractionDigits: d }));
const pct = (x, d = 0) => (x == null || Number.isNaN(+x) ? '–' : (x * 100).toFixed(d) + '%');
const when = (ts) => (ts ? new Date(ts).toLocaleString() : '–');
const ago = (ms) => { if (ms == null || Number.isNaN(ms)) return '–'; const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const since = (ts) => (ts ? ago(Date.now() - ts) + ' ago' : '–');
const short = (a, k = 18) => (a && a.length > k ? a.slice(0, k - 2) + '…' : a || '–');
const roiCls = (r) => (r == null ? 'muted' : r > 0 ? 'g' : r < 0 ? 'r' : 'muted');
const signed = (x, d = 1) => (x == null ? '–' : (x > 0 ? '+' : '') + n(x, d));
const TAGS = ['win80', 'win50', 'win30', 'sniper', 'loss', 'unrated'];
const tagOk = (t) => (TAGS.includes(t) ? t : 'unrated');
// the simulated wallet (paper trading) is hidden while it does not buy anything; set to true to show its page, tabs and labels again
const SHOW_SIM = false;
const TAGHELP = 'loss = lost money overall · net profit: win80 / win50 / win30 = ended in profit in 80 / 50 / 30 %+ of the tokens bought early, sniper = under 30 % (a few big wins pay for many small losses) · unrated = too few judged tokens';
/** Win-rate tag of a wallet or group (share of its early tokens that ended in profit). */
const tg = (t) => `<span class="v ${tagOk(t)}" title="${esc(TAGHELP)}">${tagOk(t)}</span>`;
const vb = (v) => `<span class="v ${esc(v || 'unknown')}">${esc(v === 'bad' ? 'dangerous' : v || 'unknown')}</span>`;
const tags = (t) => (t || []).map((x) => (x === 'creator-rug' ? '<span class="v bad" title="a token creator in this group rugged or is blacklisted">creator-rug</span> ' : `<span class="chip">${esc(x)}</span>`)).join('');
/** Creator warning chip from { launches, rugged, blacklisted: bool | {reason}, reason }. */
const crChip = (r) => {
  if (!r) return '';
  const bl = r.blacklisted, reason = (bl && typeof bl === 'object' ? bl.reason : r.reason) || '';
  if (bl) return `<span class="v bad" title="${esc(reason || 'on the dev-rug blacklist')}">creator blacklisted</span>`;
  if (r.rugged > 0) return `<span class="v bad" title="${r.rugged} of ${r.launches} launches rugged">creator rugged ${r.rugged}/${r.launches}</span>`;
  return '';
};
const crFlag = (f) => (f === 'blacklisted' ? '<span class="v bad">blacklisted</span>' : f === 'rugger' ? '<span class="v bad">rugger</span>' : f === 'creator' ? '<span class="v unrated">creator</span>' : '');
const get = async (path, params) => { const q = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)) : ''; const r = await fetch(path + q); const j = await r.json(); if (j.error && !j.rows && !j.now && !j.nodes) throw new Error(j.error); return j; };

// ---- external links: every wallet / contract / transaction goes to NearBlocks, every token to its launchpad's token page
const NB = 'https://nearblocks.io', STOP = ' onclick="event.stopPropagation()"'; // a link inside a clickable row must not also open the row
const ext = (url, text, title) => `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title ?? text)}"${STOP}>${esc(text)}</a>`;
const ACCT_RE = /^[a-z0-9][a-z0-9._-]*$/;
const nbAddr = (a) => `${NB}/address/${encodeURIComponent(a)}`;
/** A wallet / contract account -> NearBlocks address page. Anything that is not an account id (labels, composite keys) is plain text. */
const acct = (a, k = 24) => (a ? (ACCT_RE.test(a) ? ext(nbAddr(a), short(a, k), a) : esc(short(a, k))) : '–');
const nb = (a) => acct(a, 22);
/** A transaction hash -> NearBlocks transaction page. */
const txl = (h) => (h ? ext(`${NB}/txns/${encodeURIComponent(h)}`, String(h).slice(0, 8) + '…', h) : '–');
// meme.cooking token pages use the meme id, which is not in the token account: the server lists them once
let MEME = {};
const loadMemeIds = () => fetch('/api/meme-ids').then((r) => r.json()).then((j) => { MEME = j.ids || {}; }).catch(() => {});
const padOf = (id) => (/\.nearlytrade\.near$/.test(id) ? 'nearlytrade' : /\.(v2-)?launchpad\.justhoot\.near$/.test(id) ? 'justhoot' : null);
const tokUrl = (id, lp) => {
  lp = lp || padOf(id);
  const e = encodeURIComponent(id);
  if (lp === 'nearlytrade') return `https://nearly.trade/${e}`;
  if (lp === 'justhoot') return `https://justhoot.fun/p/${e}`;
  if (lp === 'memecooking' && MEME[id]) return `https://meme.cooking/meme/${MEME[id]}`;
  return `${NB}/token/${e}`; // no launchpad page known for this token
};
/** A token -> its launchpad's token detail page (nearly.trade, justhoot.fun, meme.cooking), NearBlocks otherwise. */
const tokLink = (id, lp, k = 26) => (id ? ext(tokUrl(id, lp), short(id, k), id) : '–');

// ---- internal links: tokens, wallets and groups each have their own page
const P = { creator: (id) => '/creators/' + encodeURIComponent(id), tok: (id) => '/tokens/' + encodeURIComponent(id), wal: (id) => '/wallets/' + encodeURIComponent(id), grp: (id) => '/groups/' + encodeURIComponent(id),
  ent: (id) => '/entities/' + encodeURIComponent(id), scan: (id) => '/scans/' + encodeURIComponent(id), sim: (id) => '/sim/' + encodeURIComponent(id), audit: (id) => '/audit/' + encodeURIComponent(id), ana: (id) => '/analysis/' + encodeURIComponent(id), tgp: (id) => '/taggroups/' + encodeURIComponent(id), nft: (id) => '/nfts/' + encodeURIComponent(id) };
const row = (path) => `data-href="${esc(path)}" onclick="rowNav(event,this)"`;
const ilink = (path, html, title) => `<a href="${esc(path)}" onclick="event.stopPropagation();return navA(event,this)"${title ? ` title="${esc(title)}"` : ''}>${html}</a>`;
const hue = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const avatar = (id, label, size = 30) => `<span class="av" style="--h:${hue(id)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px">${esc(String(label || id || '?').replace(/^[^a-z0-9]+/i, '').slice(0, 2).toUpperCase() || '?')}</span>`;
/** Token cell: avatar, symbol -> token page, account and a launchpad link. */
const tokCell = (id, sym, lp, k = 26) => `<span class="ent">${avatar(id, sym)}<span><b>${ilink(P.tok(id), esc(sym || short(id, 16)), id)}</b><small><span class="acct">${esc(short(id, k))}</span> ${ext(tokUrl(id, lp), '↗', 'open on ' + (lp || padOf(id) || 'NearBlocks'))}</small></span></span>`;
/** Wallet cell: account -> wallet page, plus NearBlocks. Non-account keys stay plain text. */
const walLink = (id, k = 24) => (!id ? '–' : ACCT_RE.test(id) ? `<span class="acct">${ilink(P.wal(id), esc(short(id, k)), id)}</span> ${ext(nbAddr(id), '↗', 'NearBlocks: ' + id)}` : esc(short(id, k)));
const VCOL = { win80: 'var(--win80)', win50: 'var(--win50)', win30: 'var(--win30)', sniper: 'var(--sniper)', loss: 'var(--loss)', unrated: 'var(--unknown)', solo: 'var(--solo)' };
const RUG_ICON = '☠';
const gchip = (g) => `<a class="gchip${g.rugger ? ' rug' : ''}" href="${esc(P.grp(g.id))}" onclick="event.stopPropagation();return navA(event,this)" title="${esc((g.label || g.id) + ' · ' + tagOk(g.tag) + (g.rugger ? ' · rugger group: contains a creator that rugged, or rug farmers' : ''))}"><i style="background:${VCOL[tagOk(g.tag)]}"></i>${g.rugger ? `<b class="r">${RUG_ICON}</b>` : ''}<span>${esc(short(g.label || g.id, 26))}</span>${g.wallets != null ? `<span class="muted">${g.wallets}w</span>` : ''}</a>`;
const tile = (label, value, sub, cls = '') => `<div class="tile"><span>${label}</span><b class="${cls}">${value}</b>${sub != null && sub !== '' ? `<small>${sub}</small>` : ''}</div>`;
const crumbs = (items) => `<div class="crumbs">${items.map(([l, p]) => (p ? ilink(p, esc(l)) : `<span>${esc(l)}</span>`)).join(' / ')}</div>`;
const empty = (cols, text) => `<tr><td colspan="${cols}" class="muted">${text}</td></tr>`;

// ---- early money split by win-rate tag (the group's tag, or the wallet's own when it has no group)
const MIXV = [['win80', 'win80 · profit in 80 %+ of tokens'], ['win50', 'win50 · 50 %+'], ['win30', 'win30 · 30 %+'], ['sniper', 'sniper · net profit, few big wins'], ['loss', 'loss · lost money'], ['unrated', 'unrated · too few tokens']];
const mixTotal = (m) => MIXV.reduce((s, [v]) => s + (m?.[v]?.near || 0), 0);
const mixBar = (m, cls = '') => {
  const tot = mixTotal(m);
  if (!tot) return '<div class="mix ' + cls + '"></div>';
  return `<div class="mix ${cls}">${MIXV.map(([v, l]) => { const x = m[v]?.near || 0; return x ? `<i class="${v}" style="width:${((x / tot) * 100).toFixed(2)}%" title="${l}: ${n(x, 1)} N · ${m[v].w} wallets (${pct(x / tot)})"></i>` : ''; }).join('')}</div>`;
};
const mixLegend = (m) => { const tot = mixTotal(m) || 1; return `<div class="mixlegend">${MIXV.map(([v, l]) => `<div><small><span class="lg-dot ${v}"></span>${l}</small><b>${pct((m[v]?.near || 0) / tot)}</b><small>${n(m[v]?.near || 0, 1)} N · ${m[v]?.w || 0} wallets</small></div>`).join('')}</div>`; };
const mixCell = (m, rug) => { const tot = mixTotal(m); if (!tot) return '<span class="muted">no early buyers yet</span>'; const w = MIXV.reduce((s, [v]) => s + (m[v]?.w || 0), 0);
  return `<div class="mixcell">${mixBar(m)}<small>${w} wallets · ${n(tot, 0)} N · <span class="g">${pct(((m.win80?.near || 0) + (m.win50?.near || 0) + (m.sniper?.near || 0)) / tot)}</span> / <span class="r">${pct((m.loss?.near || 0) / tot)}</span>${rug?.w ? ` · <b class="r" title="rugger wallets among the early buyers">${RUG_ICON} ${rug.w}w ${pct(rug.near / tot)}</b>` : ''}</small></div>`; };
const wavg = (pairs) => { const w = pairs.reduce((s, [, x]) => s + (x || 0), 0); return w ? pairs.reduce((s, [r, x]) => s + r * (x || 0), 0) / w : null; };

// ---- list state, filters, pager
const ST = { scans: { kind: '', pass: '', bought: '', q: '', offset: 0 }, entities: { type: '', q: '', sort: 'funded', offset: 0 }, groups: { tag: '', q: '', sort: 'size', offset: 0 }, taggroups: { only: '', sort: 'pnl', offset: 0 }, nfts: { tab: '', q: '', sort: '', offset: 0 }, alerts: { tab: '', group: '', offset: 0 }, newContracts: { role: '', level: '', offset: 0 }, 
  wallets: { q: '', tag: '', sort: 'tokens', offset: 0 }, creators: { q: '', filter: '', sort: '', offset: 0 }, tokens: { q: '', tab: '', status: '', launchpad: '', offset: 0 }, signals: { hours: 72 }, logs: { level: '' } };
const setSt = (view, field, value, reset = true) => { ST[view][field] = value; if (reset && 'offset' in ST[view]) ST[view].offset = 0; render(); };
const sel = (view, field, opts) => `<select onchange="setSt('${view}','${field}',this.value)">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(ST[view][field]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const seg = (view, field, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${String(ST[view][field]) === String(v) ? 'on' : ''}" onclick="setSt('${view}','${field}','${esc(v)}')">${esc(l)}</button>`).join('')}</div>`;
const qbox = (view, ph) => `<input type="search" placeholder="${esc(ph)}" value="${esc(ST[view].q)}" onkeydown="if(event.key==='Enter')setSt('${view}','q',this.value)">`;
const pager = (view, total, size = 50) => { const o = ST[view].offset; return `<span class="muted">${total ? `${n(o + 1, 0)}–${n(Math.min(total, o + size), 0)} of ${n(total, 0)}` : '0'}</span>
  <button ${o ? '' : 'disabled'} onclick="ST.${view}.offset=Math.max(0,ST.${view}.offset-${size});render()">◀</button><button ${o + size < total ? '' : 'disabled'} onclick="ST.${view}.offset+=${size};render()">▶</button>`; };
/** One line: is NEAR AI evaluating the data right now? (the worker sends it the data; it reports every minute) */
const setStatus = (w, now, ai) => {
  const alive = w && now - w.ts < 5 * 60e3;
  const [cls, txt, why] = !ai.enabled ? ['', 'NEAR AI off', 'No NEAR AI key: groups get rule-based verdicts only']
    : !alive ? ['bad', 'NEAR AI paused', w ? `The background worker has not reported since ${when(w.ts)}` : 'The background worker has not started yet']
    : ai.ok === false ? ['bad', 'NEAR AI error', 'The last NEAR AI call failed; it is retried automatically']
    : ['ok', 'NEAR AI evaluating', `Last report ${ago(now - w.ts)} ago`];
  $('statusDot').className = 'dot ' + cls; $('status').textContent = txt; $('statusBox').title = why;
};
const aiBanner = (ai) => (!ai.enabled ? '<div class="card warn">NEAR AI is off (set NEAR_AI_API_KEY). Groups get rule-based verdicts only.</div>' : ai.ok === false ? `<div class="card err">NEAR AI error: ${esc(ai.error || '')}</div>` : '');
const views = {};
