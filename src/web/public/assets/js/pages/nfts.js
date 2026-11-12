// ================================================================== NFT COLLECTIBLES
const NFTSRC = { hotcraft: 'HOT Craft', cookon: 'near.cooking', deploy: 'new contract', market: 'traded on near.cooking', nearblocks: 'discovered', manual: 'added' };
const nftSrc = (s) => (s ? `<span class="chip">${esc(NFTSRC[s] || s)}</span>` : '');
const nftName = (c) => `<span class="ent">${avatar(c.id, c.symbol || c.name || c.id, 28)}<span><b>${ilink(P.nft(c.id), esc(short(c.name || c.id, 30)))}</b><small class="acct">${esc(short(c.id, 34))}</small></span></span>`;
async function nftAdd(id) {
  id = (id || '').trim().toLowerCase(); if (!id) return;
  const r = await get('/api/nft-add', { id }).catch((e) => ({ error: e.message }));
  if (r.error) { alert(r.error); return; }
  nav(null, P.nft(id));
}
views.nfts = async () => {
  const S = ST.nfts, j = await get('/api/nfts', { tab: S.tab, q: S.q, sort: S.sort, limit: 50, offset: S.offset });
  const cnt = (k) => (j.sources[k] ? ` (${n(j.sources[k], 0)})` : '');
  return `<div class="card"><div class="bar"><input id="nftAddInput" type="search" style="flex:1;max-width:460px" placeholder="any NFT contract, e.g. nft.sickyak1747.near" onkeydown="if(event.key==='Enter')nftAdd(this.value)">
      <button onclick="nftAdd($('nftAddInput').value)">Add &amp; analyse</button></div>
    <p class="muted small" style="margin:0">HOT Craft and near.cooking collections are listed the moment they are deployed (the chain watch reads every block), and so is any other contract the automated audit finds to be an NFT collection; every NFT contract NearBlocks lists is discovered too (airdrop spam set apart); any collection can be added by its contract id.</p></div>
  <div class="card"><div class="bar">${seg('nfts', 'tab', [['', 'All'], ['active', 'Active (24 h)'], ['hotcraft', 'HOT Craft' + cnt('hotcraft')], ['cookon', 'near.cooking' + cnt('cookon')], ['deploy', 'New contracts' + cnt('deploy')], ['market', 'Traded on cookon' + cnt('market')], ['nearblocks', 'Discovered' + cnt('nearblocks')], ['manual', 'Added' + cnt('manual')], ['spam', 'Spam' + cnt('spam')]])}
    ${qbox('nfts', 'name / contract')}${sel('nfts', 'sort', [['', 'latest activity'], ['launched', 'newest launch'], ['events', 'most events'], ['holders', 'most holders']])}<span class="spacer"></span>${pager('nfts', j.total)}</div>
    <table><tr><th>Collection</th><th>Source</th><th>Launched</th><th class="num">Supply</th><th class="num">Minted</th><th class="num">Raised</th><th class="num">Sales</th><th class="num">Volume</th><th class="num">Holders</th><th>Last activity</th><th></th></tr>
    ${j.rows.map((c) => `<tr ${row(P.nft(c.id))}><td>${nftName(c)}</td><td>${nftSrc(c.source)}</td><td>${c.launched_ts ? since(c.launched_ts) : '–'}</td>
      <td class="num">${c.supply != null ? n(c.supply, 0) : c.nb ? n(c.nb.tokens, 0) : '–'}${c.max_supply ? `<span class="muted"> / ${n(c.max_supply, 0)}</span>` : ''}</td><td class="num">${c.minted != null ? n(c.minted, 0) : '–'}</td>
      <td class="num">${c.raised_near ? n(c.raised_near, 0) + ' N' : '–'}</td><td class="num">${c.sales != null ? n(c.sales, 0) : '–'}</td><td class="num">${c.volume_near ? n(c.volume_near, 0) + ' N' : '–'}</td>
      <td class="num">${c.nb ? n(c.nb.holders, 0) : '–'}</td><td>${c.last_event_ts ? since(c.last_event_ts) : '<span class="muted">' + (c.synced ? 'no events' : 'not synced') + '</span>'}</td><td>${c.spam ? '<span class="v bad">spam</span>' : c.synced && !c.caught_up ? '<span class="muted small">syncing…</span>' : ''}</td></tr>`).join('') || empty(11, 'no collections yet')}</table></div>`;
};
async function nftPage(id) {
  const a = await get('/api/nft', { id }).catch((e) => ({ error: e.message }));
  if (a.error) {
    return `<div class="card">${crumbs([['NFT Collectibles', '/nfts'], [short(id, 30)]])}<h1 class="acct">${esc(id)}</h1>
      <p>${esc(a.error === 'not tracked' ? 'This collection is not tracked yet.' : a.error === 'not synced yet' ? 'This collection is known but its history has not been read yet.' : a.error)}</p>
      ${a.can_add ? `<button onclick="this.disabled=true;nftAdd(${esc(JSON.stringify(id))})">Read its history &amp; analyse</button>` : ''}</div>`;
  }
  const I = a.info, M = a.mint, T = a.team, G = a.minter_groups, K = a.market, H = a.holders, J = a.sync_job;
  let h = `<div class="card">${crumbs([['NFT Collectibles', '/nfts'], [I.name || short(id, 24)]])}<div style="float:right;position:relative">${reportBtn('collection', id)} ${watchBtn('collection', id)}</div>
    <div class="dh-main">${avatar(id, I.symbol || I.name || id, 54)}<div style="min-width:0"><h1>${esc(I.name || id)} ${I.symbol ? `<span class="muted">${esc(I.symbol)}</span>` : ''} ${nftSrc(I.source)}</h1>
      <div class="meta"><span class="acct">${esc(id)}</span>${I.owner ? `<span>owner ${nb(I.owner)}</span>` : ''}${I.launched_ts ? `<span>launched ${when(I.launched_ts)}</span>` : ''}<span>${n(I.events_n, 0)} NFT events${I.caught_up ? '' : ' · still reading its history'}</span>
        ${ext(`${NB}/nft-token/${encodeURIComponent(id)}`, 'NearBlocks ↗')}${I.source === 'hotcraft' ? ext('https://hotcraft.art/', 'HOT Craft ↗') : ''}
        <button onclick="this.disabled=true;$('main').classList.add('loading');get('/api/nft',{id:${esc(JSON.stringify(id))},refresh:'1'}).then(()=>render())">Rebuild</button></div></div></div></div>`;
  if (J && !J.done) h += `<div class="banner"><span class="v neutral">reading</span><span class="muted">Reading the collection's history: ${J.passes} passes, ${J.events} NFT events so far. Rebuild in a moment for the full picture.</span></div>`;
  h += `<div class="card ${a.flags.some((f) => f.level === 'high') ? 'err' : a.flags.some((f) => f.level === 'medium') ? 'warn' : ''}"><h2>Risk notes</h2>${a.flags.length ? `<ul class="flags">${a.flags.map((f) => `<li><span class="v ${FLAGCLS[f.level]}">${f.level}</span> ${esc(f.text)}</li>`).join('')}</ul>` : '<p class="muted">Nothing flagged.</p>'}</div>`;
  h += `<div id="nftSafety"></div>`; setTimeout(() => { if ($('nftSafety')) contractSafetyCard(id, $('nftSafety')); }, 0); // the automated contract audit, in short
  h += `<div id="anaAi">${anaAiBody(a)}</div>`;
  // mint
  h += `<div class="card"><h2>Mint</h2><div class="tiles">${tile('Minted', n(M.minted, 0), I.max_supply ? `of ${n(I.max_supply, 0)} max` : I.supply != null ? `supply now ${n(I.supply, 0)}` : '')}${tile('Raised', n(M.raised_near, 1) + ' N', M.free_tokens ? `${n(M.free_tokens, 0)} minted free` : '')}
      ${tile('Price', M.price_near != null ? n(M.price_near, 2) + ' N' : 'free')}${tile('Minters', n(M.minters, 0), `most by one wallet: ${M.max_per_wallet}`)}${tile('Mint window', M.first_ts ? since(M.first_ts) : '–', M.sold_out_min != null ? `sold out in ${M.sold_out_min} min` : M.last_ts ? 'last mint ' + since(M.last_ts) : '')}</div>
    <div class="grid2"><div><h3>Top minters</h3><table><tr><th>Wallet</th><th class="num">NFTs</th><th class="num">Share</th><th class="num">Paid</th><th>First mint</th></tr>${M.top_minters.map((x) => `<tr ${row(P.wal(x.wallet))}><td>${walLink(x.wallet, 22)}${T.minters.some((t) => t.wallet === x.wallet) ? ' <span class="v bad">team</span>' : ''}</td><td class="num">${x.count}</td><td class="num">${pct(x.share, 1)}</td><td class="num">${n(x.paid_near, 1)}</td><td>${when(x.first_ts)}</td></tr>`).join('') || empty(5, 'no mints seen')}</table></div>
      <div><h3>Where the mint money went</h3><table><tr><th>Account</th><th class="num">NEAR</th><th class="num">Share</th></tr>${M.proceeds_to.map((x) => `<tr><td>${nb(x.account)}${T.accounts.includes(x.account) ? ' <span class="v neutral">team</span>' : ''}</td><td class="num">${n(x.near, 1)}</td><td class="num">${pct(x.share, 1)}</td></tr>`).join('') || empty(3, 'no paid mints')}</table></div></div></div>`;
  // team
  h += `<div class="card ${T.minted ? 'warn' : ''}"><h2>The team's own mints <span class="muted">${T.accounts.length ? 'team: ' + T.accounts.map((x) => esc(short(x, 26))).join(', ') : 'team unknown'}</span></h2>
    ${T.minters.length ? `<p>${n(T.minted, 0)} NFTs (${pct(T.share, 1)} of the mint) were minted by the team or by wallets it funded.</p><table><tr><th>Wallet</th><th class="num">NFTs</th><th class="num">Paid</th><th>How it ties to the team</th></tr>${T.minters.map((x) => `<tr ${row(P.wal(x.wallet))}><td>${walLink(x.wallet, 22)}</td><td class="num">${x.count}</td><td class="num">${n(x.paid_near, 1)}</td><td>${esc(x.via)} ${nb(x.account)}</td></tr>`).join('')}</table>` : '<p class="muted">No minter is funded by the owner, the deployer or the receivers of the mint money.</p>'}</div>`;
  // minter groups
  h += `<div class="card"><h2>Minter groups <span class="muted">minters linked by money (funding, transfers, shared funders) · ${G.profiled} of ${G.minters} minters profiled</span></h2>
    <div class="tiles">${tile('Groups', G.groups_n, `${G.grouped_wallets} wallets`)}${tile('Minted by groups', pct(G.grouped_share, 0), null, (G.grouped_share ?? 0) >= 0.3 ? 'a' : '')}${tile('Standalone minters', G.standalone_wallets)}</div>
    <table><tr><th>Group</th><th class="num">Wallets</th><th class="num">NFTs</th><th class="num">Share</th><th class="num">Paid</th><th>Linked by</th><th>Members</th></tr>
    ${G.groups.map((g) => `<tr><td>${g.team ? '<span class="v bad">team</span> ' : ''}${g.over_wallet_max ? '<span class="chip" title="minted more than any single wallet did">past the per-wallet max</span>' : ''}</td><td class="num">${g.wallets}</td><td class="num">${g.minted}</td><td class="num">${pct(g.share, 1)}</td><td class="num">${n(g.paid_near, 1)}</td>
      <td class="small wrap">${g.anchors.map((x) => `${esc(x.type.replace(/_/g, ' '))} ${esc(short(String(x.anchor), 18))}`).join('; ')}</td><td class="small wrap">${g.members.map((m) => ilink(P.wal(m), esc(short(m, 14)), m)).join(', ')}</td></tr>`).join('') || empty(7, 'no money-linked minter groups')}</table></div>`;
  // market
  h += `<div class="card"><h2>Secondary market</h2><div class="tiles">${tile('Sales', n(K.sales, 0), K.last_sale ? 'last ' + since(K.last_sale.ts) : '')}${tile('Volume', n(K.volume_near, 1) + ' N')}${tile('Median price', K.median_price != null ? n(K.median_price, 2) + ' N' : '–', K.floor_7d != null ? `lowest sale 7 d: ${n(K.floor_7d, 2)} N` : '')}
      ${tile('Below mint price', K.below_mint != null ? n(K.below_mint, 0) : '–')}${tile('Suspected wash trades', n(K.wash.sales, 0), K.wash.share != null ? pct(K.wash.share, 0) + ' of volume' : '', K.wash.sales ? 'r' : '')}${tile('Markets', K.markets.map((x) => esc(short(x.market, 22))).join(', ') || '–')}</div>
    <div class="grid2"><div><h3>Biggest buyers</h3><table><tr><th>Wallet</th><th class="num">NFTs</th><th class="num">Paid</th></tr>${K.top_buyers.map((x) => `<tr ${row(P.wal(x.wallet))}><td>${walLink(x.wallet, 22)}${x.team ? ' <span class="v bad">team</span>' : ''}${K.sweeps.some((s2) => s2.wallet === x.wallet) ? ' <span class="chip" title="3+ NFTs within an hour">sweep</span>' : ''}</td><td class="num">${x.tokens}</td><td class="num">${n(x.near, 1)}</td></tr>`).join('') || empty(3, 'no sales')}</table></div>
      <div><h3>Biggest sellers</h3><table><tr><th>Wallet</th><th class="num">NFTs</th><th class="num">Received</th></tr>${K.top_sellers.map((x) => `<tr ${row(P.wal(x.wallet))}><td>${walLink(x.wallet, 22)}${x.team ? ' <span class="v bad">team</span>' : ''}</td><td class="num">${x.tokens}</td><td class="num">${n(x.near, 1)}</td></tr>`).join('') || empty(3, 'no sales')}</table></div></div>
    ${K.wash.rows.length ? `<h3>Suspected wash trades</h3><table><tr><th>When</th><th>Token</th><th>Seller</th><th>Buyer</th><th class="num">Price</th><th>Why</th></tr>${K.wash.rows.map((w) => `<tr><td>${when(w.ts)} ${txl(w.hash)}</td><td>#${esc(w.token)}</td><td>${walLink(w.from, 16)}</td><td>${walLink(w.to, 16)}</td><td class="num">${n(w.price_near, 2)}</td><td class="small">${esc(w.reasons.join('; '))}</td></tr>`).join('')}</table>` : '<p class="muted small">No sale between money-linked wallets, no buyer funded by its seller, no round trip.</p>'}</div>`;
  // holders
  h += `<div class="card"><h2>Holders <span class="muted">${n(H.holders, 0)} holders · top 10 hold ${pct(H.top10_share, 1)}${H.team_share ? ` · team ${pct(H.team_share, 1)}` : ''}${H.complete ? '' : ` · rebuilt from ${n(H.tracked_tokens, 0)} of ${n(H.supply, 0)} tokens`}</span></h2>
    <table><tr><th>Wallet</th><th class="num">NFTs</th><th class="num">Share</th><th></th></tr>${H.top.map((x) => `<tr ${row(P.wal(x.wallet))}><td>${walLink(x.wallet, 26)}</td><td class="num">${x.tokens}</td><td class="num">${pct(x.share, 2)}</td><td>${x.team ? '<span class="v bad">team</span> ' : ''}${x.group ? '<span class="chip">minter group</span>' : ''}</td></tr>`).join('') || empty(4, 'no holders')}</table></div>`;
  return h;
}
