// The shell: navigation, page titles and the router (loaded last: it starts the app).
// ================================================================== shell + router (History API: /tokens/<id>, /groups/<id>, no #)
const SECTIONS = [
  { label: 'Explore', views: [['explore', 'Explore']] },
  { label: 'Safety Check', views: [['firewall', 'Is it safe?'], ['moneywatch', 'Money watch']] },
  { label: 'Monitoring', views: [['alerts', 'Monitoring']] },
  { label: 'Tokens & Scanner', views: [['tokens', 'Launches'], ['signals', 'Smart-money signals'], ...(SHOW_SIM ? [['sim', 'Simulated wallet']] : []), ['analysis', 'On-chain analysis'], ['scans', 'Evaluations'], ['audit', 'Contract audit']] },
  { label: 'NFT Collectibles', views: [['nfts', 'Collections']] },
  { label: 'Wallets & Groups', views: [['groups', 'Linked groups'], ['taggroups', 'Tag groups'], ['wallets', 'Wallets'], ['creators', 'Creators'], ['entities', 'Funders & entities']] },
  { label: 'Accuracy', views: [['accuracy', 'Accuracy']] },
];
const TITLES = {
  explore: ['Explore', ''], tokens: ['Tokens & Scanner', "Every launch: who bought it early (by win-rate tag), the scanner's first check and gates, its outcome and whether it was rugged"],
  signals: ['Smart-money signals', 'Recent tokens where winners (win80 / win50 / sniper) or loss wallets were among the early buyers'],
  groups: ['Linked groups', 'Wallets one owner controls, linked by money only: funding, transfers, shared funders and destinations (co-buy partners are marked apart)'],
  incidents: ['Hacks & incidents', 'Exploits and drainers traced from the chain: the attacker\'s accounts, the target, how much was taken and from whom, and where the money went, across chains'],
  firewall: ['Safety check', 'Is it safe? One answer for anything you paste, the hacks it is linked to, and a live watch of every new contract and every drain on NEAR'],
  moneywatch: ['Money watch', 'Every movement of $100k or more, whatever the token: where the money came from, where it goes, and whether it is normal. Private; a watch is not an accusation'],
  accuracy: ['Measured accuracy', 'How often the gates, rule score, contract audit, AI analyst and group verdicts were right, scored against what happened afterwards'],
  alerts: ['Monitoring', 'Rugs in progress, contract changes, ruggers launching again, NFT team selling and wash trades, and everything on your watchlist'],
  nfts: ['NFT Collectibles', 'NFT collections: who minted (and whether the team minted its own), minter groups linked by money, the secondary market with wash-trade checks, holders'],
  taggroups: ['Tag groups', 'Every early wallet by what it does: win-rate tag and behaviours, standalone or in a linked group'],
  creators: ['Creators', 'Who launched the tokens: launches, rugged launches and the dev-rug blacklist, and which groups they belong to'],
  wallets: ['Wallets', 'Every early buyer: its group, who funded it and how it did'], entities: ['Funders & entities', 'Exchange wallets, services, funders and destinations around the early investors'],
  sim: ['Simulated wallet', 'Paper trading with real pool quotes: equity, open and closed positions'],
  scans: ['Evaluations', 'Every gate check and AI review, with the reasons'], audit: ['Contract audit', 'Any NEAR contract: what it is, the powers its code gives someone over users, who holds them, and every new contract audited automatically'],
  analysis: ['On-chain analysis', 'An investigation of any token: launch, creator, flows, who bought early and the groups behind them, who sold, who holds, risk notes'],
  logs: ['Log', 'Worker activity'], config: ['Settings', 'Read-only view of the configuration in use'],
};
const DETAIL = { firewall: incidentPage, nfts: nftPage, taggroups: tagGroupPage, creators: creatorPage, tokens: tokenPage, wallets: walletPage, groups: groupPage, entities: entityPage, scans: scanPage, sim: simPage, analysis: analysisPage };
function setUrl(path) { if (location.pathname !== path) history.pushState(null, '', path); }
/** Link / tab click: change the path without reloading the page. */
function nav(e, path) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) return true; // let "open in new tab" work
  if (e) e.preventDefault();
  setUrl(path); window.scrollTo(0, 0); render();
  return false;
}
const navA = (e, a) => nav(e, a.getAttribute('href'));
function rowNav(e, el) {
  if (!el.dataset.href || e.target.closest('a,button,input,select')) return;
  if (e.metaKey || e.ctrlKey) { window.open(el.dataset.href, '_blank'); return; }
  nav(null, el.dataset.href);
}
function toggleTheme() { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = t; try { localStorage.setItem('theme', t); } catch {} }
let seq = 0;
async function render() {
  closeSearch();
  const seg = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (seg[0] === 'incidents') { history.replaceState(null, '', '/firewall' + (seg[1] ? '/' + encodeURIComponent(seg.slice(1).join('/')) : location.search)); return render(); } // Hacks is part of Safety Check
  let view = seg[0] === 'overview' ? 'explore' : seg[0] === 'monitor' ? 'tokens' : seg[0]; // the old Monitor page is part of /tokens now
  if (!views[view] || (view === 'sim' && !SHOW_SIM)) view = 'explore';
  if (!seg.length || seg[0] === 'overview' || seg[0] === 'monitor' || (seg[0] === 'sim' && !SHOW_SIM)) history.replaceState(null, '', '/' + view);
  const id = seg.length > 1 ? seg.slice(1).join('/') : null, detail = id && DETAIL[view];
  const sec = SECTIONS.find((s) => s.views.some(([v]) => v === view)) || { label: '', views: [[view, TITLES[view][0]]] };
  $('nav').innerHTML = SECTIONS.map((s) => `<a href="/${s.views[0][0]}" onclick="return navA(event,this)" class="${s === sec ? 'on' : ''}">${s.label}</a>`).join('');
  $('subnav').innerHTML = sec.views.map(([v, l]) => `<a href="/${v}" onclick="return navA(event,this)" class="${v === view ? 'on' : ''}">${l}</a>`).join('');
  $('subnav').hidden = sec.views.length < 2;
  $('pagehead').hidden = !!detail || view === 'explore';
  $('pageTitle').textContent = TITLES[view][0]; $('pageSub').textContent = TITLES[view][1];
  document.title = `${detail ? short(id, 30) : TITLES[view][0]} · Safe Near`;
  const my = ++seq;
  $('main').classList.add('loading');
  try {
    const html = detail ? await DETAIL[view](id) : await views[view]();
    if (my === seq) { $('main').innerHTML = html; if (view === 'audit' && id) runAudit(id); if (view === 'firewall' && !id) { scFromUrl(); liveStart(); } if (view === 'analysis' && id) anaPoll(id); if (view === 'nfts' && id) nftPoll(id); }
  } catch (e) { if (my === seq) $('main').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
  if (my === seq) $('main').classList.remove('loading');
}
$('topSearch').outerHTML = searchBox('topQ');
const loadStatus = () => get('/api/monitor').then((m) => setStatus(m.worker, m.now, m.ai)).catch(() => {});
loadStatus(); setInterval(loadStatus, 60000);
window.addEventListener('popstate', render);
Promise.all([loadMemeIds(), loadWatch().catch(() => {})]).then(render);
setInterval(loadMemeIds, 600000);
// list pages refresh every 30 s; detail pages, open search results and focused inputs are left alone
setInterval(() => { if (location.pathname.split('/').filter(Boolean).length < 2 && location.pathname !== '/firewall' && !document.querySelector('.sr.open') && !['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) render(); }, 30000);
