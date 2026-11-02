// ================================================================== CREATORS
// ---- creator networks: who funded a token creator, and the other creators tied to it
const REL = { funded_it: 'funded this creator', funded_by_it: 'was funded by this creator', paid: 'NEAR sent between them', shared_funder: 'same funder', shared_cashout: 'same cash-out wallet' };
/** An account that may be an entity: its entity page when it has a label or type, NearBlocks otherwise. */
const entAcct = (acc, label, k = 26) => (label ? `${ilink(P.ent(acc), esc(short(label, k)), acc)} <span class="muted acct small">${esc(short(acc, 18))}</span> ${ext(nbAddr(acc), '↗')}` : `<span class="acct">${ilink(P.ent(acc), esc(short(acc, k)), acc)}</span> ${ext(nbAddr(acc), '↗')}`);
const relTxt = (rels) => rels.map((r) => `${REL[r.type] || esc(r.type)}${r.type === 'shared_funder' || r.type === 'shared_cashout' ? ' ' + entAcct(r.via, null, 20) : ''}`).join('<br>');
const crRec = (x) => `${x.launches} launches · <b class="${x.rugged ? 'r' : 'g'}">${x.rugged} rugged</b>${x.blacklisted ? ' <span class="v bad">blacklisted</span>' : ''}`;
const fundNote = (f) => (f.distributor ? '<span class="v neutral">distributor: links nothing</span>' : !f.link ? `<span class="chip">${esc(f.kind || 'generic')}: links nothing</span>` : '');
function creatorNetHtml(net) {
  if (!net) return '';
  if (!net.profiled) return '<div class="card muted">Who funded this creator is not traced yet. Creators are traced in the background, newest launch first.</div>';
  const N = net.network;
  let h = `<div class="card"><h2>Creator network <span class="muted">other token creators tied to this one by funding or payments · exchanges, relayers and NEAR Intents link nothing</span></h2>
    <div class="tiles">${tile('Creators in the network', N.creators, `${N.creators - 1} besides this one`)}${tile('Their launches', N.others_launches)}${tile('Rugged by them', N.others_rugged, N.others_launches ? pct(N.others_rugged / N.others_launches) + ' of their launches' : null, N.others_rugged ? 'r' : 'g')}
      ${tile('Creators that rugged', N.ruggers, `${N.blacklisted} on the blacklist`, N.ruggers ? 'r' : 'g')}${tile('Network rug rate', pct(N.rug_rate), `${N.rugged} of ${N.launches} launches, this one included`, (N.rug_rate ?? 0) >= 0.5 ? 'r' : '')}</div>`;
  h += net.siblings.length ? `<h3>Creators tied to it (${net.siblings.length})</h3><table><tr><th>Creator</th><th>How they are tied</th><th>Record</th></tr>${net.siblings.map((s) => `<tr ${row(P.creator(s.account))}><td><span class="acct">${ilink(P.creator(s.account), esc(short(s.account, 30)), s.account)}</span> ${ext(nbAddr(s.account), '↗')}</td><td class="wrap small">${relTxt(s.relations)}</td><td>${crRec(s)}${s.rug_symbols.length ? `<div class="muted small">${s.rug_symbols.map(esc).join(', ')}</div>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">No other token creator is tied to it yet.</p>';
  h += '</div>';
  h += `<div class="grid2"><div class="card"><h2>Who funded it <span class="muted">first meaningful inflows, then the first funder's chain</span></h2><table><tr><th>Account</th><th class="num">Hop</th><th class="num">NEAR</th><th>When</th><th>Creators it funded</th></tr>
    ${net.funders.map((f) => `<tr><td>${entAcct(f.account, f.label)} ${fundNote(f)}</td><td class="num">${f.hop}</td><td class="num">${n(f.near, 2)}</td><td>${f.ts ? when(f.ts) : '–'}${f.hash ? `<div class="small">${txl(f.hash)}</div>` : ''}</td><td>${f.creators_funded_n ? `${f.creators_funded_n} <span class="${f.creators_rugged_n ? 'r' : 'muted'}">(${f.creators_rugged_n} rugged)</span>` : '<span class="muted">–</span>'}</td></tr>`).join('') || empty(5, 'no funding found')}</table></div>
    <div class="card"><h2>Where its NEAR went <span class="muted">cash-outs of ${n(2, 0)}+ N</span></h2><table><tr><th>To</th><th class="num">NEAR</th><th class="num">Transfers</th><th>Last</th></tr>
    ${net.cashout.map((f) => `<tr><td>${entAcct(f.account, f.label)} ${fundNote(f)}</td><td class="num">${n(f.near, 2)}</td><td class="num">${f.n}</td><td>${when(f.last_ts)}</td></tr>`).join('') || empty(4, 'none recorded')}</table></div></div>`;
  return h;
}
