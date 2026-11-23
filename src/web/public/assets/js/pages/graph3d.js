// 3D network (/graph/<account | grp:… | inc:…>): the ontology's links around an account, a wallet group or a case, drawn with
// 3d-force-graph (three.js, loaded from a pinned CDN build on first use). Data from GET /api/graph3d. Read-only.
const G3_LIB = 'https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.2/dist/3d-force-graph.min.js';
const G3_SRI = 'sha384-GBG/VW3/k9nOKHgDlgS2DFk3HDPeNndiVa5280Guy62u3QEpZQPuAuB4POI5giZN';
// node colours by what the ontology says it is; red wins for a flagged account or one on the attacker's side of a confirmed case
const G3_NODE = { person: ['#60a5fa', 'person / wallet'], exchange: ['#f59e0b', 'exchange'], service: ['#a78bfa', 'service'], contract: ['#34d399', 'contract'],
  system: ['#94a3b8', 'system'], unknown: ['#cbd5e1', 'unknown'], group: ['#f472b6', 'wallet group'], case: ['#fb923c', 'case'], org: ['#22d3ee', 'organisation'], bad: ['#ef4444', 'flagged / bad role'] };
const G3_LINK = { funded: ['#4ade80', 'funded'], swept_to: ['#facc15', 'swept to'], controls: ['#f472b6', 'controls'], deployed: ['#38bdf8', 'deployed'], created_by: ['#0ea5e9', 'created by'],
  operated_by: ['#22d3ee', 'operated by'], solver_for: ['#a78bfa', 'solver for'], member_of: ['#e879f9', 'member of'], role_in: ['#fb7185', 'role in'], sent_to: ['#fbbf24', 'sent to'] };
const G3 = { inst: null, data: null, id: null, hops: 2, hideHubs: false, focus: null, onResize: null };
let g3LibP = null;

/** Load 3d-force-graph once (a <script> tag: the rest of the UI is plain scripts, no build step). */
function g3Lib() {
  if (window.ForceGraph3D) return Promise.resolve(window.ForceGraph3D);
  if (!g3LibP) g3LibP = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = G3_LIB; s.integrity = G3_SRI; s.crossOrigin = 'anonymous'; s.async = true;
    s.onload = () => (window.ForceGraph3D ? ok(window.ForceGraph3D) : fail(new Error('3d-force-graph did not load')));
    s.onerror = () => { g3LibP = null; fail(new Error('could not load the 3D library from the CDN')); };
    document.head.appendChild(s);
  });
  return g3LibP;
}
const g3WebGL = () => { try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); } catch { return false; } };
const g3IsBad = (x) => !!(x.bad || x.flagged);
const g3ColorKey = (x) => (g3IsBad(x) ? 'bad' : G3_NODE[x.top] ? x.top : 'unknown');
const g3IsHub = (x) => x.top === 'exchange' || x.top === 'service';
/** The UI page of a node: wallet page for an account, the group or the case page otherwise. */
const g3PageOf = (id) => (id.startsWith('grp:c_') ? [P.grp(id.slice(4)), 'Group page'] : id.startsWith('inc:') ? ['/firewall/' + encodeURIComponent(id), 'Case page'] : /^(grp|org):/.test(id) ? null : [P.wal(id), 'Wallet page']);
const g3Url = (id) => '/graph/' + encodeURIComponent(id);
/** A link to the 3D page (wallet, group, ontology card and case pages use it). */
const g3Link = (id, text = '3D network →') => ilink(g3Url(id), esc(text), 'the ontology\'s links around it, in 3D');
const g3Name = (x) => (x.kind === 'org' ? orgName(x.id) : x.label ? `${x.label}` : x.id);

// Fullscreen: the whole card (search, filters, legend stay usable), the canvas takes the rest of the screen. The browser's Fullscreen API where there is
// one; otherwise (iPhone Safari) the card is pinned over the page. Esc, or the button again, leaves it.
const G3_FULL_CSS = `#g3card.g3-full { position:fixed; inset:0; z-index:1000; margin:0; border-radius:0; overflow:auto; background:var(--bg); padding:12px 16px; }
  #g3card:fullscreen { overflow:auto; background:var(--bg); padding:12px 16px; } #g3card:fullscreen #g3, #g3card.g3-full #g3 { border-radius:6px; }`;
const g3IsFull = () => !!$('g3card') && (document.fullscreenElement === $('g3card') || $('g3card').classList.contains('g3-full'));
function g3Full() {
  const card = $('g3card'); if (!card) return;
  if (g3IsFull()) { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else { card.classList.remove('g3-full'); g3FullFit(); } return; }
  const pin = () => { if (!document.fullscreenElement && !card.classList.contains('g3-full')) { card.classList.add('g3-full'); g3FullFit(); } };
  // some embedded browsers neither grant nor refuse the request: pinned over the page after half a second
  if (card.requestFullscreen) { card.requestFullscreen().catch(pin); setTimeout(pin, 500); } else pin();
}
/** Size the canvas for the mode: to the bottom of the screen (less the legend) in fullscreen, its usual height otherwise. */
function g3FullFit() {
  const el = $('g3'), card = $('g3card'); if (!el || !card) return;
  if (!el.dataset.h) el.dataset.h = el.style.height;
  const full = g3IsFull();
  if (full) { const top = el.getBoundingClientRect().top - card.getBoundingClientRect().top + card.scrollTop; el.style.height = Math.max(320, window.innerHeight - top - 64) + 'px'; }
  else el.style.height = el.dataset.h;
  if ($('g3info')) $('g3info').style.maxHeight = (parseInt(el.style.height, 10) - 40) + 'px';
  if ($('g3fullbtn')) $('g3fullbtn').textContent = full ? '✕ Exit fullscreen' : '⛶ Fullscreen';
  if (G3.inst) G3.inst.width(el.clientWidth).height(el.clientHeight);
}
document.addEventListener('fullscreenchange', () => setTimeout(g3FullFit, 50));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('g3card')?.classList.contains('g3-full')) { $('g3card').classList.remove('g3-full'); g3FullFit(); } });
window.addEventListener('resize', () => { if (g3IsFull()) g3FullFit(); });

// /graph: the whole layer at once (GET /api/graph3d/all), the same colours; filters re-lay the map out, a click shows a node and links to its own network
const G3O = { hideLeaves: true, hideHubs: false, minIsland: 3, off: new Set(), all: null, adj: null, near: null };
views.graph = async () => `<div class="card" id="g3card"><h2>3D map of the ontology <span class="muted">every account, group, case and organisation it links, at once</span></h2>
  <div class="bar"><input id="g3q" type="search" style="min-width:340px" placeholder="find an account, a label, grp:c_… or inc:…" onkeydown="if(event.key==='Enter')g3oFind(this.value)">
  <button class="primary" onclick="g3oFind($('g3q').value)">Find in the map</button>
  <button onclick="const v=$('g3q').value.trim();if(v)nav(null,g3Url(v))" title="the network around it, up to 3 hops, with the evidence of each link">Its own network →</button></div>
  <div class="bar" style="margin:8px 0">
    <label class="small"><input type="checkbox" ${G3O.hideLeaves ? 'checked' : ''} onchange="G3O.hideLeaves=this.checked;g3oApply()"> hide wallets with a single link</label>
    <label class="small"><input type="checkbox" ${G3O.hideHubs ? 'checked' : ''} onchange="G3O.hideHubs=this.checked;g3oApply()"> hide exchanges and services</label>
    <span class="muted small">smallest island</span><div class="seg" id="g3oisl">${[1, 3, 10, 50].map((k) => `<button data-k="${k}" class="${k === G3O.minIsland ? 'on' : ''}" onclick="g3oIsland(${k})">${k}</button>`).join('')}</div>
    <span class="spacer"></span><button onclick="g3Fit()">Fit view</button><button id="g3fullbtn" onclick="g3Full()" title="fill the screen (Esc to leave)">⛶ Fullscreen</button>
  </div>
  <div class="bar small" id="g3opreds" style="margin:0 0 8px"></div>
  <style>#g3info { overflow-x:hidden; overflow-wrap:anywhere; } #g3info td, #g3info td div { white-space:normal; }${G3_FULL_CSS}</style>
  <div style="position:relative">
    <div id="g3" style="height:720px;border-radius:10px;overflow:hidden;background:#0b1220"></div>
    <div id="g3info" class="card" hidden style="position:absolute;top:10px;right:10px;width:320px;max-height:680px;overflow:auto;margin:0;opacity:.97"></div>
  </div>
  <div class="meta" style="margin-top:6px"><span id="g3meta" class="muted">loading the map …</span></div>
  <div class="legend" id="g3legend"></div>
  <p class="muted small">Drag to turn, scroll to zoom, right-drag to pan. Hover a node for what it is; click it for its links. An island is a set of nodes linked to each other and to nothing else.
  Exchanges, services and contracts are drawn with their links, but the investigations never walk through them: two wallets paid by the same exchange are not linked.</p></div>`;

async function g3OverviewStart() {
  g3Stop();
  G3.id = null; G3.focus = null; G3O.near = null;
  const my = seq;
  if (!g3WebGL()) { $('g3meta').textContent = ''; g3Msg('Your browser cannot draw 3D graphics (WebGL is off or not supported).'); return; }
  g3Msg('Loading the whole map … (a few thousand nodes: the first view after a server restart can take a few seconds)');
  let d, FG;
  try { [d, FG] = await Promise.all([G3O.all ? Promise.resolve(null) : get('/api/graph3d/all'), g3Lib()]); }
  catch (e) { if (my === seq) { $('g3meta').textContent = ''; g3Msg(esc(e.message)); } return; }
  if (my !== seq || !$('g3')) return; // the reader went elsewhere
  if (d) {
    const nodes = d.nodes.map(([id, t, f, degree, island, label]) => ({ id, top: d.tops[t], kind: g3oKind(id), class: d.tops[t], bad: f & 1 ? "flagged, or on the attacker's side of a confirmed case" : null, cut: !!(f & 2), degree, island, label }));
    const links = d.links.map(([a, b, p, role]) => ({ source: nodes[a], target: nodes[b], p: d.predicates[p], role }));
    const adj = new Map(nodes.map((x) => [x.id, []]));
    for (const l of links) { adj.get(l.source.id).push(l); adj.get(l.target.id).push(l); }
    G3O.all = { nodes, links, islands: d.islands, capped: d.capped, built: d.built_ts }; G3O.adj = adj;
  }
  const el = $('g3'); el.innerHTML = '';
  G3.inst = FG({ controlType: 'orbit' })(el)
    .width(el.clientWidth).height(el.clientHeight).backgroundColor('#0b1220').showNavInfo(false)
    .nodeId('id').nodeVal((x) => 1 + Math.min(x.degree, 200) / 8).nodeRelSize(2.5).nodeResolution(5).nodeOpacity(0.95)
    .nodeColor((x) => g3oColor(x)).nodeLabel((x) => g3oTip(x))
    .linkColor((l) => (G3_LINK[l.p] || ['#94a3b8'])[0]).linkOpacity(0.3).linkWidth((l) => g3oLinkWidth(l))
    .cooldownTicks(160).warmupTicks(20)
    .onNodeClick((x) => g3oFocus(x)).onBackgroundClick(() => g3oUnfocus());
  G3.inst.d3Force('charge').strength(-14).distanceMax(400);
  G3.inst.onEngineStop(() => { if (!G3.focus && !G3.fitted) { G3.fitted = true; G3.inst.zoomToFit(600, 30); } });
  G3.onResize = () => { if (G3.inst && $('g3')) G3.inst.width($('g3').clientWidth); };
  window.addEventListener('resize', G3.onResize);
  g3oPreds();
  g3oApply();
}
const g3oKind = (id) => (id.startsWith('grp:') ? 'group' : id.startsWith('inc:') ? 'case' : id.startsWith('org:') ? 'org' : 'account');
const g3oColor = (x) => (G3.focus && x.id !== G3.focus && !G3O.near?.has(x.id) ? '#334155' : G3_NODE[g3ColorKey(x)][0]);
const g3oLinkWidth = (l) => (G3.focus && (l.source.id === G3.focus || l.target.id === G3.focus) ? 0.8 : 0);
function g3oTip(x) {
  return `<div style="max-width:320px;font:12px/1.4 system-ui;background:rgba(15,23,42,.95);color:#e2e8f0;padding:6px 8px;border-radius:6px">
    <b>${esc(short(g3Name(x), 48))}</b>${x.label ? `<br><span style="opacity:.7">${esc(short(x.id, 48))}</span>` : ''}
    <br>${esc(G3_NODE[x.top]?.[1] || x.top)}${x.cut ? ' · not walked through' : ''} · ${x.degree} link${x.degree === 1 ? '' : 's'} · island of ${n(G3O.all.islands[x.island], 0)}
    ${x.bad ? `<br><span style="color:#fca5a5">${esc(x.bad)}</span>` : ''}</div>`;
}
/** Which nodes and links pass the filters; the map is laid out again with only those. */
function g3oApply() {
  const A = G3O.all; if (!A || !G3.inst) return;
  const ok = (x) => !(G3O.hideLeaves && x.kind === 'account' && x.degree <= 1) && !(G3O.hideHubs && g3IsHub(x)) && A.islands[x.island] >= G3O.minIsland;
  const keep = new Set(A.nodes.filter(ok).map((x) => x.id));
  const links = A.links.filter((l) => !G3O.off.has(l.p) && keep.has(l.source.id) && keep.has(l.target.id));
  // every node that passes stays, even when its neighbours are hidden (a DAO with 500 one-link wallets stays, as one big node)
  const nodes = A.nodes.filter((x) => keep.has(x.id));
  G3.data = { nodes, links }; G3.fitted = false;
  if (G3.focus && !keep.has(G3.focus)) g3oUnfocus();
  G3.inst.graphData({ nodes, links });
  $('g3meta').innerHTML = `${n(nodes.length, 0)} of ${n(A.nodes.length, 0)} nodes · ${n(links.length, 0)} of ${n(A.links.length, 0)} links · ${n(A.islands.length, 0)} islands, the largest ${n(A.islands[0] || 0, 0)} nodes${A.capped ? ` · <b class="a">${esc(A.capped)}</b>` : ''} · built ${esc(ago(Date.now() - A.built))} ago`;
  g3LegendDraw();
}
function g3oIsland(k) { G3O.minIsland = k; document.querySelectorAll('#g3oisl button').forEach((b) => b.classList.toggle('on', +b.dataset.k === k)); g3oApply(); }
function g3oPreds() {
  const el = $('g3opreds'); if (!el || !G3O.all) return;
  const c = {}; for (const l of G3O.all.links) c[l.p] = (c[l.p] || 0) + 1;
  el.innerHTML = `<span class="muted">links</span>${Object.entries(G3_LINK).filter(([k]) => c[k]).map(([k, [col, t]]) => `<label><input type="checkbox" ${G3O.off.has(k) ? '' : 'checked'} onchange="g3oPred('${k}', this.checked)"><span class="lg-dot" style="background:${col};height:3px;width:14px"></span>${esc(t)} ${n(c[k], 0)}</label>`).join('')}`;
}
function g3oPred(k, on) { if (on) G3O.off.delete(k); else G3O.off.add(k); g3oApply(); }
function g3oFocus(x) {
  if (!G3.inst) return;
  G3.focus = x.id;
  const ls = G3O.adj.get(x.id) || [];
  G3O.near = new Set(ls.map((l) => (l.source.id === x.id ? l.target.id : l.source.id)));
  const dist = 160, r = Math.hypot(x.x, x.y, x.z) || 1, k = 1 + dist / r;
  G3.inst.cameraPosition({ x: x.x * k, y: x.y * k, z: x.z * k }, x, 900);
  G3.inst.nodeColor((m) => g3oColor(m)).linkWidth((l) => g3oLinkWidth(l));
  const page = g3PageOf(x.id);
  $('g3info').hidden = false;
  $('g3info').innerHTML = `<div style="display:flex;gap:8px;align-items:start"><div style="flex:1;min-width:0"><b>${esc(short(g3Name(x), 40))}</b>${x.label ? `<div class="muted small acct">${esc(x.id)}</div>` : ''}</div><button onclick="g3oUnfocus()" title="close">✕</button></div>
    <p class="small" style="margin:6px 0"><span class="lg-dot" style="background:${G3_NODE[g3ColorKey(x)][0]}"></span>${esc(G3_NODE[x.top]?.[1] || x.top)}${x.cut ? ' · <span class="muted">not walked through</span>' : ''} · island of ${n(G3O.all.islands[x.island], 0)}${x.bad ? `<br><span class="r">${esc(x.bad)}</span>` : ''}</p>
    <div class="bar" style="margin:6px 0">${page ? ilink(page[0], esc(page[1]) + ' →') : ''}${ilink(g3Url(x.id), 'Its own network →')}${ACCT_RE.test(x.id) ? ext(nbAddr(x.id), 'NearBlocks ↗') : ''}</div>
    <table class="small" style="table-layout:fixed;width:100%;word-break:break-all"><tr><th style="width:38%">Link</th><th>With</th></tr>${ls.slice(0, 40).map((l) => { const out = l.source.id === x.id, o = out ? l.target : l.source;
      return `<tr><td>${out ? '' : '← '}${esc((G3_LINK[l.p] || [0, l.p])[1])}${l.role ? ` (${esc(l.role.replace(/_/g, ' '))})` : ''}</td><td><a href="#" onclick="event.preventDefault();g3oFind(this.dataset.id)" data-id="${esc(o.id)}" title="${esc(o.label || o.id)}">${esc(short(o.kind === 'org' ? orgName(o.id) : o.id, 28))}</a></td></tr>`; }).join('')}${ls.length > 40 ? `<tr><td colspan="2" class="muted">… ${ls.length - 40} more</td></tr>` : ''}</table>`;
}
function g3oUnfocus() { G3.focus = null; G3O.near = null; if ($('g3info')) $('g3info').hidden = true; G3.inst?.nodeColor((m) => g3oColor(m)).linkWidth((l) => g3oLinkWidth(l)); }
/** Fly to a node by id, or the first whose id or label contains the text. */
function g3oFind(q) {
  q = String(q || '').trim().toLowerCase(); if (!q || !G3.inst) return;
  if (/^c_[\w-]+$/.test(q)) q = 'grp:' + q;
  const shown = G3.inst.graphData().nodes;
  const x = shown.find((m) => m.id === q) || shown.find((m) => m.id.includes(q) || (m.label || '').toLowerCase().includes(q));
  if (x) { g3oFocus(x); return; }
  const hidden = G3O.all?.nodes.find((m) => m.id === q || m.id.includes(q) || (m.label || '').toLowerCase().includes(q));
  $('g3meta').innerHTML = hidden ? `<span class="a">${esc(short(hidden.id, 40))} is hidden by the filters</span> · ${ilink(g3Url(hidden.id), 'its own network →')}` : `<span class="a">nothing in the map matches "${esc(q)}"</span>`;
}

async function graphPage(id) {
  const back = g3PageOf(id);
  return `<div class="card" id="g3card">${crumbs([['3D network', '/graph'], [short(id, 40)]])}
    <div class="dh-main"><div style="min-width:0"><h1 class="acct">${esc(id)}</h1>
      <div class="meta">${back ? ilink(back[0], esc(back[1]) + ' →') : ''}<span id="g3meta" class="muted">loading the network …</span></div></div></div>
    <div class="bar" style="margin:8px 0">
      <span class="muted small">Hops</span><div class="seg" id="g3hops">${[1, 2, 3].map((h) => `<button data-h="${h}" class="${h === G3.hops ? 'on' : ''}" onclick="g3SetHops(${h})">${h}</button>`).join('')}</div>
      <label class="small"><input type="checkbox" id="g3hide" ${G3.hideHubs ? 'checked' : ''} onchange="g3SetHide(this.checked)"> hide exchanges and services</label>
      <span class="spacer"></span><button onclick="g3Fit()">Fit view</button><button id="g3fullbtn" onclick="g3Full()" title="fill the screen (Esc to leave)">⛶ Fullscreen</button>
    </div>
    <style>#g3info { overflow-x:hidden; overflow-wrap:anywhere; } #g3info td, #g3info td div { white-space:normal; }${G3_FULL_CSS}</style>
    <div style="position:relative">
      <div id="g3" style="height:640px;border-radius:10px;overflow:hidden;background:#0b1220"></div>
      <div id="g3info" class="card" hidden style="position:absolute;top:10px;right:10px;width:320px;max-height:600px;overflow:auto;margin:0;opacity:.97"></div>
    </div>
    <div class="legend" id="g3legend"></div>
    <p class="muted small">Drag to turn, scroll to zoom, right-drag to pan. Hover a node or a link for what it is; click a node to focus it. Exchanges, services and contracts are shown but never walked through: two wallets paid by the same exchange are not linked.</p></div>`;
}

function g3Stop() {
  if (G3.onResize) { window.removeEventListener('resize', G3.onResize); G3.onResize = null; }
  if (G3.inst) { try { G3.inst._destructor(); } catch {} G3.inst = null; }
}
function g3SetHops(h) { G3.hops = h; document.querySelectorAll('#g3hops button').forEach((b) => b.classList.toggle('on', +b.dataset.h === h)); g3Start(G3.id); }
function g3SetHide(v) { G3.hideHubs = v; g3Refresh(); g3LegendDraw(); }
function g3Fit() { G3.inst?.zoomToFit(600, 40); }
const g3Visible = (x) => !(G3.hideHubs && g3IsHub(x) && x.id !== G3.id);

function g3Msg(html) { const el = $('g3'); if (el) el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;color:#cbd5e1">${html}</div>`; }

async function g3Start(id) {
  g3Stop();
  G3.id = id; G3.focus = null;
  const my = seq;
  if (!g3WebGL()) { $('g3meta').textContent = ''; g3Msg('Your browser cannot draw 3D graphics (WebGL is off or not supported). The 2D views on the wallet and group pages show the same links.'); return; }
  g3Msg('Loading the network … (the first view after a server restart reads the whole ontology graph and can take a few seconds)');
  let d, FG;
  try { [d, FG] = await Promise.all([get('/api/graph3d', { id, hops: G3.hops }), g3Lib()]); }
  catch (e) { if (my === seq) { $('g3meta').textContent = ''; g3Msg(esc(e.message)); } return; }
  if (my !== seq || !$('g3')) return; // the reader went elsewhere
  G3.data = d;
  const nodes = d.nodes.map((x) => ({ ...x })), links = d.links.map((l) => ({ ...l }));
  $('g3meta').innerHTML = `${n(nodes.length, 0)} nodes · ${n(links.length, 0)} links · ${d.hops} hop${d.hops > 1 ? 's' : ''}${d.capped ? ` · <b class="a">capped: ${esc(d.capped)}</b>` : ''}${!d.start_known ? ' · <span class="r">the ontology has no links for this id</span>' : ''}`;
  if (nodes.length <= 1) { g3Msg('No links in the ontology around this id yet.'); g3LegendDraw(); return; }
  const el = $('g3'); el.innerHTML = '';
  const big = nodes.length > 250;
  const inst = FG({ controlType: 'orbit' })(el)
    .width(el.clientWidth).height(el.clientHeight).backgroundColor('#0b1220').showNavInfo(false)
    .graphData({ nodes, links })
    .nodeId('id').nodeVal((x) => (x.id === id ? 14 : 1.5 + Math.min(x.degree, 40) / 4)).nodeRelSize(3).nodeResolution(big ? 6 : 10).nodeOpacity(0.95)
    .nodeColor((x) => g3NodeColor(x))
    .nodeLabel((x) => g3NodeTip(x)).nodeVisibility((x) => g3Visible(x))
    .linkSource('source').linkTarget('target')
    .linkColor((l) => (G3_LINK[l.p] || ['#94a3b8'])[0]).linkOpacity(0.55).linkWidth((l) => g3LinkWidth(l))
    .linkDirectionalArrowLength(big ? 0 : 3).linkDirectionalArrowRelPos(1).linkLabel((l) => g3LinkTip(l))
    .linkVisibility((l) => g3LinkVisible(l))
    .cooldownTicks(big ? 150 : 300).warmupTicks(big ? 40 : 0)
    .onNodeClick((x) => g3FocusNode(x))
    .onBackgroundClick(() => g3Unfocus());
  // keep the cut nodes (exchanges …) out of the centre: they have many links
  inst.d3Force('charge').strength(big ? -40 : -70);
  inst.onEngineStop(() => { if (!G3.focus && !G3.fitted) { G3.fitted = true; inst.zoomToFit(600, 40); } });
  G3.fitted = false; G3.inst = inst;
  G3.onResize = () => { if (G3.inst && $('g3')) G3.inst.width($('g3').clientWidth); };
  window.addEventListener('resize', G3.onResize);
  g3LegendDraw();
}
const g3NodeColor = (x) => (G3.focus && x.id !== G3.focus && !g3Near(x.id) ? '#334155' : G3_NODE[g3ColorKey(x)][0]);
const g3LinkWidth = (l) => (G3.focus && (g3End(l.source) === G3.focus || g3End(l.target) === G3.focus) ? 0.7 : 0); // 0 = a plain line: cheap with hundreds of links
const g3LinkVisible = (l) => typeof l.source !== 'object' || (g3Visible(l.source) && g3Visible(l.target));
/** Re-apply the accessors that read G3 (focus, hidden hubs): new functions, so the graph redraws. */
function g3Refresh() { if (G3.inst) G3.inst.nodeColor((x) => g3NodeColor(x)).linkWidth((l) => g3LinkWidth(l)).nodeVisibility((x) => g3Visible(x)).linkVisibility((l) => g3LinkVisible(l)); }
const g3End = (e) => (typeof e === 'object' ? e.id : e);
function g3Near(id) { if (!G3.focus || !G3.data) return false; return G3.data.links.some((l) => (l.source === G3.focus && l.target === id) || (l.target === G3.focus && l.source === id)); }

function g3NodeTip(x) {
  const ops = (x.operators || []).map(orgName).join(', ');
  return `<div style="max-width:320px;font:12px/1.4 system-ui;background:rgba(15,23,42,.95);color:#e2e8f0;padding:6px 8px;border-radius:6px">
    <b>${esc(short(g3Name(x), 48))}</b>${x.label ? `<br><span style="opacity:.7">${esc(short(x.id, 48))}</span>` : ''}
    <br>${esc(x.class)}${x.cut ? ' · not walked through' : ''} · ${x.hop} hop${x.hop === 1 ? '' : 's'} · ${x.degree} link${x.degree === 1 ? '' : 's'}
    ${ops ? `<br>operated by ${esc(ops)}` : ''}${x.flagged ? `<br><span style="color:#fca5a5">flagged ${esc(x.flagged.severity)}${x.flagged.reason ? ': ' + esc(short(x.flagged.reason, 90)) : ''}</span>` : ''}${x.bad && !x.flagged ? `<br><span style="color:#fca5a5">${esc(x.bad)}</span>` : ''}</div>`;
}
function g3LinkTip(l) {
  const a = g3End(l.source), b = g3End(l.target);
  return `<div style="max-width:340px;font:12px/1.4 system-ui;background:rgba(15,23,42,.95);color:#e2e8f0;padding:6px 8px;border-radius:6px">
    ${esc(short(a, 30))} <b>${esc((G3_LINK[l.p] || [0, l.p])[1])}</b>${l.role ? ` (${esc(l.role.replace(/_/g, ' '))})` : ''} ${esc(short(b, 30))}
    <br><span style="opacity:.7">source: ${esc(ONT_SOURCE[l.s] || l.s || '–')}${l.confidence != null ? ` · confidence ${n(l.confidence, 2)}` : ''}${l.status ? ` · ${esc(l.status)}` : ''}</span>${l.evidence ? `<br>${esc(short(l.evidence, 200))}` : ''}</div>`;
}

function g3FocusNode(x) {
  if (!G3.inst) return;
  G3.focus = x.id;
  const dist = 220, r = Math.hypot(x.x, x.y, x.z) || 1, k = 1 + dist / r;
  G3.inst.cameraPosition({ x: x.x * k, y: x.y * k, z: x.z * k }, x, 900);
  g3Refresh();
  const page = g3PageOf(x.id), d = G3.data;
  const ls = d.links.filter((l) => l.source === x.id || l.target === x.id);
  const ops = (x.operators || []).map(orgName);
  $('g3info').hidden = false;
  $('g3info').innerHTML = `<div style="display:flex;gap:8px;align-items:start"><div style="flex:1;min-width:0"><b>${esc(short(g3Name(x), 40))}</b>${x.label ? `<div class="muted small acct">${esc(x.id)}</div>` : ''}</div><button onclick="g3Unfocus()" title="close">✕</button></div>
    <p class="small" style="margin:6px 0"><span class="lg-dot" style="background:${G3_NODE[g3ColorKey(x)][0]}"></span>${esc(x.class)}${x.cut ? ' · <span class="muted">not walked through</span>' : ''}${ops.length ? `<br>operated by ${esc(ops.join(', '))}` : ''}
    ${x.flagged ? `<br><span class="r">flagged ${esc(x.flagged.severity)}${x.flagged.reason ? ': ' + esc(x.flagged.reason) : ''}</span>` : ''}${x.bad && !x.flagged ? `<br><span class="r">${esc(x.bad)}</span>` : ''}
    ${(x.roles || []).length ? `<br>roles: ${x.roles.map((r) => esc(`${(r.role || '?').replace(/_/g, ' ')} in ${short(r.case, 24)}${r.status ? ` (${r.status})` : ''}`)).join('; ')}` : ''}</p>
    <div class="bar" style="margin:6px 0">${page ? ilink(page[0], esc(page[1]) + ' →') : ''}${x.id !== G3.id ? ilink(g3Url(x.id), 'Centre here') : ''}${ACCT_RE.test(x.id) ? ext(nbAddr(x.id), 'NearBlocks ↗') : ''}</div>
    <table class="small" style="table-layout:fixed;width:100%;word-break:break-all"><tr><th style="width:38%">Link</th><th>With</th></tr>${ls.slice(0, 40).map((l) => { const out = l.source === x.id, o = out ? l.target : l.source;
      return `<tr><td>${out ? '' : '← '}${esc((G3_LINK[l.p] || [0, l.p])[1])}${l.role ? ` (${esc(l.role.replace(/_/g, ' '))})` : ''}</td><td><a href="#" onclick="event.preventDefault();g3FocusId(this.dataset.id)" data-id="${esc(o)}">${esc(short(o, 28))}</a>${l.evidence ? `<div class="muted">${esc(short(l.evidence, 80))}</div>` : ''}</td></tr>`; }).join('')}${ls.length > 40 ? `<tr><td colspan="2" class="muted">… ${ls.length - 40} more</td></tr>` : ''}</table>`;
}
function g3FocusId(id) { const x = G3.inst?.graphData().nodes.find((m) => m.id === id); if (x) g3FocusNode(x); }
function g3Unfocus() { G3.focus = null; if ($('g3info')) $('g3info').hidden = true; g3Refresh(); }

function g3LegendDraw() {
  const el = $('g3legend'); if (!el) return;
  const d = G3.data || { nodes: [], links: [] };
  const nc = {}, lc = {};
  for (const x of d.nodes) nc[g3ColorKey(x)] = (nc[g3ColorKey(x)] || 0) + 1;
  for (const l of d.links) lc[l.p] = (lc[l.p] || 0) + 1;
  el.innerHTML = `<b class="small">Nodes</b>${Object.entries(G3_NODE).filter(([k]) => nc[k]).map(([k, [c, t]]) => `<span><span class="lg-dot" style="background:${c};border-radius:50%"></span>${esc(t)} ${nc[k]}</span>`).join('')}
    <b class="small" style="margin-left:10px">Links</b>${Object.entries(G3_LINK).filter(([k]) => lc[k]).map(([k, [c, t]]) => `<span><span class="lg-dot" style="background:${c};height:3px;width:14px"></span>${esc(t)} ${lc[k]}</span>`).join('')}
    ${G3.hideHubs ? `<span class="muted">exchanges and services hidden</span>` : ''}`;
}
