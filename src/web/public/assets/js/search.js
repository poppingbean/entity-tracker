// The search box in the header (press "/").
// ================================================================== search
const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
function searchBox(id, cls = '') {
  return `<div class="search ${cls}">${SEARCH_ICON}<input id="${id}" type="search" autocomplete="off" spellcheck="false" placeholder="Search a token, wallet or group…  ( / )" oninput="searchInput(this)" onfocus="searchInput(this)" onkeydown="searchKey(event,this)"><div class="sr" id="${id}-r"></div></div>`;
}
let sTimer = null, sSeq = 0;
function searchInput(el) {
  clearTimeout(sTimer);
  const q = el.value.trim(), box = $(el.id + '-r');
  if (q.length < 2) { box.classList.remove('open'); return; }
  sTimer = setTimeout(async () => {
    const my = ++sSeq, r = await get('/api/search', { q }).catch(() => null);
    if (!r || my !== sSeq) return;
    box.innerHTML = searchHtml(r, q); box.classList.add('open');
  }, 200);
}
function searchHtml(r, q) {
  const sec = (title, items) => (items.length ? `<div class="sr-h">${title}</div>${items.join('')}` : '');
  const item = (path, icon, main, sub) => `<a class="sr-i" href="${esc(path)}" onmousedown="event.preventDefault()" onclick="closeSearch();return navA(event,this)">${icon}<span><b>${main}</b><small>${sub}</small></span></a>`;
  let h = sec('Tokens', r.tokens.map((t) => item(P.tok(t.id), avatar(t.id, t.symbol, 28), esc(t.symbol || short(t.id, 20)), `<span class="acct">${esc(short(t.id, 36))}</span> · ${esc(t.launchpad)} · ${since(t.live_ts)}${t.outcome?.rugged ? ' · <span class="r">rug</span>' : ''}`)))
    + sec('Wallets', r.wallets.map((w) => item(P.wal(w.id), avatar(w.id, w.id, 28), `<span class="acct">${esc(short(w.id, 40))}</span>`, `${tg(w.tag)} ${w.cluster_id ? 'group ' + esc(short(w.cluster_id, 18)) : 'unlinked'} · ${w.stats?.tokens_n ?? 0} tokens`)))
    + sec('Groups', r.groups.map((c) => item(P.grp(c.id), avatar(c.id, c.ai?.label || c.id, 28), esc(c.ai?.label || c.id), `${tg(c.tag)} ${c.size} wallets · <span class="acct">${esc(short(c.id, 22))}</span>`)));
  if (ACCT_RE.test(q) && q.includes('.')) h += sec('Contract', [item(P.audit(q), '<span class="av" style="--h:170;width:28px;height:28px;font-size:11px">⛨</span>', 'Audit ' + esc(q), 'access keys, code, tax, sell behaviour')].concat(r.tokens.some((t) => t.id === q) ? [] : [item(P.tok(q), avatar(q, q, 28), 'Fetch & analyse ' + esc(short(q, 34)), 'not in the database: read its launch, trades and early buyers from the chain')]));
  return h || `<div class="sr-empty">Nothing found for “${esc(q)}”.</div>`;
}
function searchKey(e, el) {
  const box = $(el.id + '-r'), items = [...box.querySelectorAll('a.sr-i')], i = items.findIndex((a) => a.classList.contains('on'));
  if (e.key === 'Escape') { closeSearch(); el.blur(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!items.length) return; items.forEach((a) => a.classList.remove('on')); const j = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1); items[j].classList.add('on'); items[j].scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'Enter') { const a = items[Math.max(0, i)]; if (a && box.classList.contains('open')) { closeSearch(); el.blur(); nav(null, a.getAttribute('href')); } }
}
function closeSearch() { clearTimeout(sTimer); document.querySelectorAll('.sr.open').forEach((x) => x.classList.remove('open')); }
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) closeSearch(); });
document.addEventListener('keydown', (e) => { if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); $('topQ').focus(); } });
