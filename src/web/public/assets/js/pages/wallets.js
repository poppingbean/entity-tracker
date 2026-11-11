// ================================================================== WALLETS & GROUPS
// ---- tag groups: early wallets by what they do (win-rate tag, behaviours), standalone or not
const TGNAME = (id) => ({ cobuy: 'Co-buy swarm', insider: 'Insiders', 'rug-linked': 'Rug-linked' }[id] || id);
views.taggroups = async () => {
  const j = await get('/api/tag-groups');
  const card = (r) => `<a class="card tgcard" href="${esc(P.tgp(r.id))}" onclick="return navA(event,this)" style="display:block;text-decoration:none;color:inherit">
      <div class="head"><h2>${r.kind === 'tag' ? tg(r.id) : `<span class="chip">${esc(TGNAME(r.id))}</span>`}</h2><span class="muted small">${n(r.wallets, 0)} wallets</span></div>
      ${r.about ? `<p class="muted small" style="margin:0 0 8px">${esc(r.about)}</p>` : ''}
      <div class="tiles">${tile('Standalone', n(r.standalone, 0), 'in no linked group')}${tile('In linked groups', n(r.linked, 0))}${tile('NEAR in', n(r.near, 0) + ' N')}${tile('P&L', signed(r.pnl_near, 0) + ' N', r.profit_rate != null ? `avg ${pct(r.profit_rate)} of tokens in profit` : '', roiCls(r.pnl_near))}</div></a>`;
  return `<div class="card"><p class="muted" style="margin:0">Tag groups sort every early wallet by <b>what it does</b>: its win-rate tag and its behaviours (co-buy swarms, insider buys, rug links). They are not owners: wallets controlled by one owner are in <a href="/groups" onclick="return navA(event,this)">linked groups</a>, which only follow money (funding, transfers, shared funders). A wallet linked to nobody is only here.</p></div>
    <h3 class="muted" style="margin:6px 2px">By win-rate tag</h3><div class="grid2">${j.rows.filter((r) => r.kind === 'tag').map(card).join('')}</div>
    <h3 class="muted" style="margin:6px 2px">By behaviour</h3><div class="grid2">${j.rows.filter((r) => r.kind === 'behaviour').map(card).join('')}</div>`;
};
async function tagGroupPage(id) {
  const S = ST.taggroups;
  const j = await get('/api/tag-group', { id, only: S.only, sort: S.sort, limit: 50, offset: S.offset });
  const name = j.kind === 'tag' ? id : TGNAME(id);
  return `<div class="card">${crumbs([['Tag groups', '/taggroups'], [name]])}
    <div class="dh-main">${avatar(id, name, 54)}<div style="min-width:0"><h1>${j.kind === 'tag' ? tg(id) : esc(name)} <span class="muted">tag group</span></h1>
      <div class="meta"><span>${n(j.total, 0)} wallets</span><span>${esc(j.about || (id === 'unrated' ? 'too few tokens judged yet' : TAGHELP))}</span></div></div></div></div>
  <div class="card"><div class="bar">${seg('taggroups', 'only', [['', 'All'], ['standalone', 'Standalone'], ['linked', 'In linked groups']])}${sel('taggroups', 'sort', [['pnl', 'by P&L'], ['near', 'by NEAR in'], ['tokens', 'by tokens'], ['profit', 'by profitable share']])}<span class="spacer"></span>${pager('taggroups', j.total)}</div>
    <table><tr><th>Wallet</th><th>Tag</th><th>Behaviours</th><th>Linked group</th><th class="num">Tokens</th><th class="num">Profitable</th><th class="num">NEAR in</th><th class="num">P&amp;L N</th><th class="num">Co-buy partners</th></tr>
    ${j.rows.map((w) => `<tr ${row(P.wal(w.id))}><td>${walLink(w.id, 28)}</td><td>${tg(w.tag)}</td><td>${w.behaviours.map((b) => ilink(P.tgp(b), `<span class="chip">${esc(TGNAME(b))}</span>`)).join(' ') || '<span class="muted">–</span>'}</td>
      <td>${w.cluster_id ? `${tg(w.cluster_tag)} ${ilink(P.grp(w.cluster_id), `<span class="acct">${esc(short(w.cluster_id, 14))}</span>`)}` : '<span class="v solo">standalone</span>'}</td>
      <td class="num">${w.stats.tokens_n ?? '–'}</td><td class="num">${pct(w.stats.profit_rate)}</td><td class="num">${n(w.stats.total_buy_near, 1)}</td><td class="num ${roiCls(w.stats.pnl_near)}">${signed(w.stats.pnl_near)}</td><td class="num">${w.cobuy_n || '–'}</td></tr>`).join('') || empty(9, 'no wallets')}</table></div>`;
}
views.groups = async () => {
  const S = ST.groups, j = await get('/api/clusters', { tag: S.tag, q: S.q, sort: S.sort, limit: 50, offset: S.offset });
  return `<div class="card"><div class="bar">${seg('groups', 'tag', [['', 'All'], ['win80', 'win80'], ['win50', 'win50'], ['win30', 'win30'], ['sniper', 'sniper'], ['loss', 'loss'], ['unrated', 'Unrated']])}
    ${sel('groups', 'sort', [['winrate', 'by profitable share'], ['size', 'by size'], ['score', 'by score'], ['pnl', 'by P&L'], ['recent', 'most recent entry']])}${qbox('groups', 'wallet / group id / label')}<span class="spacer"></span>${pager('groups', j.total)}</div>
    <table><tr><th>Group</th><th>Tag</th><th>Flags</th><th class="num">Wallets</th><th class="num">Linked wallets</th><th class="num">Tokens</th><th class="num">Profitable</th><th class="num">Rug</th><th class="num">ROI</th><th class="num">P&amp;L N</th><th class="num">Realized</th><th class="num">Unrealized</th><th>Last entry</th></tr>
    ${j.rows.map((c) => `<tr ${row(P.grp(c.id))}><td><span class="ent">${avatar(c.id, c.ai?.label || c.id, 28)}<span><b>${ilink(P.grp(c.id), esc(short(c.ai?.label || c.id, 32)))}</b><small class="acct">${esc(short(c.id, 24))}</small></span></span></td>
      <td>${tg(c.tag)}</td><td class="wrap">${c.weak_only ? '<span class="chip" title="linked only by co-buys, no money link">co-buy only</span> ' : ''}${c.creator_flag === 'blacklisted' || c.creator_flag === 'rugger' ? '<span class="v bad">creator rug</span> ' : ''}${tags(c.rule?.tags)}</td><td class="num">${c.size}${c.weak_members?.length && !c.weak_only ? ` <span class="muted small" title="attached only by co-buys">+${c.weak_members.length} co-buy</span>` : ''}</td>
      <td class="num">${c.network_n ?? '–'}</td><td class="num">${c.metrics.tokens_n}</td><td class="num">${pct(c.metrics.profit_rate)}</td><td class="num">${pct(c.metrics.rug_share)}</td>
      <td class="num ${roiCls(c.metrics.roi_weighted)}">${pct(c.metrics.roi_weighted)}</td><td class="num ${roiCls(c.metrics.pnl_near)}">${signed(c.metrics.pnl_near)}</td><td class="num ${roiCls(c.metrics.realized_near)}">${signed(c.metrics.realized_near)}</td><td class="num ${roiCls(c.metrics.unrealized_near)}">${signed(c.metrics.unrealized_near)}</td><td>${since(c.metrics.last_entry_ts)}</td></tr>`).join('') || empty(13, 'no groups yet')}</table></div>`;
};

async function groupPage(id) {
  const [c, g] = await Promise.all([get('/api/cluster', { id }), get('/api/graph', { id })]);
  const m = c.metrics || {}, ai = c.ai, label = ai?.label || (c.rule?.tags || [])[0] || c.id;
  let h = `<div class="card">${crumbs([['Groups', '/groups'], [short(label, 40)]])}<div style="float:right;position:relative">${reportBtn('group', c.id)} ${watchBtn('group', c.id)}</div>${''}
    <div class="dh-main">${avatar(c.id, label, 54)}<div style="min-width:0"><h1>${esc(label)} ${tg(c.tag)} ${c.creator_flag === 'blacklisted' || c.creator_flag === 'rugger' ? '<span class="v bad" title="a token creator in this group rugged or is blacklisted">creator rug</span>' : ''} <span class="chip">${pct(m.profit_rate)} of ${m.tokens_n ?? 0} tokens in profit</span></h1>
      <div class="meta"><span class="acct">${esc(c.id)}</span><span>${c.weak_only ? `${c.size} wallets linked only by co-buys (no money link)` : `${c.size - (c.weak_members || []).length} wallets linked by money${(c.weak_members || []).length ? ` · ${c.weak_members.length} attached only by co-buys` : ''}`}</span>${c.rule ? `<span>rule score ${n(c.rule.score, 0)} (${esc(c.rule.verdict)})</span>` : ''}<span>updated ${since(c.updated_ts)}</span>${tags(c.rule?.tags)}</div></div></div>
    <div class="tiles">${tile('Judged tokens', m.tokens_n ?? '–', `${m.entries_n ?? '–'} entries`)}${tile('Profitable tokens', pct(m.profit_rate), `${m.profit_tokens_n ?? 0} of ${m.tokens_n ?? 0} · gained 20 %+ in ${pct(m.win_rate)}`, (m.profit_rate ?? 0) >= 0.5 ? 'g' : (m.profit_rate ?? 1) < 0.3 ? 'r' : 'a')}${tile('P&L', signed(m.pnl_near) + ' N', `${n(m.total_buy_near, 1)} N bought`, roiCls(m.pnl_near))}${tile('Realized P&L', signed(m.realized_near) + ' N', 'taken out of the tokens sold', roiCls(m.realized_near))}${tile('Unrealized P&L', signed(m.unrealized_near) + ' N', 'still held, at the latest price', roiCls(m.unrealized_near))}
      ${tile('Weighted ROI', pct(m.roi_weighted), `median token ${pct(m.median_token_roi)}`, roiCls(m.roi_weighted))}${tile('Rugged tokens', pct(m.rug_share), `${m.rug_tokens_n ?? 0} tokens${m.win_rate_in_rugs !== undefined ? ' · win in rugs ' + pct(m.win_rate_in_rugs) : ''}`, (m.rug_share ?? 0) >= 0.4 ? 'r' : '')}
      ${m.creator_linked_share !== undefined ? tile('Creator-linked', pct(m.creator_linked_share), null, (m.creator_linked_share ?? 0) > 0.1 ? 'r' : '') : ''}${tile('Linked wallets', c.network_n ?? 0, 'around the members')}${tile('Token creators', c.creators_n ?? 0, `${c.creators_rugged ?? 0} rugged or blacklisted`, (c.creators_rugged ?? 0) ? 'r' : '')}${m.avg_delay_s !== undefined ? tile('Avg entry delay', n(m.avg_delay_s, 0) + ' s', `first-5 share ${pct(m.first_movers_share)}`) : ''}${m.fresh_share !== undefined ? tile('Fresh / synced', `${pct(m.fresh_share)} / ${pct(m.sync_share)}`, 'wallets < 3 d / synchronised buys') : ''}</div></div>`;
  if (ai) h += `<div class="ai"><b>${esc(ai.label || 'AI review')}</b> · ${vb(ai.verdict)} confidence ${n(ai.confidence)} · ${esc(ai.archetype)} · advice <b>${esc(ai.follow_advice)}</b> <span class="muted">(${when(ai.ts)})</span>
      <p>${esc(ai.summary)}</p>${ungroundedLine(ai.unverified)}${(ai.reasons || []).length ? '<ul class="flags">' + ai.reasons.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}${(ai.red_flags || []).length ? '<p class="a"><b>Caution</b></p><ul class="flags">' + ai.red_flags.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}</div>`;
  else h += '<div class="card muted">No NEAR AI review yet (needs NEAR_AI_API_KEY and at least the minimum number of judged tokens).</div>';
  h += `<div class="card"><h2>Tokens the group bought early <span class="muted">${(c.tokens || []).length}</span></h2><table><tr><th>Token</th><th>Live</th><th class="num">Wallets</th><th class="num">Bought N</th><th class="num">ROI</th><th class="num">P&amp;L N</th><th class="num" title="NEAR taken out minus the cost of the tokens sold">Realized</th><th class="num" title="tokens still held, at the latest price, minus their cost">Unrealized</th><th class="num">Peak</th><th>Rug</th><th class="num">1st buy</th></tr>
    ${(c.tokens || []).map((t) => `<tr ${row(P.tok(t.token))}><td>${tokCell(t.token, t.symbol, t.launchpad, 22)}</td><td>${when(t.live_ts)}</td><td class="num">${t.wallets}</td><td class="num">${n(t.buy_near, 1)}</td><td class="num ${roiCls(t.roi)}">${pct(t.roi)}</td><td class="num ${roiCls(t.pnl_near)}">${signed(t.pnl_near)}</td><td class="num ${roiCls(t.realized_near)}">${signed(t.realized_near)}</td><td class="num ${roiCls(t.unrealized_near)}">${signed(t.unrealized_near)}</td><td class="num">x${n(t.peak_multiple, 1)}</td><td class="${t.rugged ? 'r' : 'muted'}">${t.rugged ? 'RUG' : '–'}</td><td class="num">${t.first_delay_s}s</td></tr>`).join('') || empty(11, 'none')}</table></div>`;
  if ((c.creators || []).length) h += `<div class="card"><h2>Contract creators in this group <span class="muted">members or linked wallets that launched tokens, or sit on the dev-rug blacklist</span></h2>
    <table><tr><th>Creator</th><th>Role</th><th>Status</th><th class="num">Launches</th><th class="num">Rugged</th><th>Tokens</th></tr>
    ${c.creators.map((x) => `<tr ${row(P.creator(x.account))}><td>${nb(x.account)}</td><td>${x.role === 'member' ? '<span class="chip ai">member</span>' : `<span class="chip">linked · ${x.depth} hop${x.depth > 1 ? 's' : ''}</span>`}</td><td>${x.blacklisted ? `<span class="v bad" title="${esc(x.blacklisted.reason || '')}">blacklisted</span>` : x.rugged ? '<span class="v bad">rugger</span>' : '<span class="v unrated">creator</span>'}</td><td class="num">${x.launches}</td><td class="num ${x.rugged ? 'r' : 'muted'}">${x.rugged}</td>
      <td class="wrap">${(x.tokens || []).map((t) => `<a class="gchip" href="${esc(P.tok(t.id))}" onclick="event.stopPropagation();return navA(event,this)"><i style="background:${t.rugged ? 'var(--loss)' : 'var(--unknown)'}"></i><span>${esc(t.symbol || short(t.id, 12))}${t.rugged ? ' · rug' : ''}</span></a>`).join('') || '<span class="muted small">no launches recorded</span>'}${x.blacklisted?.symbol && !(x.tokens || []).length ? esc(x.blacklisted.symbol) : ''}</td></tr>`).join('')}</table></div>`;
  h += `<div class="card"><h2>Member wallets <span class="muted">${c.wallets.length}</span></h2><table><tr><th>Wallet</th><th>Funded by</th><th>Kind</th><th class="num">Age</th><th class="num">Txs</th><th class="num">Tokens</th><th>Tag</th><th class="num">Profitable</th><th class="num">ROI</th><th class="num">P&amp;L N</th><th class="num">Realized</th><th class="num">Unrealized</th></tr>
    ${c.wallets.map((w) => `<tr ${row(P.wal(w.id))}><td>${walLink(w.id)}${(c.weak_members || []).includes(w.id) && !c.weak_only ? ' <span class="chip" title="no money link to the group, only co-buys">co-buy only</span>' : ''}</td><td>${acct(w.funder, 20)} <span class="muted">${esc(w.funder_kind || '')}</span></td><td>${esc(w.kind || '')}</td><td class="num">${w.created_ts ? ago(Date.now() - w.created_ts) : '–'}</td><td class="num">${w.tx_count ?? '–'}</td><td class="num">${w.stats?.tokens_n ?? '–'}</td><td>${tg(w.tag)}</td><td class="num">${pct(w.stats?.profit_rate)}</td><td class="num ${roiCls(w.stats?.roi_weighted)}">${pct(w.stats?.roi_weighted)}</td><td class="num ${roiCls(w.stats?.pnl_near)}">${signed(w.stats?.pnl_near)}</td><td class="num ${roiCls(w.stats?.realized_near)}">${signed(w.stats?.realized_near)}</td><td class="num ${roiCls(w.stats?.unrealized_near)}">${signed(w.stats?.unrealized_near)}</td></tr>`).join('')}</table></div>`;
  h += `<div class="card"><h2>Funding &amp; money-flow graph</h2>${graphBlock(g, 'grp')}<div class="legend"><span><span class="lg-dot" style="background:var(--accent)"></span>member wallet</span><span><span class="lg-dot neutral"></span>funder / anchor</span><span><span class="lg-dot unknown"></span>exchange / relayer / other</span><span class="g">— funded by</span><span class="r">— NEAR sent to</span></div></div>`;
  const netByDepth = [1, 2, 3].map((d) => (c.network || []).filter((x) => x.depth === d));
  h += `<div class="card"><h2>Linked wallets <span class="muted">${c.network_n ?? 0} around the members: funders, destinations and the wallets behind them</span></h2>
    <div class="tiles">${netByDepth.map((l, i) => tile(`${i + 1} hop${i ? 's' : ''} away`, l.length, `${l.filter((x) => x.tokens_traded).length} trade launch tokens`)).join('')}</div>
    <table><tr><th>Wallet</th><th class="num">Hops</th><th>Kind</th><th class="num">Txs</th><th class="num">Launch tokens traded</th><th class="num">NEAR traded</th></tr>
    ${(c.network || []).slice(0, 60).map((x) => `<tr ${row(P.ent(x.account))}><td>${nb(x.account)}</td><td class="num">${x.depth}</td><td>${esc(x.kind || (x.profiled ? '' : 'not profiled yet'))}</td><td class="num">${x.tx_count ?? '–'}</td><td class="num ${x.tokens_traded ? 'b' : 'muted'}">${x.tokens_traded || '–'}</td><td class="num">${x.traded_near ? n(x.traded_near, 1) : '–'}</td></tr>`).join('') || empty(6, 'no linked wallets found yet: they are profiled a few at a time in the background')}</table></div>`;
  h += '<div class="grid2">' + (c.links ? `<div class="card"><h2>Why these wallets are one group</h2><table><tr><th>Link</th><th>Anchor</th><th class="num">Wallets</th></tr>${(c.links || []).slice(0, 40).map((l) => `<tr><td><span class="chip">${esc(l.type)}</span>${l.depth ? ` <span class="muted small">${l.depth} hops</span>` : ''}</td><td>${ACCT_RE.test(l.anchor || '') ? ilink(P.ent(l.anchor), esc(short(l.anchor, 36)), l.anchor) + ' ' + ext(nbAddr(l.anchor), '↗') : esc(short(l.anchor, 36))}</td><td class="num">${l.wallets.length}</td></tr>`).join('') || empty(3, 'no links recorded')}</table></div>` : `<div class="card"><h2>How these wallets are linked</h2><p class="muted">${c.links_n ?? 0} on-chain links between the members and the wallets around them (funding and money flow). See the graph above.</p></div>`);
  h += `<div class="card"><h2>Review history <span class="muted">rules / NEAR AI</span></h2><table><tr><th>When</th><th>Verdict</th><th class="num">Score</th><th>AI</th><th class="num">Tokens</th></tr>${(c.history || []).map((x) => `<tr><td>${when(x.ts)}</td><td>${vb(x.verdict)}</td><td class="num">${n(x.score, 0)}</td><td>${x.ai_verdict ? esc(x.ai_verdict) + ' ' + n(x.ai_confidence) : '–'}</td><td class="num">${x.tokens_n ?? '–'}</td></tr>`).join('') || empty(5, 'no history yet')}</table></div></div>`;
  return h;
}

// Funding & money-flow graph. Full view: funders on top, member wallets in the middle, destinations of NEAR at the bottom, long rows
// wrapped. Click an address: only the wallets it received NEAR from (above) or sent NEAR to (below) stay; Reset shows everyone again.
const GRAPHS = {};
const GMAX_ROW = 28; // nodes per row before a level wraps onto another row
function graphBlock(g, key = 'g') {
  GRAPHS[key] = { g, focus: null };
  return `<div id="graph-${key}">${graphView(key)}</div>`;
}
function graphFocus(key, id) { const st = GRAPHS[key]; if (!st) return; st.focus = st.focus === id ? null : id; $(`graph-${key}`).innerHTML = graphView(key); }
function graphReset(key) { const st = GRAPHS[key]; if (!st) return; st.focus = null; $(`graph-${key}`).innerHTML = graphView(key); }
function graphView(key) {
  const { g, focus } = GRAPHS[key];
  if (!g?.nodes?.length) return '<p class="muted">no graph data</p>';
  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  let nodes, edges, rows;
  if (focus) {
    // only the transfers in and out of the focused address, and the addresses on their other end
    edges = g.edges.filter((e) => e.from === focus || e.to === focus);
    const inn = new Set(edges.filter((e) => e.to === focus).map((e) => e.from)), out = new Set(edges.filter((e) => e.from === focus).map((e) => e.to));
    const both = [...inn].filter((x) => out.has(x));
    rows = [[...inn].filter((x) => !out.has(x)), both, [focus], [...out].filter((x) => !inn.has(x))].filter((r) => r.length);
    nodes = new Set([focus, ...inn, ...out]);
  } else {
    edges = g.edges;
    const lvl = new Map(g.nodes.map((x) => [x.id, x.member ? 0 : null]));
    const fund = edges.filter((e) => e.type === 'fund'), flow = edges.filter((e) => e.type === 'flow');
    for (let pass = 0; pass < 6; pass++) for (const e of fund) { const c = lvl.get(e.to), f = lvl.get(e.from); if (c != null && lvl.has(e.from) && (f == null || f > c - 1)) lvl.set(e.from, c - 1); } // funders above whoever they fund
    for (const e of flow) if (lvl.has(e.to) && lvl.get(e.to) == null) lvl.set(e.to, 1);
    for (const [id, v] of lvl) if (v == null) lvl.set(id, -1);
    rows = [...new Set(lvl.values())].sort((a, b) => a - b).map((v) => [...lvl].filter(([, x]) => x === v).map(([id]) => id));
    nodes = new Set(g.nodes.map((x) => x.id));
  }
  // wrap long rows so a big group does not become one solid bar
  const lines = rows.flatMap((r) => Array.from({ length: Math.ceil(r.length / GMAX_ROW) }, (_, k) => r.slice(k * GMAX_ROW, (k + 1) * GMAX_ROW)));
  const W = 1000, rowH = focus ? 130 : 90, H = lines.length * rowH + 40, pos = new Map();
  lines.forEach((r, li) => r.forEach((id, i) => pos.set(id, { x: 20 + ((i + 0.5) * (W - 40)) / r.length, y: 34 + li * rowH + (r.length > 12 && !focus ? (i % 2) * 14 : 0) })));
  const node = (id) => byId.get(id) || { id, member: false, kind: null };
  const color = (x) => (x.member ? 'var(--accent)' : x.kind === 'wallet' || x.kind == null ? 'var(--neutral)' : 'var(--unknown)');
  const labels = focus || nodes.size <= 40;
  const edgeSvg = edges.map((e) => { const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return ''; const col = e.type === 'fund' ? 'var(--good)' : 'var(--bad)';
    const mid = a.y === b.y ? `${(a.x + b.x) / 2},${a.y - 40}` : null;
    const d = mid ? `M${a.x},${a.y} Q${mid} ${b.x},${b.y}` : `M${a.x},${a.y} C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y}`;
    const amt = focus && e.near ? `<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 4}" text-anchor="middle" font-size="10" pointer-events="none" style="fill:${col}">${esc(n(e.near, 1))} N</text>` : '';
    return `<path d="${d}" fill="none" pointer-events="none" style="stroke:${col}" stroke-opacity="${focus ? 0.8 : 0.5}" stroke-width="${Math.min(3.5, 0.8 + Math.log10(1 + (e.near || 0)))}"><title>${e.type === 'fund' ? 'funded' : 'NEAR sent'}: ${esc(short(e.from, 24))} → ${esc(short(e.to, 24))} · ${n(e.near, 2)} N${e.n ? ' · ' + e.n + ' transfers' : ''}</title></path>${amt}`; }).join('');
  const nodeSvg = [...nodes].map((id) => { const x = node(id), p = pos.get(id); if (!p) return ''; const me = id === focus;
    return `<g style="cursor:pointer" onclick="graphFocus('${key}', this.dataset.id)" data-id="${esc(id)}"><circle cx="${p.x}" cy="${p.y}" r="${me ? 16 : 11}" fill="transparent"/><circle cx="${p.x}" cy="${p.y}" r="${me ? 11 : x.member ? 7 : 5}" style="fill:${color(x)}${me ? ';stroke:var(--text);stroke-width:2.5' : ''}"><title>${esc(id)}${x.kind ? ' · ' + esc(x.kind) : ''}${x.tx_count != null ? ' · ' + x.tx_count + ' txs' : ''}\nclick: ${me ? 'show everyone again' : 'show only its transfers'}</title></circle>${labels ? `<text x="${p.x}" y="${p.y + (me ? 26 : 18)}" style="fill:${me ? 'var(--text)' : 'var(--muted)'}" font-size="${me ? 12 : 9}" font-weight="${me ? 700 : 400}" text-anchor="middle">${esc(short(id, me ? 30 : 14))}</text>` : ''}</g>`; }).join('');
  let bar;
  if (focus) {
    const x = node(focus), inN = new Set(edges.filter((e) => e.to === focus).map((e) => e.from)).size, outN = new Set(edges.filter((e) => e.from === focus).map((e) => e.to)).size;
    const page = x.member ? ilink(P.wal(focus), 'Wallet page →') : ilink(P.ent(focus), 'Entity page →');
    bar = `<div class="bar" style="margin-bottom:8px"><span>Showing <b class="acct">${esc(short(focus, 40))}</b> · <span class="g">${inN} sent NEAR to it</span> · <span class="r">${outN} received NEAR from it</span></span>${page}${ext(nbAddr(focus), 'NearBlocks ↗')}<span class="spacer"></span><button class="primary" onclick="graphReset('${key}')">Reset · show all ${g.nodes.length}</button></div>`;
  } else bar = `<div class="muted small" style="margin-bottom:6px">Click an address to show only the wallets it received NEAR from or sent NEAR to.</div>`;
  return `${bar}<svg class="graph" viewBox="0 0 ${W} ${H}">${edgeSvg}${nodeSvg}</svg>`;
}

views.wallets = async () => {
  const S = ST.wallets, j = await get('/api/wallets', { q: S.q, tag: S.tag, sort: S.sort, limit: 50, offset: S.offset });
  return `<div class="card"><div class="bar">${seg('wallets', 'tag', [['', 'All'], ['win80', 'win80'], ['win50', 'win50'], ['win30', 'win30'], ['sniper', 'sniper'], ['loss', 'loss'], ['unrated', 'Unrated']])}
    ${sel('wallets', 'sort', [['tokens', 'by tokens'], ['winrate', 'by profitable share'], ['pnl', 'by P&L'], ['roi', 'by ROI'], ['recent', 'newest']])}${qbox('wallets', 'wallet contains…')}<span class="spacer"></span>${pager('wallets', j.total)}</div>
    <table><tr><th>Wallet</th><th>Tag</th><th>Group</th><th>Funded by</th><th class="num">Age</th><th class="num">Txs</th><th class="num">Tokens</th><th class="num">Profitable</th><th class="num">ROI</th><th class="num">P&amp;L N</th><th class="num">Realized</th><th class="num">Unrealized</th><th class="num">Rug</th></tr>
    ${j.rows.map((w) => `<tr ${row(P.wal(w.id))}><td><span class="ent">${avatar(w.id, w.id, 26)}<span>${walLink(w.id, 28)}</span></span></td><td>${tg(w.tag)}</td><td>${w.cluster_id ? tg(w.cluster_tag) + ' ' + ilink(P.grp(w.cluster_id), `<span class="acct">${esc(short(w.cluster_id, 18))}</span>`) : '<span class="muted">unlinked</span>'}</td>
      <td>${acct(w.funder, 18)} <span class="muted">${esc(w.funder_kind || '')}</span></td><td class="num">${w.created_ts ? ago(Date.now() - w.created_ts) : '–'}</td><td class="num">${w.tx_count ?? '–'}</td><td class="num">${w.stats?.tokens_n ?? '–'}</td><td class="num">${pct(w.stats?.profit_rate)}</td>
      <td class="num ${roiCls(w.stats?.roi_weighted)}">${pct(w.stats?.roi_weighted)}</td><td class="num ${roiCls(w.stats?.pnl_near)}">${signed(w.stats?.pnl_near)}</td><td class="num ${roiCls(w.stats?.realized_near)}">${signed(w.stats?.realized_near)}</td><td class="num ${roiCls(w.stats?.unrealized_near)}">${signed(w.stats?.unrealized_near)}</td><td class="num">${pct(w.stats?.rug_share)}</td></tr>`).join('') || empty(13, 'no wallets')}</table></div>`;
};

/** Links to a wallet's tag groups: its win-rate tag and its behaviours. */
const BEH = { cobuy: 'co-buy swarm', insider: 'insider', 'rug-linked': 'rug-linked' };
const tagGroupChips = (w) => [ilink(P.tgp(tagOk(w.tag)), tg(w.tag), 'tag group: ' + tagOk(w.tag)), ...(w.behaviours || []).map((b) => ilink(P.tgp(b), `<span class="chip">${esc(BEH[b] || b)}</span>`, BEH[b] || b))].join(' ');
/** A wallet the tracker has not profiled (not an early launch buyer): what the chain shows, and what Safe Near knows about it. */
function onchainWalletPage(id, v) {
  const nb = (a) => `<a href="https://nearblocks.io/address/${esc(a)}" target="_blank" rel="noopener" class="acct">${esc(short(a, 30))}</a>`;
  const tx = (h) => `<a href="https://nearblocks.io/txns/${esc(h)}" target="_blank" rel="noopener"><code>${esc(short(h, 12))}</code></a>`;
  const money = (l) => l.map((m) => `${n(m.amount, m.amount < 10 ? 3 : 0)} ${esc(m.symbol)}${m.usd != null ? ` <span class="muted">(${usd(m.usd)})</span>` : ''}`).join('<br>');
  let h = `<div class="card">${crumbs([['Wallets', '/wallets'], [short(id, 40)]])}
    <div class="dh-main">${avatar(id, id, 54)}<div style="min-width:0"><h1 class="acct">${esc(id)}</h1>
      <div class="meta">${v.label ? `<span class="chip">${esc(v.label)}</span>` : ''}${v.contract ? '<span class="chip">contract</span>' : ''}<span>${v.first_ts ? `active since ${new Date(v.first_ts).toISOString().slice(0, 10)}` : ''}</span><span>${n(v.tx_count, 0)} transactions</span>
        <a href="https://nearblocks.io/address/${esc(id)}" target="_blank" rel="noopener">NearBlocks ↗</a> ${ilink('/firewall?q=' + encodeURIComponent(id), 'Safety Check →')}</div></div></div>
    <div class="tiles" style="margin-top:12px">${tile('NEAR', n(v.balance_near, 2), usd(v.balance_usd))}${tile('Tokens', usd(v.tokens_usd), `${v.tokens.length} held`)}${tile('NFT collections', n(v.nft_collections, 0))}
      ${tile('Keys', `${v.keys.full} full`, `${v.keys.app} app keys`, v.keys.full > 1 ? 'a' : '')}${tile('Tokens launched', n(v.launches, 0), v.launches ? ilink(P.creator(id), 'creator page →') : 'none')}</div>
    <p class="muted small" style="margin:10px 0 0">The tracker profiles the early buyers of launchpad tokens (groups, tags, track record); this wallet is not one of them, so this is its on-chain view.</p></div>`;
  if (v.incidents.length || v.flags.length) h += `<div class="banner bad" style="display:block"><b>Linked to ${v.incidents.length ? `${v.incidents.length > 1 ? `${v.incidents.length} hacks` : 'a hack'}` : 'a report'}</b>
    ${v.incidents.map((i) => `<div class="small" style="margin-top:6px">${esc(i.role ? `This account is ${i.role.replace(/^cash out wallet$/, 'a wallet the stolen money went through')}` : 'Involved')}: ${esc(i.headline || `~${usd(i.stolen_usd)} taken`)} ${ilink('/firewall/' + encodeURIComponent(i.id), 'Investigation →')}</div>`).join('')}
    ${!v.incidents.length ? v.flags.map((f) => `<div class="small" style="margin-top:6px">${esc(f.severity)}: ${esc(f.reason)}</div>`).join('') : ''}</div>`;
  h += `<div class="grid2"><div class="card"><h2>Recent transactions <span class="muted">latest ${v.recent.length}</span></h2>
      <table class="small"><tr><th>When</th><th>What</th><th>In</th><th>Out</th><th>Tx</th></tr>
      ${v.recent.map((r) => `<tr><td style="white-space:nowrap">${since(r.ts)}</td><td class="wrap">${r.signer === id ? '' : `${nb(r.signer)} → `}${r.receiver === id ? 'this wallet' : nb(r.receiver)}<div class="muted">${esc(r.did)}${r.failed ? ' <span class="r">failed</span>' : ''}</div></td>
        <td class="g">${money(r.in)}</td><td class="r">${money(r.out)}</td><td>${tx(r.tx)}</td></tr>`).join('') || empty(5, 'No transaction.')}</table></div>
    <div class="card"><h2>Tokens held <span class="muted">${usd(v.tokens_usd)}</span></h2><table class="small">${v.tokens.map((t) => `<tr><td>${esc(t.symbol)} <span class="muted">${esc(short(t.token, 30))}</span></td><td class="num">${n(t.amount, t.amount < 10 ? 3 : 0)}</td><td class="num">${usd(t.usd)}</td></tr>`).join('') || empty(3, 'No priced token.')}</table>
      ${v.entity ? `<p class="small muted" style="margin:10px 0 0">Known to the tracker as ${esc(v.entity.label || v.entity.kind)}${v.entity.funded_n ? `, funded ${v.entity.funded_n} early wallets` : ''}.</p>` : ''}</div></div>`;
  return h;
}

async function walletPage(id) {
  const [w, ont] = await Promise.all([get('/api/wallet', { id }), ontologyOf(id)]);
  if (w.onchain) return onchainWalletPage(w.id, w.onchain);
  const s = w.stats || {}, c = w.cluster;
  let h = `<div class="card">${crumbs([['Wallets', '/wallets'], [short(w.id, 40)]])}<div style="float:right;position:relative">${reportBtn('wallet', w.id)} ${watchBtn('wallet', w.id)}</div>${''}
    <div class="dh-main">${avatar(w.id, w.id, 54)}<div style="min-width:0"><h1 class="acct">${esc(w.id)} ${tg(w.tag)}</h1>
      <div class="meta">${w.creator ? `<span>${ilink(P.creator(w.id), 'creator of ' + w.creator.launches + ' token' + (w.creator.launches === 1 ? '' : 's'))}</span> ${crChip(w.creator)}` : ''}${w.kind ? `<span class="chip">${esc(w.kind)}</span>` : ''}<span>${w.tx_count ?? '–'} txs</span><span>created ${when(w.created_ts)}</span>${ext(nbAddr(w.id), 'NearBlocks ↗')}</div></div></div>
    ${c ? `<div class="banner ${esc(tagOk(c.tag))}" ${row(P.grp(c.id))}>${tg(c.tag)}<div style="flex:1;min-width:0"><b>Member of ${esc(c.ai?.label || c.id)}</b><div class="muted small">${(c.weak_members || []).includes(w.id) ? 'attached only by co-buys (no money link)' : 'linked by funding / money flow'} · ${c.size} wallets ${tags(c.rule?.tags)}</div></div>${ilink(P.grp(c.id), 'Open group →')}</div>`
      : '<div class="banner"><span class="v solo">standalone</span><span class="muted">Not linked to any other early wallet by money. It is only in its tag groups below.</span></div>'}
    <div class="meta" style="margin:-4px 0 14px">Tag groups: ${tagGroupChips(w)}</div>
    <div class="tiles">${tile('Tokens bought early', s.tokens_n ?? '–', `${s.entries_n ?? '–'} entries`)}${tile('Profitable tokens', pct(s.profit_rate), 'share of its early tokens that ended in profit', (s.profit_rate ?? 0) >= 0.5 ? 'g' : (s.profit_rate ?? 1) < 0.3 ? 'r' : 'a')}${tile('Weighted ROI', pct(s.roi_weighted), null, roiCls(s.roi_weighted))}
      ${tile('P&L', signed(s.pnl_near) + ' N', `${n(s.total_buy_near, 1)} N bought`, roiCls(s.pnl_near))}${tile('Realized P&L', signed(s.realized_near) + ' N', 'taken out of the tokens sold', roiCls(s.realized_near))}${tile('Unrealized P&L', signed(s.unrealized_near) + ' N', 'still held, at the latest price', roiCls(s.unrealized_near))}${tile('Rugged tokens', pct(s.rug_share), null, (s.rug_share ?? 0) >= 0.4 ? 'r' : '')}${tile('Main funder', w.funder ? esc(short(w.funder, 20)) : '–', esc(w.funder_kind || ''))}</div></div>`;
  h += ontologyCard(ont);
  if ((w.cobuy_partners || []).length) h += `<div class="card"><h2>Co-buy partners <span class="muted">bought within seconds of it in several launches · behaviour, not proof of one owner</span></h2><table><tr><th>Wallet</th><th class="num">Launches bought together</th></tr>
    ${w.cobuy_partners.map((p) => `<tr ${row(P.wal(p.wallet))}><td>${walLink(p.wallet)}</td><td class="num">${p.tokens}</td></tr>`).join('')}</table></div>`;
  h += `<div class="card"><h2>Early entries <span class="muted">${w.entries.length}</span></h2><table><tr><th>Token</th><th>Bought</th><th>Tx</th><th class="num">Rank</th><th class="num">Delay</th><th class="num">NEAR in</th><th class="num">ROI 1h</th><th class="num">ROI 6h</th><th class="num">ROI 24h</th><th class="num">Now</th><th class="num" title="NEAR taken out minus the cost of the tokens sold">Realized N</th><th class="num" title="still held, valued at the latest price, minus its cost">Unrealized N</th><th>Rug</th></tr>
    ${w.entries.map((e) => `<tr ${row(P.tok(e.token))}><td>${tokCell(e.token, e.symbol, e.launchpad, 22)}${e.is_creator ? ' <span class="v bad">creator</span>' : ''}</td><td>${when(e.first_buy_ts)}</td><td>${txl(e.first_buy_hash)}</td><td class="num">#${e.rank}</td><td class="num">${e.delay_s}s</td><td class="num">${n(e.buy_near, 1)}</td>
      ${['60', '360', '1440'].map((k) => `<td class="num ${roiCls(e.roi?.[k])}">${pct(e.roi?.[k])}</td>`).join('')}<td class="num ${roiCls(e.roi_now)}"${!e.now_ts && e.token_done ? ' title="at 24 h: trades after the first day are not read yet"' : ''}>${pct(e.roi_now)}${!e.now_ts && e.token_done ? '<small class="muted"> 24h</small>' : ''}</td><td class="num ${roiCls(e.realized_now)}">${signed(e.realized_now)}</td><td class="num ${roiCls(e.unrealized_now)}">${signed(e.unrealized_now)}</td><td class="${e.rugged ? 'r' : 'muted'}">${e.rugged ? 'RUG' : '–'}</td></tr>`).join('') || empty(13, 'none')}</table></div>`;
  h += `<div class="grid2"><div class="card"><h2>Who funded it <span class="muted">first meaningful inflows, earliest first</span></h2><table><tr><th>Account</th><th>Kind</th><th class="num">NEAR</th><th>When</th><th>Tx</th><th>Via</th></tr>
    ${(w.funders || []).map((f) => `<tr ${row(P.ent(f.account))}><td>${nb(f.account)}</td><td>${esc(f.kind)}${f.creator_only ? ' <span class="chip">creator only</span>' : ''}</td><td class="num">${n(f.near, 2)}</td><td>${when(f.ts)}</td><td>${txl(f.hash)}</td><td>${esc(f.via || 'transfer')}</td></tr>`).join('') || empty(6, 'not profiled yet')}</table></div>
    <div class="card"><h2>Funding chain</h2><table><tr><th class="num">Hop</th><th>Account</th><th>Kind</th><th class="num">NEAR</th><th class="num">Txs</th></tr>
    ${(w.chain || []).map((x) => `<tr ${row(P.ent(x.account))}><td class="num">${x.hop}</td><td>${nb(x.account)}</td><td>${esc(x.kind)}</td><td class="num">${n(x.near, 2)}</td><td class="num">${x.tx_count ?? '–'}</td></tr>`).join('') || empty(5, 'none')}</table></div></div>`;
  h += `<div class="card"><h2>Where its NEAR went <span class="muted">recent outflows</span></h2><table><tr><th>To</th><th class="num">NEAR</th><th class="num">Transfers</th><th>Last</th></tr>
    ${(w.flow_out || []).map((f) => `<tr ${row(P.ent(f.to))}><td>${nb(f.to)}</td><td class="num">${n(f.near, 2)}</td><td class="num">${f.n}</td><td>${when(f.last_ts)}</td></tr>`).join('') || empty(4, 'none recorded')}</table></div>`;
  return h;
}

const fundedTags = (v = {}) => `<span class="g">${(v.win80 || 0) + (v.win50 || 0) + (v.sniper || 0)}</span> / <span class="a">${v.win30 || 0}</span> / <span class="r">${v.loss || 0}</span> / <span class="muted">${v.unrated || 0}</span>`;
views.entities = async () => {
  const S = ST.entities, j = await get('/api/entities', { type: S.type, q: S.q, sort: S.sort, limit: 50, offset: S.offset });
  return `<div class="card"><div class="bar">${sel('entities', 'type', [['', 'all types'], ...['exchange', 'service', 'bridge', 'wallet', 'other', 'unknown'].map((v) => [v, v])])}
    ${sel('entities', 'sort', [['funded', 'by wallets funded'], ['near', 'by NEAR funded'], ['sink', 'by NEAR received'], ['tokens', 'by tokens'], ['pnl', 'by funded P&L'], ['creators', 'by token creators funded'], ['rugcreators', 'by rugging creators funded']])}${qbox('entities', 'account / label')}
    <span class="muted small">${j.types.map((t) => esc(t.type) + ' ' + t.n).join(' · ')}</span><span class="spacer"></span>${pager('entities', j.total)}</div>
    <table><tr><th>Entity</th><th>Type</th><th>Roles</th><th class="num">Txs</th><th class="num">Funded</th><th class="num">NEAR funded</th><th title="funded wallets by tag: win80+win50+sniper / win30 / loss / unrated">Their wallets</th><th class="num">Tokens</th><th class="num">Funded P&amp;L N</th><th title="token creators it funded (how many of them rugged)">Creators funded</th><th class="num">NEAR received</th></tr>
    ${j.rows.map((e) => `<tr ${row(P.ent(e.id))}><td><span class="ent">${avatar(e.id, e.label || e.id, 26)}<span><b>${ilink(P.ent(e.id), esc(short(e.label || e.id, 28)))}</b><small>${acct(e.id, 26)}</small></span></span></td><td><span class="chip">${esc(e.type)}</span></td><td class="wrap">${tags(e.roles)}</td><td class="num">${e.tx_count ?? '–'}</td><td class="num">${e.funded_n || '–'}</td><td class="num">${e.funded_near ? n(e.funded_near, 0) : '–'}</td>
      <td>${e.funded_n ? fundedTags(e.funded_verdicts) : '–'}</td><td class="num">${e.tokens_n || '–'}</td><td class="num ${roiCls(e.funded_pnl_near)}">${e.funded_n ? signed(e.funded_pnl_near) : '–'}</td><td>${e.creators_funded_n ? `${e.creators_funded_n} <span class="${e.creators_rugged_n ? 'r' : 'muted'}">(${e.creators_rugged_n} rugged)</span>` : '<span class="muted">–</span>'}</td><td class="num">${e.sink_near ? n(e.sink_near, 0) + ' (' + e.sink_senders_n + ' w)' : '–'}</td></tr>`).join('') || empty(11, 'no entities yet')}</table>
    <p class="muted small">"Their wallets" = the early wallets it funded, by tag: <span class="g">win80 + win50 + sniper</span> / <span class="a">win30</span> / <span class="r">loss</span> / <span class="muted">unrated</span>.</p></div>`;
};

async function entityPage(id) {
  const [e, ont] = await Promise.all([get('/api/entity', { id }), ontologyOf(id)]), v = e.funded_verdicts || {};
  let h = `<div class="card">${crumbs([['Funders & entities', '/entities'], [short(e.label || e.id, 40)]])}
    <div class="dh-main">${avatar(e.id, e.label || e.id, 54)}<div style="min-width:0"><h1>${esc(e.label || e.id)} <span class="chip">${esc(e.type)}</span>${tags(e.roles)}</h1>
      <div class="meta"><span class="acct">${esc(e.id)}</span><span>kind ${esc(e.kind)}</span><span>${e.tx_count ?? '–'} txs</span>${e.label_source ? `<span>label from ${esc(e.label_source)}</span>` : ''}${ACCT_RE.test(e.id) ? ext(nbAddr(e.id), 'NearBlocks ↗') : ''}</div></div></div>`;
  if (e.funded_n) h += `<div class="tiles">${tile('Early wallets funded', e.funded_n, `${n(e.funded_near, 0)} N sent`)}${tile('Tokens they bought', e.tokens_n ?? '–')}${tile('Their P&L', signed(e.funded_pnl_near) + ' N', pct(e.funded_roi), roiCls(e.funded_pnl_near))}${tile('Winning wallets', `${e.funded_winners}/${e.funded_judged}`)}
    ${tile('Their wallets by tag', fundedTags(v), 'win80+win50+sniper / win30 / loss / unrated')}</div>`;
  h += '</div>';
  h += ontologyCard(ont);
  if (e.creators_funded_n || e.creator_sink_n) h += `<div class="card"><div class="tiles">${tile('Token creators funded', e.creators_funded_n || 0, `${n(e.creators_funded_near, 0)} N sent`)}${tile('Creators that rugged', e.creators_rugged_n || 0, e.creators_funded_n ? pct(e.creators_rugged_n / e.creators_funded_n) + ' of them' : null, e.creators_rugged_n ? 'r' : 'g')}
      ${tile('Their launches', e.creator_launches || 0)}${tile('Rugged tokens', e.creator_rugged_tokens || 0, e.creator_launches ? pct(e.creator_rug_rate) + ' of their launches' : null, e.creator_rugged_tokens ? 'r' : 'g')}${tile('Creators cashing out to it', e.creator_sink_n || 0, e.creator_sink_n ? `${n(e.creator_sink_near, 0)} N · ${e.creator_sink_rugged_n} rugged` : null, e.creator_sink_rugged_n ? 'r' : '')}</div></div>`;
  if (e.type === 'exchange') h += '<div class="card warn">An exchange wallet funds many unrelated customers, so funding from it links nothing by itself. The numbers show how much early-market flow came out of it.</div>';
  if (e.funded_wallets?.length) h += `<div class="card"><h2>Early wallets it funded</h2><table><tr><th>Wallet</th><th class="num">NEAR</th><th class="num">Hop</th><th>When</th><th>Tx</th><th>Via</th><th>Group</th></tr>${e.funded_wallets.map((f) => `<tr ${row(P.wal(f.wallet))}><td>${walLink(f.wallet, 26)}</td><td class="num">${n(f.near, 2)}</td><td class="num">${f.hop}</td><td>${when(f.ts)}</td><td>${txl(f.hash)}</td><td>${esc(f.via || 'transfer')}</td><td>${tg(f.tag)} ${f.cluster_id ? ilink(P.grp(f.cluster_id), esc(short(f.cluster_id, 20))) : '<span class="muted">unlinked</span>'}</td></tr>`).join('')}</table></div>`;
  if (e.creators_funded?.length) h += `<div class="card"><h2>Token creators it funded <span class="muted">${e.creators_funded_n}${e.creators_funded_n > e.creators_funded.length ? ', the first ' + e.creators_funded.length + ' listed' : ''} · hop 1 = funded directly</span></h2><table><tr><th>Creator</th><th class="num">Hop</th><th class="num">NEAR</th><th>When</th><th>Tx</th><th>Record</th></tr>${e.creators_funded.map((c) => `<tr ${row(P.creator(c.creator))}><td><span class="acct">${ilink(P.creator(c.creator), esc(short(c.creator, 30)), c.creator)}</span> ${ext(nbAddr(c.creator), '↗')}</td><td class="num">${c.hop}</td><td class="num">${c.near ? n(c.near, 2) : '–'}</td><td>${c.ts ? when(c.ts) : '–'}</td><td>${txl(c.hash)}</td><td>${crRec(c)}</td></tr>`).join('')}</table></div>`;
  if (e.creator_sinks?.length) h += `<div class="card"><h2>Token creators that sent NEAR to it <span class="muted">${n(e.creator_sink_near, 0)} N</span></h2><table><tr><th>Creator</th><th class="num">NEAR</th><th class="num">Transfers</th><th>Record</th></tr>${e.creator_sinks.map((c) => `<tr ${row(P.creator(c.creator))}><td><span class="acct">${ilink(P.creator(c.creator), esc(short(c.creator, 30)), c.creator)}</span></td><td class="num">${n(c.near, 2)}</td><td class="num">${c.n}</td><td>${crRec(c)}</td></tr>`).join('')}</table></div>`;
  if (e.sink_wallets?.length) h += `<div class="card"><h2>Early wallets that sent NEAR to it <span class="muted">${n(e.sink_near, 0)} N</span></h2><table><tr><th>Wallet</th><th class="num">NEAR</th><th class="num">Transfers</th></tr>${e.sink_wallets.map((f) => `<tr ${row(P.wal(f.wallet))}><td>${walLink(f.wallet, 26)}</td><td class="num">${n(f.near, 2)}</td><td class="num">${f.n}</td></tr>`).join('')}</table></div>`;
  h += `<p class="muted small">Name this account: <code>node src/cli.js label ${esc(e.id)} "Binance"  exchange</code></p>`;
  return h;
}
