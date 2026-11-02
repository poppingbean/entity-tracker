// ================================================================== SAFETY CHECK (paste anything: wallet, contract, token, NFT, transaction, link, website)
const SC_EXAMPLES = [['A wallet', 'threeis.near'], ['A token', 'BLACKDRAGON'], ['A stablecoin', 'usdt.tether-token.near'], ['An NFT', 'cosmickats.nft.cookon.near:1'], ['A transaction', '7b4uXEDdN3XQuNDZ4YtArxr6JkMhVQvTsNK5LUPHY9Wb'],
  ['A website', 'https://ref-flnance.com/claim'], ['A request to sign', JSON.stringify({ signerId: 'alice.near', receiverId: 'alice.near', actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp', accessKey: { permission: 'FullAccess' } } }] })]];
const SC_VERDICT = { safe: ['good', 'Looks safe', '✓'], caution: ['neutral', 'Be careful', '!'], danger: ['bad', 'Danger', '✕'], unknown: ['unknown', 'Not sure', '?'], pending: ['unknown', 'Checking …', '…'] };
const SC_KIND = { wallet: 'Wallet', token: 'Token', nft_collection: 'NFT collection', nft: 'NFT', contract: 'Contract', tx: 'Transaction', unsigned_tx: 'Transaction to sign', website: 'Website', public_key: 'Public key', missing: 'Account', secret: 'Secret', unknown: '', empty: '' };
const SC_DOT = { bad: ['r', '✕'], warn: ['a', '!'], info: ['muted', '•'], good: ['g', '✓'] };
/** A seed phrase or private key never leaves the browser. */
const scSecret = (s) => { const w = s.trim().toLowerCase().split(/\s+/); return ([12, 15, 18, 21, 24].includes(w.length) && w.every((x) => /^[a-z]{3,8}$/.test(x))) || (/^(ed25519|secp256k1):/i.test(s.trim()) && s.trim().length > 80); };
let scTimer = null, scSeq = 0;
async function scCheck(q, { poll = 0 } = {}) {
  q = (q ?? $('scInput')?.value ?? '').trim();
  const out = $('scOut');
  if (!out) return;
  clearTimeout(scTimer);
  if (!q) { out.innerHTML = ''; return; }
  if (scSecret(q)) {
    $('scInput').value = ''; history.replaceState(null, '', '/firewall');
    out.innerHTML = scBody({ kind: 'secret', verdict: 'danger', headline: 'This looks like a seed phrase or private key: never paste it anywhere.', points: [{ level: 'bad', text: 'Whoever sees it controls the wallet. It was cleared and not sent anywhere.' }, { level: 'warn', text: 'No real app, support agent or airdrop will ever ask for it.' }], actions: ['If you typed it into a website or sent it to someone, move your funds to a new wallet now.'] });
    return;
  }
  if (/^target:/i.test(q)) { out.innerHTML = '<div class="card"><b>Looking for hacks on ' + esc(q.slice(7)) + '</b> <span class="small" id="scInv"></span></div>'; scInvestigate(q); return; }
  if (!poll) { history.replaceState(null, '', q.length > 200 ? '/firewall' : '/firewall?q=' + encodeURIComponent(q)); out.innerHTML = '<div class="card muted">Checking …</div>'; }
  const my = ++scSeq;
  const r = await get('/api/v1/inspect', { q }).catch((e) => ({ error: e.message }));
  if (my !== scSeq || !$('scOut')) return;
  if (r.error) { out.innerHTML = `<div class="card err">${esc(r.error)}</div>`; return; }
  out.innerHTML = scBody(r);
  if (r.pending && poll < 20) scTimer = setTimeout(() => scCheck(q, { poll: poll + 1 }), 6000);
}
const scLink = (q, label) => `<a href="/firewall?q=${encodeURIComponent(q)}" onclick="event.preventDefault();$('scInput').value=decodeURIComponent('${encodeURIComponent(q)}');scCheck()">${label}</a>`;
function scBody(r) {
  const [cls, label, icon] = SC_VERDICT[r.verdict] || SC_VERDICT.unknown, F = r.facts || {};
  const pts = (r.points || []).map((p) => { const [c, i] = SC_DOT[p.level] || SC_DOT.info; return `<li style="list-style:none;margin:7px 0;display:flex;gap:10px"><b class="${c}" style="width:14px;flex:none;text-align:center">${i}</b><span>${esc(p.text)}</span></li>`; }).join('');
  let facts = '';
  if (F.did?.length) facts += `<h3>What it ${r.kind === 'tx' ? 'did' : 'does if you sign'}</h3><ol class="small" style="margin:4px 0;padding-left:20px">${F.did.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>`;
  if (r.kind === 'tx') facts += `<p class="small muted">From <b>${esc(F.from)}</b> to <b>${esc(F.to)}</b>${F.when ? ` · ${when(F.when)} (${since(F.when)})` : ''}</p>`;
  if (r.kind === 'wallet') {
    facts += `<p class="small muted">${F.balance_near != null ? `${F.balance_near.toLocaleString('en-US', { maximumFractionDigits: 2 })} NEAR · ` : ''}${F.full_access_keys ?? '?'} full-access key${F.full_access_keys === 1 ? '' : 's'} · ${F.app_keys} app key${F.app_keys === 1 ? '' : 's'} · ${F.tokens_held} token${F.tokens_held === 1 ? '' : 's'} held</p>`;
    if (F.apps?.length) facts += `<details><summary class="small">Apps this wallet is logged in to (${F.apps.length})</summary><table class="small"><tr><th>App contract</th><th>Keys</th><th>Status</th></tr>${F.apps.map((a) => `<tr><td class="acct">${esc(short(a.app, 40))}</td><td>${a.keys}</td><td class="${a.status === 'bad' ? 'r' : a.status === 'risky' ? 'a' : a.status === 'known' ? 'g' : 'muted'}">${esc(a.status === 'known' ? 'well-known' : a.status === 'bad' ? 'remove it' : a.status === 'risky' ? 'high risk' : 'unknown')}${a.note ? ` · ${esc(a.note)}` : ''}</td></tr>`).join('')}</table></details>`;
  }
  if (r.nft) facts += `<div class="bar" style="align-items:flex-start;gap:14px;margin-top:10px">${r.nft.media ? `<img src="${esc(r.nft.media.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/'))}" alt="" style="width:84px;height:84px;object-fit:cover;border-radius:10px" loading="lazy" referrerpolicy="no-referrer">` : ''}<div class="small"><b>${esc(r.nft.title || '#' + r.nft.token_id)}</b><div class="muted">Owner: ${esc(r.nft.owner)}${r.nft.approvals?.length ? ` · can be moved by: ${r.nft.approvals.map(esc).join(', ')}` : ''}</div></div></div>`;
  if (F.ai_summary || F.analysis) facts += `<details style="margin-top:8px"><summary class="small">What NEAR AI says</summary>${F.ai_summary ? `<p class="small">${esc(F.ai_summary)}</p>` : ''}${F.analysis ? `<p class="small">${esc(F.analysis)}</p>` : ''}</details>`;
  if (F.accounts?.length) facts += `<p class="small">${F.accounts.map((a) => scLink(a, esc(short(a, 40)))).join(' · ')}</p>`;
  if (r.also?.length) facts += `<details style="margin-top:8px"><summary class="small">Other tokens with this name (${r.also.length})</summary><table class="small">${r.also.map((t) => `<tr><td>${scLink(t.account, esc(short(t.account, 44)))}</td><td>${esc(t.launchpad || '')}</td><td>${t.live_ts ? since(t.live_ts) : ''}</td><td class="${t.rugged ? 'r' : ''}">${t.rugged ? 'rugged' : ''}</td></tr>`).join('')}</table></details>`;
  const L = r.links || {};
  const links = [L.audit && ilink(L.audit, 'Full contract audit →'), L.token && ilink(L.token, 'Token page →'), L.nft && ilink(L.nft, 'Collection page →'), L.wallet && ilink(L.wallet, 'Wallet history →'), L.explorer && `<a href="${esc(L.explorer)}" target="_blank" rel="noopener">NearBlocks ↗</a>`].filter(Boolean).join(' · ');
  const color = cls === 'unknown' ? 'var(--line)' : `var(--${cls})`;
  return `<div class="card" style="border:2px solid ${color}"><div class="bar" style="gap:14px;align-items:center;flex-wrap:nowrap">
      <div style="width:52px;height:52px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:26px;font-weight:700;background:var(--${cls}-soft);color:${cls === 'unknown' ? 'var(--muted)' : color}">${icon}</div>
      <div style="flex:1;min-width:0"><div class="muted small">${esc(SC_KIND[r.kind] || '')}${r.account ? ` · ${esc(short(r.account, 48))}` : ''}${r.name ? ` · ${esc(r.name)}` : ''}${F.type && r.kind !== 'wallet' ? ` · ${esc(F.type)}` : ''}</div>
        <div style="font-size:20px;font-weight:700;color:${cls === 'unknown' ? 'inherit' : color}">${label}</div><div style="font-size:15px;margin-top:2px">${esc(r.headline || '')}</div></div></div>
    ${pts ? `<ul style="padding:0;margin:14px 0 4px">${pts}</ul>` : ''}
    ${r.actions?.length ? `<div class="banner ${cls === 'bad' ? 'bad' : 'neutral'}" style="margin:12px 0 0"><div class="small"><b>What to do</b><ul style="margin:4px 0 0;padding-left:18px">${r.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div></div>` : ''}
    ${scIncidents(r)}${facts}${links ? `<p class="small" style="margin:12px 0 0">${links}</p>` : ''}
    ${r.pending ? '<p class="muted small" style="margin:8px 0 0">The full answer appears here when the audit finishes.</p>' : ''}</div>`;
}
async function scReport() {
  const q = $('repQ').value.trim(); if (!q) return;
  const r = await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tracker': '1' }, body: JSON.stringify({ q, note: $('repNote').value.trim() }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  $('repOut').innerHTML = r.error ? `<span class="r">${esc(r.error)}</span>` : `<span class="g">Thanks: it is being investigated (a few minutes).</span> ${ilink('/firewall?q=' + encodeURIComponent(q), 'Check it now →')}`;
  if (!r.error) { $('repQ').value = ''; $('repNote').value = ''; liveFeed(); }
}
function scExample(i) { $('scInput').value = SC_EXAMPLES[i][1]; scCheck(); }
function scFromUrl() { const q = new URLSearchParams(location.search).get('q'); if (q && $('scInput')) { $('scInput').value = q; scCheck(q); } }

// ================================================================== TRANSACTION FIREWALL, developer tool (raw transaction JSON / borsh)
const FW_EXAMPLES = {
  'Drainer: full-access key': { transaction: { signerId: 'alice.near', receiverId: 'alice.near', actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp', accessKey: { permission: 'FullAccess' } } }] } },
  'Phishing look-alike': { transaction: { signerId: 'alice.near', receiverId: 'wrap.nera', actions: [{ type: 'FunctionCall', params: { methodName: 'near_deposit', args: {}, gas: '30000000000000', deposit: '50000000000000000000000000' } }] } },
  'NFT approval': { transaction: { signerId: 'alice.near', receiverId: 'x.paras.near', actions: [{ type: 'FunctionCall', params: { methodName: 'nft_approve', args: { token_id: '42', account_id: 'free-mint-claim.near' }, gas: '30000000000000', deposit: '10000000000000000000000' } }] } },
  'Everyday: wrap 1 NEAR': { transaction: { signerId: 'alice.near', receiverId: 'wrap.near', actions: [{ type: 'FunctionCall', params: { methodName: 'near_deposit', args: {}, gas: '30000000000000', deposit: '1000000000000000000000000' } }] } },
};
const FW_STYLE = { block: ['bad', 'BLOCK: do not sign'], warn: ['bad', 'WARNING'], caution: ['neutral', 'CAUTION'], ok: ['good', 'NO KNOWN RISK'] };
const FW_SEV = { critical: 'bad', high: 'bad', medium: 'neutral', info: 'unrated' };
function fwExample(name) { $('fwInput').value = JSON.stringify(FW_EXAMPLES[name], null, 1); }
async function fwCheck() {
  const raw = $('fwInput').value.trim(), out = $('fwOut');
  if (!raw) return;
  let body;
  if (/^[{[]/.test(raw)) { try { body = JSON.parse(raw); } catch (e) { out.innerHTML = `<div class="card err">Not valid JSON: ${esc(e.message)}</div>`; return; } if (Array.isArray(body)) body = { transactions: body }; else if (!body.transaction && !body.transactions && !/_base64$/.test(Object.keys(body)[0] || '')) body = { transaction: body }; }
  else body = { base64: raw.replace(/\s+/g, '') };
  if ($('fwSigner').value.trim()) body.signer_id = $('fwSigner').value.trim();
  if ($('fwExplain').checked) body.explain = true;
  out.innerHTML = `<div class="card muted">Checking${body.explain ? ' (the AI explanation takes a few seconds)' : ''} …</div>`;
  const r = await fetch('/api/v1/tx/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  if (r.error) { out.innerHTML = `<div class="card err">${esc(r.error)}</div>`; return; }
  const [cls, label] = FW_STYLE[r.verdict] || ['unrated', r.verdict];
  const E = r.explanation;
  out.innerHTML = `<div class="card"><div class="head"><h2><span class="v ${cls}" style="font-size:15px">${label}</span> ${esc(r.summary)}</h2><span class="muted small">${r.took_ms} ms${r.context?.complete === false ? ' · some lookups timed out' : ''}</span></div>
    ${E ? `<p><b>${esc(E.headline)}</b></p><p class="small">${esc(E.explanation)}</p>${E.advice?.length ? `<ul class="flags small">${E.advice.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}` : ''}
    ${r.findings.length ? `<h3>Findings</h3><table class="small">${r.findings.map((f) => `<tr><td><span class="v ${FW_SEV[f.severity]}">${esc(f.severity)}</span></td><td><b>${esc(f.title)}</b><div class="muted">${esc(f.detail)}</div></td><td><code>${esc(f.code)}</code></td></tr>`).join('')}</table>` : ''}
    <h3>What signing does</h3>${r.transactions.map((t, i) => `<div class="small" style="margin:6px 0"><b>${r.transactions.length > 1 ? `Transaction ${i + 1}: ` : ''}${esc(t.signer || '(signer not given)')} → ${esc(t.receiver)}</b>${t.meta ? ' <span class="muted">meta transaction</span>' : ''}
      <ol style="margin:4px 0;padding-left:20px">${t.actions.map((a) => `<li>${esc(a.text)}</li>`).join('')}</ol></div>`).join('')}</div>`;
}
views.firewall = async () => `<div class="grid2 main-l"><div id="liveFeed"><div class="card muted">Loading the live feed …</div></div>
  <div><div class="card" style="padding:22px">
    <h2 style="font-size:20px;margin:0 0 4px">Is it safe?</h2>
    <p class="muted" style="margin:0 0 12px">Paste anything from NEAR and get a plain answer: a wallet, a token or its name, an NFT, a contract, a transaction hash, a NearBlocks / Mintbase / Paras link, a website, a public key, or what your wallet asks you to sign. Anything linked to a hack shows the investigation; <code>target:&lt;contract&gt;</code> looks for hacks on a contract.</p>
    <div class="bar" style="gap:8px;flex-wrap:nowrap"><textarea id="scInput" rows="1" placeholder="alice.near · BLACKDRAGON · a transaction hash · https://…" autocomplete="off" spellcheck="false"
      style="flex:1;font-size:16px;padding:12px 14px;border-radius:12px;resize:none;min-height:50px;max-height:180px;overflow:auto"
      oninput="this.style.height='auto';this.style.height=Math.min(180,this.scrollHeight)+'px'" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();scCheck()}"
      onpaste="setTimeout(()=>scCheck(),0)"></textarea><button class="cta" style="padding:12px 22px;font-size:15px" onclick="scCheck()">Check</button></div>
    <div class="bar small" style="margin-top:10px;gap:6px"><span class="muted">Try:</span>${SC_EXAMPLES.map(([l], i) => `<button class="chip" style="cursor:pointer" onclick="scExample(${i})">${esc(l)}</button>`).join('')}</div>
    <p class="muted small" style="margin:10px 0 0">Nothing is signed or sent, and nothing you paste is kept. Never paste your seed phrase or private key: this page refuses them.</p>
    <details style="margin-top:10px"><summary class="small"><b>Report a hack, a drainer or stolen funds</b></summary>
      <p class="muted small">Give the account or a transaction; it is investigated from the chain and shows in the live feed. Nothing is flagged on a report alone. Also from Telegram: <code>/report &lt;account&gt;</code> to @safenear_bot.</p>
      <div class="bar" style="flex-wrap:nowrap;gap:8px"><input id="repQ" placeholder="account or transaction hash" style="flex:1"><input id="repNote" placeholder="what happened (optional)" style="flex:1"><button onclick="scReport()">Report</button></div><div id="repOut" class="small"></div></details></div>
  <div id="scOut"></div>
  <details class="card"><summary><b>For developers:</b> raw transaction check (JSON / borsh, signer, AI explanation)</summary>
    <p class="small muted" style="margin-top:0">Paste what a wallet or dApp is asking you to sign: JSON (wallet-selector or RPC format) or base64 borsh (Transaction, SignedTransaction, or a meta-transaction SignedDelegateAction). Nothing is signed or sent.</p>
    <div class="bar">${Object.keys(FW_EXAMPLES).map((k) => `<button onclick="fwExample('${esc(k)}')">${esc(k)}</button>`).join('')}</div>
    <textarea id="fwInput" rows="12" style="width:100%;font-family:var(--mono, monospace);font-size:12px" placeholder='{"signerId":"alice.near","receiverId":"wrap.near","actions":[{"type":"FunctionCall","params":{"methodName":"near_deposit","args":{},"gas":"30000000000000","deposit":"1000000000000000000000000"}}]}'></textarea>
    <div class="bar"><input id="fwSigner" placeholder="signer account (if not in the transaction)" style="flex:1"><label class="small"><input type="checkbox" id="fwExplain"> explain with AI</label><button class="cta" style="padding:9px 18px;font-size:14px" onclick="fwCheck()">Check</button></div>
  </details><div id="fwOut"></div>
  <details class="card"><summary><b>For wallets, dApps and developers:</b> the API and what it catches</summary><div class="card"><h2>For wallets and dApps</h2>
    <p class="small">Call the same check from your wallet or dApp right before the signing screen. It's free, works from any origin, and keeps nothing about the transaction.</p>
    <p class="small"><code>POST /api/v1/tx/check</code> with <code>{"transaction": …}</code>, <code>{"transactions": [ … ]}</code> or <code>{"transaction_base64": "…"}</code> → <code>verdict</code> (ok / caution / warn / block), the findings, and one plain line per action. Add <code>"explain": true</code> for an AI explanation.</p>
    <p class="small"><b>Blocklist feed</b> for swap services, bridges, exchanges and wallets: <code>GET /api/v1/flags?since=&lt;ms&gt;</code> (every flagged account, synced incrementally) and <code>GET /api/v1/flags/check?ids=a,b</code> before a swap or withdrawal goes through. Accounts are flagged only from confirmed incidents and operator reports.</p>
    <p class="small"><code>GET /api/v1/inspect?q=…</code> → the same answer as this page for anything pasted (wallet, contract, token, NFT, tx hash, link, website).</p>
    <p class="small"><code>GET /api/v1/account?id=…</code> → the reputation of one account, for "send to" screens.</p>
    <p class="small"><a href="https://github.com/poppingbean/entity-tracker/blob/main/docs/tx-firewall.md" target="_blank" rel="noopener">Integration guide ↗</a> · 300 checks per 10 minutes per IP.</p></div>
  <div class="card"><h2>What it catches</h2><ul class="flags small">
    <li><b>Wallet drainers:</b> full-access keys, key swaps, account deletion, code deployed on your wallet</li>
    <li><b>Phishing:</b> look-alike contracts (wrap.nera, v2.ref-flnance.near) and reported drainers</li>
    <li><b>Approvals:</b> NFT approvals and rights granted to unknown contracts</li>
    <li><b>Rugs:</b> buying or sending tokens that rugged, or whose creator dumped before</li>
    <li><b>Mistakes:</b> sending almost everything you hold, typos in the receiver</li>
    <li><b>Wallets:</b> extra full-access keys, apps connected to look-alike or flagged contracts, rugged and fake tokens held</li>
    <li><b>Contracts:</b> any type (tokens, NFTs, pools, lending …): who controls it and what its code lets them do</li>
    <li><b>Websites:</b> look-alike addresses of NEAR sites, "claim / airdrop / sync wallet" lures, punycode</li></ul>
    <p class="muted small" style="margin:8px 0 0">The verdict comes from fixed rules and the automated contract audit; the AI only explains it and can never make something look safer.</p></div></details></div></div>`;
