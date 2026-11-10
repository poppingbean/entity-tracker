// The search box in the header (press "/").
// ================================================================== search
const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
function searchBox(id, cls = '') {
  return `<div class="search ${cls}">${SEARCH_ICON}<input id="${id}" type="search" autocomplete="off" spellcheck="false" placeholder="Search tokens, wallets, contracts, hacks, or paste an account / tx…  ( / )" oninput="searchInput(this)" onfocus="searchInput(this)" onkeydown="searchKey(event,this)"><div class="sr" id="${id}-r"></div></div>`;
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
const SR_KIND = { protocol_exploit: 'protocol exploit', exchange_drain: 'exchange drain', wallet_drainer: 'wallet drainer', suspicious_transfers: 'large transfers' };
const srIcon = (ch, hue) => `<span class="av" style="--h:${hue};width:28px;height:28px;font-size:12px">${ch}</span>`;
function searchHtml(r, q) {
  const sec = (title, items) => (items && items.length ? `<div class="sr-h">${title}</div>${items.join('')}` : '');
  const item = (path, icon, main, sub) => `<a class="sr-i" href="${esc(path)}" onmousedown="event.preventDefault()" onclick="closeSearch();return navA(event,this)">${icon}<span><b>${main}</b><small>${sub}</small></span></a>`;
  const acct = (id, k = 36) => `<span class="acct">${esc(short(id, k))}</span>`;
  const lq = q.toLowerCase(), isAcct = ACCT_RE.test(lq) && (lq.includes('.') || /^[0-9a-f]{64}$/.test(lq)), isTx = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(q), isLink = /^https?:\/\//i.test(q);
  // the pasted thing itself first: is it safe, and what is it
  const top = [], a = r.account;
  if (isAcct || isTx || isLink) {
    const sub = isTx ? 'Safety Check of this transaction' : isLink ? 'Safety Check of this link'
      : a && (a.class !== 'unknown' || a.flagged || a.cases) ? `${a.class !== 'unknown' ? esc(a.is) : 'Safety Check'}${a.flagged ? ` · <span class="r">flagged ${esc(a.flagged.severity)}</span>` : ''}${a.cases ? ` · in ${a.cases} case${a.cases === 1 ? '' : 's'}` : ''}`
        : 'Safety Check: flags, hacks it is linked to, what it holds';
    top.push(item('/firewall?q=' + encodeURIComponent(q), srIcon('⛨', 150), `Is it safe? ${esc(short(q, 34))}`, sub));
  }
  if (isAcct) {
    const cls = a?.class || 'unknown';
    if (!(r.wallets || []).some((w) => w.id === lq)) top.push(item(P.wal(lq), avatar(lq, lq, 28), `Wallet ${acct(lq, 34)}`, 'funding, money flow and what Safe Near calls it'));
    if (lq.includes('.') && !/^person|^exchange/.test(cls)) {
      if (!(r.contracts || []).some((c) => c.id === lq)) top.push(item(P.audit(lq), srIcon('⚙', 200), `Contract audit ${esc(short(lq, 30))}`, 'type, powers, who controls it, findings'));
      if (!(r.tokens || []).some((t) => t.id === lq)) top.push(item(P.tok(lq), avatar(lq, lq, 28), 'Fetch & analyse ' + esc(short(lq, 30)), 'as a token: launch, trades and early buyers from the chain'));
    }
  }
  const h = sec(isTx ? 'Transaction' : isLink ? 'Link' : 'This account', top)
    + sec('Hacks & cases', (r.cases || []).map((c) => item('/firewall/' + encodeURIComponent(c.id), srIcon('!', 0), esc(short(c.headline || c.id, 72)), `${c.status === 'confirmed' ? '<span class="r">confirmed</span>' : 'watching'} · ${esc(SR_KIND[c.kind] || c.kind || 'case')}${c.stolen_usd ? ' · $' + Math.round(c.stolen_usd).toLocaleString('en-US') : ''}${c.started_ts ? ' · ' + since(c.started_ts) : ''}`)))
    + sec('Flagged accounts', (r.flagged || []).map((f) => item('/firewall?q=' + encodeURIComponent(f.id), srIcon('⚑', 10), acct(f.id, 40), `<span class="r">${esc(f.severity)}</span> · ${esc(short(f.reason || 'reported', 72))}`)))
    + sec('Tokens', (r.tokens || []).map((t) => item(P.tok(t.id), avatar(t.id, t.symbol, 28), esc(t.symbol || short(t.id, 20)), `${acct(t.id)} · ${esc(t.launchpad)} · ${since(t.live_ts)}${t.outcome?.rugged ? ' · <span class="r">rug</span>' : ''}`)))
    + sec('Contracts', (r.contracts || []).map((c) => item(P.audit(c.id), srIcon('⚙', 200), esc(c.name || short(c.id, 30)), `${acct(c.id)}${c.type ? ' · ' + esc(c.type) : ''}${c.level ? ` · <span class="${['high', 'critical'].includes(c.level) ? 'r' : c.level === 'medium' ? 'a' : 'g'}">${esc(c.level)}</span>` : ''}`)))
    + sec('Wallets', (r.wallets || []).map((w) => item(P.wal(w.id), avatar(w.id, w.id, 28), acct(w.id, 40), w.is_early ? `${tg(w.tag)} ${w.cluster_id ? 'group ' + esc(short(w.cluster_id, 18)) : 'unlinked'} · ${w.stats?.tokens_n ?? 0} tokens` : 'linked wallet (not an early buyer)')))
    + sec('Creators', (r.creators || []).map((c) => item(P.creator(c.id), avatar(c.id, c.id, 28), acct(c.id, 40), `${c.launches} launch${c.launches === 1 ? '' : 'es'}${c.rugged ? ` · <span class="r">${c.rugged} rugged</span>` : ''}`)))
    + sec('Groups', (r.groups || []).map((c) => item(P.grp(c.id), avatar(c.id, c.ai?.label || c.id, 28), esc(c.ai?.label || c.id), `${tg(c.tag)} ${c.size} wallets · ${acct(c.id, 22)}`)))
    + sec('Funders & entities', (r.entities || []).map((e) => item(P.ent(e.id), avatar(e.id, e.label || e.id, 28), esc(e.label || short(e.id, 34)), `${acct(e.id, 30)} · ${esc(e.type || e.kind || '')}${e.funded_n ? ` · funded ${e.funded_n} early wallets` : ''}`)))
    + sec('NFT collections', (r.collections || []).map((c) => item(P.nft(c.id), avatar(c.id, c.name || c.id, 28), esc(c.name || short(c.id, 30)), acct(c.id))));
  return h || `<div class="sr-empty">Nothing found for “${esc(q)}”. Paste a full account, a transaction hash or a link to check it.</div>`;
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
