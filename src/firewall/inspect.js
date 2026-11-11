// "Is it safe?" for whatever a user pastes: a wallet, a contract (token, NFT collection, pool, any type), a token name, a single NFT, a
// transaction hash, an explorer / marketplace link, a website, a public key, or a transaction a wallet is about to sign. One answer in
// plain words: a verdict, the points behind it and what to do. Secrets (seed phrases, private keys) are refused without being read.
import { col } from '../db.js';
import { viewAccount, viewAccessKeyList, viewFunction, EMPTY_CODE_HASH } from '../audit/rpc.js';
import { validNearAddress, STRONG_FINDINGS } from '../audit/service.js';
import { fastnearGet, txIndexer } from '../near/rpc.js';
import { contractReport } from '../audit/report.js';
import { accountReputation } from './context.js';
import { checkRequest } from './service.js';
import { lookalikeOf, TRUSTED } from './rules.js';
import { toNear } from './decode.js';
import { flowsOfTx } from '../incident/flows.js';
import { valueOf } from '../incident/prices.js';
import { config } from '../config.js';
import { detectChainAddress, parseChainId } from '../ontology/chains.js';

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const TX_HASH = new RegExp(`^${B58}{43,44}$`);
const PUBLIC_KEY = new RegExp(`^(ed25519|secp256k1):${B58}{43,90}$`);
const IMPLICIT = /^[0-9a-f]{64}$|^0x[0-9a-f]{40}$/;
const WEB_TLD = /\.(com|org|net|io|xyz|app|finance|exchange|money|fi|dev|ai|co|gg|site|online|live|top|info|pro|me|cc|link|club|vip|world|tech|network|cash|trade|space|fun|zone|claims?|gift|digital)$/;
const NEAR_SITES = ['near.org', 'near.ai', 'nearblocks.io', 'pikespeak.ai', 'app.ref.finance', 'ref.finance', 'rhea.finance', 'app.rhea.finance', 'mynearwallet.com', 'app.mynearwallet.com', 'meteorwallet.app',
  'wallet.meteorwallet.app', 'herewallet.app', 'hot-labs.org', 'sender.org', 'senderwallet.io', 'app.burrow.finance', 'burrow.finance', 'metapool.app', 'linearprotocol.org', 'mintbase.xyz', 'paras.id',
  'intear.tech', 'meme.cooking', 'aurora.dev', 'bitte.ai', 'wallet.bitte.ai', 'nearmobile.app', 'intents.near.org', 'app.near-intents.org', 'near-intents.org', 'dex.intear.tech', 'justhoot.com', 'tkn.homes',
  'fastnear.com', 'sweateconomy.com', 'shitzu.app', 'nearcatalog.org'];
const LURE = /airdrop|claim|reward|bonus|giveaway|free-?near|verify|validate|sync|rectif|restore|migrat|unlock|recover|connect-?wallet|wallet-?connect|support|dapps?-?fix/;
// well-known tokens by symbol (the tracker itself follows launchpad tokens)
const KNOWN_TOKENS = { near: 'wrap.near', wnear: 'wrap.near', usdt: 'usdt.tether-token.near', usdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', sweat: 'token.sweat',
  ref: 'token.v2.ref-finance.near', rhea: 'token.rhealab.near', stnear: 'meta-pool.near', linear: 'linear-protocol.near', blackdragon: 'blackdragon.tkn.near', aurora: 'aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near',
  brrr: 'token.burrow.near', shitzu: 'token.0xshitzu.near', lonk: 'token.lonkingnearbackto2024.near', neko: 'ftv2.nekotoken.near', nearkat: 'kat.token0.near', jambo: 'jambo-1679.meme-cooking.near',
  intel: 'intel.tkn.near', purge: 'purge-558.meme-cooking.near', gear: 'gear.enleap.near', mpdao: 'mpdao-token.near', dai: '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near', wbtc: '2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near', nbtc: 'nbtc.bridge.near' };
const SEED_WORDS = /^([a-z]{3,8})( [a-z]{3,8}){11,23}$/;

const short = (s) => (typeof s === 'string' && IMPLICIT.test(s) && s.length > 20 ? s.slice(0, 8) + '…' + s.slice(-4) : s);
const ORDER = ['bad', 'warn', 'info', 'good'];
const VERDICTS = { bad: 'danger', warn: 'caution', info: 'safe', good: 'safe' };
const verdictOf = (points, fallback = 'safe') => { const w = points.map((p) => p.level).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0]; return w ? (w === 'info' || w === 'good' ? fallback : VERDICTS[w]) : fallback; };
const LEVEL_OF = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info', info: 'info' };
const pt = (level, text) => ({ level, text });
const nearblocks = (kind, id) => `https://nearblocks.io/${kind}/${encodeURIComponent(id)}`;

/** What the pasted text is. Returns { kind, value, extra? }; kinds: tx, account, token_search, nft, public_key, website, unsigned_tx, secret, empty, unknown. */
export function parseInput(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return { kind: 'empty' };
  const lower = s.toLowerCase().replace(/\s+/g, ' ');
  if (SEED_WORDS.test(lower) && [12, 15, 18, 21, 24].includes(lower.split(' ').length)) return { kind: 'secret' };
  if (/^(ed25519|secp256k1):/i.test(s) && s.length > 80) return { kind: 'secret' }; // a private key (64 bytes), not a public one (32)
  if (/^[{[]/.test(s)) return { kind: 'unsigned_tx', value: s };
  if (s.length > 120 && /^[A-Za-z0-9+/=\s]+$/.test(s)) return { kind: 'unsigned_tx', value: s.replace(/\s+/g, '') };
  { const ca = detectChainAddress(s); if (ca) return { kind: 'chain_address', value: ca }; }
  if (PUBLIC_KEY.test(s)) return { kind: 'public_key', value: s };
  if (TX_HASH.test(s)) return { kind: 'tx', value: s };
  // links: explorers and marketplaces point at the thing; any other site is a website to check
  if (/^(https?:\/\/|www\.)/i.test(s) || (/^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(s) && WEB_TLD.test(s.split('/')[0].toLowerCase()))) {
    let u;
    try { u = new URL(/^https?:/i.test(s) ? s : 'https://' + s); } catch { return { kind: 'unknown', value: s }; }
    const host = u.hostname.toLowerCase().replace(/^www\./, ''), parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const q = (k) => u.searchParams.get(k);
    if (/(^|\.)nearblocks\.io$/.test(host) || host === 'explorer.near.org' || host === 'nearscope.net' || /(^|\.)pikespeak\.ai$/.test(host) || host === 'neartracker.io') {
      const [a, b, c] = parts;
      if (/^(txns?|transactions?|transaction-viewer|tx|hash)$/.test(a) && b) return { kind: 'tx', value: b };
      if (a === 'nft-token' && b && c) return { kind: 'nft', value: b.toLowerCase(), extra: c };
      if (/^(address|accounts?|wallet-explorer|token|nft-token|contract|validator)$/.test(a) && b) return { kind: 'account', value: b.toLowerCase() };
      if (q('query') || q('q')) return parseInput(q('query') || q('q'));
    }
    if (/(^|\.)mintbase\.xyz$/.test(host)) {
      if (parts[0] === 'contract' && parts[1]) return parts[2] === 'token' && parts[3] ? { kind: 'nft', value: parts[1], extra: parts[3] } : { kind: 'account', value: parts[1] };
      if (parts[0] === 'meta' && parts[1]?.includes(':')) return { kind: 'account', value: parts[1].split(':')[0] };
    }
    if (/(^|\.)paras\.id$/.test(host)) {
      if (parts[0] === 'collection' && parts[1]) return { kind: 'account', value: parts[1].split('::')[0] };
      if (parts[0] === 'token' && parts[1]) return parts[2] ? { kind: 'nft', value: parts[1].split('::')[0], extra: parts[2] } : { kind: 'account', value: parts[1].split('::')[0] };
    }
    const tok = q('tokenIn') || q('tokenOut') || q('token') || q('contract');
    if (tok && validNearAddress(tok.toLowerCase()) && NEAR_SITES.some((k) => host === k || host.endsWith('.' + k))) return { kind: 'account', value: tok.toLowerCase(), extra: { from_site: host } };
    return { kind: 'website', value: host, extra: { https: u.protocol === 'https:', path: u.pathname } };
  }
  if (/^@/.test(s)) s = s.slice(1);
  const id = s.toLowerCase();
  if (/^\$/.test(s)) return { kind: 'token_search', value: s.slice(1) };
  // "contract:token_id" or "contract/token_id" for one NFT
  const nft = id.match(/^([a-z0-9._-]+\.[a-z0-9_-]+)[:/#]+([^\s]+)$/);
  if (nft && validNearAddress(nft[1])) return { kind: 'nft', value: nft[1], extra: nft[2] };
  if (validNearAddress(id)) {
    if (!id.includes('.') && !IMPLICIT.test(id)) return { kind: 'token_search', value: s, extra: { or_account: id } }; // "blackdragon": a token name, else a top-level account
    if (WEB_TLD.test(id) && !/\.(near|tg|sweat|aurora|testnet)$/.test(id)) return { kind: 'account', value: id, extra: { or_website: true } };
    return { kind: 'account', value: id };
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) return { kind: 'website', value: id, extra: { https: null } };
  if (/^[\w$ .-]{2,40}$/.test(s)) return { kind: 'token_search', value: s };
  return { kind: 'unknown', value: s };
}

/** One answer for whatever was pasted. */
export async function inspect(raw) {
  const p = parseInput(raw);
  const t0 = Date.now();
  const r = await route(p);
  await withIncidents(p, r).catch(() => {});
  return { input_kind: p.kind, ...r, checked_ts: Date.now(), took_ms: Date.now() - t0 };
}

const INC_FIELDS = { status: 1, kind: 1, 'attacker.account': 1, 'target.account': 1, stolen_usd: 1, held_usd: 1, started_ts: 1, first_seen_ts: 1, 'ai.headline': 1, 'ai.attack_type': 1, 'trail.exit_usd': 1, accounts: 1 };
const incRow = (d, role) => ({ id: d._id, role, status: d.status, kind: d.kind, attacker: d.attacker?.account, target: d.target?.account || null, stolen_usd: d.stolen_usd, held_usd: d.held_usd,
  when: d.started_ts || d.first_seen_ts, headline: d.ai?.headline || null, attack_type: d.ai?.attack_type || null, exits: d.trail?.exit_usd || {} });
/** The hacks an answer touches: the transaction was one of the attack's, the account is the attacker's (or one of its wallets), or the contract was hit. */
async function withIncidents(p, r) {
  const id = r.account || (p.kind === 'account' ? p.value : null), hash = p.kind === 'tx' ? p.value : null;
  if (!id && !hash) return;
  const or = [...(hash ? [{ 'attack_txs.tx': hash }] : []), ...(id ? [{ 'accounts.account': id }, { 'target.account': id }] : [])];
  const docs = await col('incidents').find({ $or: or, status: { $in: ['confirmed', 'suspected'] } }, { projection: INC_FIELDS }).sort({ started_ts: -1 }).limit(5).toArray();
  if (!docs.length) return;
  r.incidents = docs.map((d) => {
    const acc = (d.accounts || []).find((a) => a.account === id);
    const role = hash ? 'attack_tx' : d.target?.account === id ? 'target' : acc?.role || 'attacker';
    return incRow(d, role);
  });
  const own = r.incidents.find((x) => ['attack_tx', 'attacker', 'fake_token', 'sub_account', 'contract', 'cash_out_wallet', 'intents_account'].includes(x.role) && x.status === 'confirmed');
  // the receiving account of a case still being watched: not a proven hack, so never "danger", but never "looks safe" either
  const watched = !own && r.incidents.find((x) => ['attacker', 'sub_account', 'intents_account'].includes(x.role) && x.status === 'suspected');
  if (watched && ['safe', 'unknown'].includes(r.verdict)) {
    r.verdict = 'caution';
    r.headline = `Be careful: this account is part of a case Safe Near is watching (~$${Math.round(watched.stolen_usd || 0).toLocaleString('en-US')} in large transfers, not a proven hack).`;
  }
  if (own) {
    r.verdict = 'danger';
    r.headline = own.role === 'attack_tx' ? `This transaction is part of a hack: ${own.target || 'wallets'} lost ~$${Math.round(own.stolen_usd).toLocaleString('en-US')}.` : `Part of a hack: ${own.headline || `~$${Math.round(own.stolen_usd).toLocaleString('en-US')} taken from ${own.target || 'wallets'}`}`;
  }
}
async function route(p) {
  switch (p.kind) {
    case 'empty': return { kind: 'empty', verdict: 'unknown', headline: 'Paste a wallet, a contract, a token, an NFT, a transaction or a link.' };
    case 'secret': return { kind: 'secret', verdict: 'danger', headline: 'This looks like a secret: never paste it anywhere.',
      points: [pt('bad', 'A seed phrase or a private key gives full control of the wallet to whoever sees it. It was not checked or stored.'), pt('warn', 'No real app, support agent or airdrop will ever ask for it.')],
      actions: ['If you typed it into a website or sent it to someone, move your funds to a new wallet now.'] };
    case 'unsigned_tx': return inspectUnsigned(p.value);
    case 'tx': return inspectTx(p.value);
    case 'chain_address': return inspectChainAddress(p.value);
    case 'public_key': return inspectPublicKey(p.value);
    case 'website': return inspectWebsite(p.value, p.extra);
    case 'nft': return inspectNft(p.value, p.extra);
    case 'token_search': return inspectTokenSearch(p.value, p.extra);
    case 'account': {
      const r = await inspectAccount(p.value, p.extra);
      if (r.kind === 'missing' && p.extra?.or_website) return inspectWebsite(p.value, { https: null });
      return r;
    }
    default: return { kind: 'unknown', verdict: 'unknown', headline: 'We could not tell what this is.', points: [pt('info', 'Paste a NEAR account (alice.near), a contract, a token name, a transaction hash, or a link from NearBlocks, Mintbase, Paras or a website.')] };
  }
}

// ------------------------------------------------------------------------------------------------ a transaction already on chain
async function inspectTx(hash) {
  const j = await txIndexer('/v0/transactions', { tx_hashes: [hash] }).catch(() => null);
  const t = j?.transactions?.[0];
  if (!t) return { kind: 'tx', verdict: 'unknown', headline: 'No transaction with this hash was found.', points: [pt('info', 'Check that the whole hash was copied. Very new transactions can take a few seconds to show.')], links: { explorer: nearblocks('txns', hash) } };
  const tx = t.transaction;
  const failed = (t.receipts || []).some((r) => r.execution_outcome?.outcome?.status?.Failure);
  const check = await checkRequest({ transaction: { signer_id: tx.signer_id, receiver_id: tx.receiver_id, actions: tx.actions } }).catch((e) => ({ error: e.message }));
  const ts = Number(t.execution_outcome?.block_timestamp || 0) / 1e6 || null;
  const points = [];
  if (check.error) points.push(pt('info', `Its actions could not be read (${check.error}).`));
  for (const f of (check.findings || []).filter((x) => x.severity !== 'info').slice(0, 8)) points.push(pt(LEVEL_OF[f.severity], `${f.title}. ${f.detail || ''}`.trim()));
  if (!points.length && !check.error) points.push(pt('good', 'Nothing risky found in what it did.'));
  points.unshift(pt(failed ? 'warn' : 'info', failed ? 'It failed on chain (part or all of it did not happen; attached NEAR is normally refunded).' : 'It went through on chain.'));
  const did = (check.transactions || []).flatMap((x) => x.actions.map((a) => a.text)).filter(Boolean);
  const payout = await bigPayout(t).catch(() => null);
  if (payout) points.push(pt('warn', `${payout.from} paid ~$${Math.round(payout.usd).toLocaleString('en-US')} (${payout.tokens.join(', ')}) to ${short(payout.to)} in this transaction, for ~$${Math.round(payout.paid_usd).toLocaleString('en-US')} in return. If that was not a normal withdrawal, investigate it as a hack.`));
  const v = check.verdict === 'block' || check.verdict === 'warn' ? 'danger' : check.verdict === 'caution' ? 'caution' : check.error ? 'unknown' : 'safe';
  return { kind: 'tx', verdict: v, headline: v === 'safe' ? `A normal transaction from ${short(tx.signer_id)} to ${short(tx.receiver_id)}.` : check.summary,
    facts: { from: tx.signer_id, to: tx.receiver_id, when: ts, status: failed ? 'failed' : 'success', did }, points, ...(payout ? { investigate: { q: hash, payout } } : {}),
    actions: v === 'danger' ? ['If you signed this by mistake: check your wallet for keys you do not recognise and remove them, and move funds to a new wallet if a full-access key was added.'] : [],
    links: { explorer: nearblocks('txns', hash) } };
}

/** The largest value a contract paid one account in a transaction, net of what it got back from it, when it is over the incident threshold. */
async function bigPayout(t) {
  const per = new Map();
  for (const f of flowsOfTx(t)) {
    if (/^(nft|mint|burn|intents|chain):/.test(f.token) || /^(mint|burn|intents|chain):/.test(f.from + f.to)) continue;
    for (const [k, sign] of [[`${f.from}>${f.to}`, 1], [`${f.to}>${f.from}`, -1]]) { const x = per.get(k) || []; x.push({ ...f, sign }); per.set(k, x); }
  }
  let best = null;
  for (const [k, fs] of per) {
    const [from, to] = k.split('>');
    if (['wrap.near', 'intents.near', 'aggregatedex.near'].includes(from) || from === 'system') continue;
    let got = 0, paid = 0; const tokens = new Set();
    for (const f of fs) { const v = await valueOf(f.token, f.raw); if (f.sign > 0) { got += v.usd || 0; if (v.usd) tokens.add(v.symbol); } else paid += v.usd || 0; }
    if (got - paid >= config.incidents.minUsd && (!best || got - paid > best.usd - best.paid_usd)) best = { from, to, usd: got, paid_usd: paid, tokens: [...tokens].slice(0, 6) };
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ a transaction a wallet will sign
async function inspectUnsigned(text) {
  let body;
  if (/^[{[]/.test(text)) {
    try { body = JSON.parse(text); } catch { return { kind: 'unsigned_tx', verdict: 'unknown', headline: 'This is not valid JSON.', points: [pt('info', 'Paste the transaction exactly as your wallet or the dApp shows it.')] }; }
    if (Array.isArray(body)) body = { transactions: body };
  } else body = { base64: text };
  const r = await checkRequest(body).catch((e) => ({ error: e.message }));
  if (r.error) return { kind: 'unsigned_tx', verdict: 'unknown', headline: 'This transaction could not be read.', points: [pt('info', r.error)] };
  const v = r.verdict === 'block' || r.verdict === 'warn' ? 'danger' : r.verdict === 'caution' ? 'caution' : 'safe';
  const points = r.findings.filter((x) => x.severity !== 'info').slice(0, 10).map((f) => pt(LEVEL_OF[f.severity], `${f.title}. ${f.detail || ''}`.trim()));
  if (!points.length) points.push(pt('good', 'Nothing risky found in what it asks you to sign.'));
  return { kind: 'unsigned_tx', verdict: v, headline: v === 'safe' ? 'Looks safe to sign.' : v === 'danger' ? `Do not sign: ${r.summary}` : r.summary,
    facts: { did: r.transactions.flatMap((x) => x.actions.map((a) => a.text)).filter(Boolean) }, points, firewall: r,
    actions: v === 'danger' ? ['Reject it in your wallet and leave the site that asked for it.'] : [] };
}

// ------------------------------------------------------------------------------------------------ an account: wallet or contract
async function accountState(id) {
  try { return await viewAccount(id); } catch (e) { if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(e.message)) return null; throw e; }
}
export async function inspectAccount(id, extra = {}) {
  const a = await accountState(id);
  if (!a) {
    const look = lookalikeOf(id);
    return { kind: 'missing', verdict: look ? 'danger' : 'unknown', headline: `${short(id)} does not exist on NEAR.`,
      points: look ? [pt('bad', `The name imitates ${look}. Someone may be preparing a fake account: do not send anything to it.`)] : [pt('info', IMPLICIT.test(id) ? 'An implicit account exists once it receives NEAR for the first time.' : 'Check the spelling: anything sent here would fail.')],
      links: { explorer: nearblocks('address', id) } };
  }
  const contract = a.code_hash !== EMPTY_CODE_HASH || !!a.global_contract_hash || !!a.global_contract_account_id;
  return contract ? inspectContract(id, a, extra) : inspectWallet(id, a);
}

async function trackerToken(id) {
  const t = await col('tokens').findOne({ _id: id }, { projection: { symbol: 1, name: 1, creator: 1, launchpad: 1, source: 1, factory: 1, live_ts: 1, status: 1, tax: 1, outcome: 1, 'scan.decision': 1 } });
  if (!t) return null;
  const [black, rec, an, hackLinks] = await Promise.all([
    t.creator ? col('blacklist').findOne({ _id: t.creator }) : null,
    t.creator ? col('tokens').aggregate([{ $match: { creator: t.creator } }, { $group: { _id: null, launches: { $sum: 1 }, rugged: { $sum: { $cond: ['$outcome.rugged', 1, 0] } } } }]).toArray() : [],
    col('analyses').findOne({ _id: id }, { projection: { 'ai.summary': 1, 'ai.ts': 1, 'ai.verdict': 1 } }),
    tokenHackLinks(id, t.creator).catch(() => null),
  ]);
  return { ...t, creator_blacklisted: !!black, creator_record: rec[0] || null, analysis: an?.ai || null, hack_links: hackLinks };
}

/**
 * Is a token tied to a hack? Its creator, or the wallets that bought it, as accounts of a confirmed case (the Binance-case laundering memecoins were
 * bought almost only by wallets the attacker's account paid). Returns { creator: { case, role } | null, buyers: n (buyers in a case), early: n (all buyers), cases: [ids] }.
 */
async function tokenHackLinks(id, creator) {
  // every wallet that bought it, not only the early ones: laundering wallets often buy hours after the launch
  const early = (await col('trades').distinct('trader', { token: id, buy: true }).catch(() => [])).slice(0, 3000);
  const ids = [...new Set([creator, ...early].filter(Boolean))];
  if (!ids.length) return null;
  const cases = await col('incidents').find({ status: 'confirmed', 'accounts.account': { $in: ids } }, { projection: { 'accounts.account': 1, 'accounts.role': 1 } }).limit(20).toArray();
  const roleOf = new Map();
  for (const c of cases) for (const a of c.accounts || []) if (ids.includes(a.account) && !roleOf.has(a.account)) roleOf.set(a.account, { case: c._id, role: a.role });
  const buyers = early.filter((w) => roleOf.has(w) && w !== creator).length;
  return { creator: creator && roleOf.get(creator) || null, buyers, early: early.length, cases: [...new Set([...roleOf.values()].map((x) => x.case))] };
}

async function inspectContract(id, state, extra) {
  const [rep, audit, tok, meta] = await Promise.all([accountReputation(id).catch(() => null), contractReport(id, { start: true }).catch(() => null), trackerToken(id).catch(() => null),
    viewFunction(id, 'ft_metadata').catch(() => null)]);
  const points = [];
  const look = lookalikeOf(id);
  if (look) points.push(pt('bad', `The name imitates ${look}: this is very likely a fake.`));
  for (const f of rep?.flags || []) points.push(pt(LEVEL_OF[f.severity] || 'warn', f.detail || f.reason));
  const hit = await col('incidents').find({ 'target.account': id, status: 'confirmed' }, { projection: { stolen_usd: 1, started_ts: 1, 'ai.attack_type': 1 } }).sort({ started_ts: -1 }).limit(1).toArray().catch(() => []);
  if (hit[0]) points.push(pt('warn', `It was exploited ${hit[0].started_ts ? `on ${new Date(hit[0].started_ts).toISOString().slice(0, 10)} ` : ''}(~$${Math.round(hit[0].stolen_usd).toLocaleString('en-US')} taken${hit[0].ai?.attack_type ? `, ${hit[0].ai.attack_type}` : ''}). Check the team has fixed it before depositing.`));
  // what the tracker saw this token do
  if (tok) {
    const o = tok.outcome || {};
    if (o.rugged) points.push(pt('bad', `This token was rugged${o.rug_reason ? `: ${o.rug_reason}` : ''}.`));
    if (tok.creator_blacklisted) points.push(pt('bad', `Its creator ${short(tok.creator)} is on the rug blacklist.`));
    else if (tok.creator_record?.rugged > 0) points.push(pt('warn', `Its creator ${short(tok.creator)} has ${tok.creator_record.rugged} rugged token${tok.creator_record.rugged > 1 ? 's' : ''} out of ${tok.creator_record.launches}.`));
    const T = tok.tax || {}, fee = Math.round(Math.max(Number(T.sellBps ?? T.sell_bps ?? 0) / 100, Number(T.transferFeePips ?? 0) / 1e4) * 100) / 100;
    if (fee >= 10) points.push(pt('bad', `Selling costs a ${fee}% fee.`)); else if (fee > 0) points.push(pt('info', `It takes a ${fee}% fee on trades.`));
    if (!o.rugged && o.drawdown >= 0.9) points.push(pt('warn', `The price is ${Math.round(o.drawdown * 100)}% below its peak.`));
    const H = tok.hack_links;
    if (H?.creator) points.push(pt('bad', `Its creator ${short(tok.creator)} is part of a confirmed hack case (${String(H.creator.role || 'linked').replace(/_/g, ' ')}).`));
    if (H?.buyers) points.push(pt(H.buyers >= 3 || H.buyers / Math.max(1, H.early) >= 0.3 ? 'bad' : 'warn', `${H.buyers} of the ${H.early} wallets that bought it are wallets of a confirmed hack case: money from a hack bought this token.`));
    if (tok.source === 'deploy') points.push(pt('info', `Found from its deploy${tok.factory ? ` through ${tok.factory}` : ''} and its first liquidity, not from a launchpad.`));
  }
  // the automated contract audit
  let auditing = false;
  if (audit?.status === 'ok' || audit?.status === 'refreshing') {
    // powers the owner keeps are a caution; danger is for evidence of abuse (fake storage, hidden powers, flagged owners, failing sells …)
    for (const f of (audit.findings || []).slice(0, 6)) { const l = LEVEL_OF[f.severity] || 'info'; points.push(pt(l === 'bad' && !STRONG_FINDINGS.has(f.key) ? 'warn' : l, `${f.title}${f.detail ? `: ${f.detail}` : ''}`)); }
    const risky = (audit.powers || []).filter((x) => !x.normal_for_type && (x.severity === 'high' || x.severity === 'critical'));
    if (risky.length && !audit.findings?.length) points.push(pt('warn', `Its code lets the owner: ${risky.map((x) => x.label.toLowerCase()).join(', ')}.`));
    if (audit.control?.summary) points.push(pt('info', `Who controls it: ${audit.control.summary}.`));
  } else if (audit?.status === 'auditing' || audit?.status === 'queued') { auditing = true; points.push(pt('info', 'Its code is being audited right now (about a minute). This page updates when it is done.')); }
  const kind = tok || meta?.symbol || audit?.type?.role === 'token' ? 'token' : audit?.type?.role === 'nft' ? 'nft_collection' : 'contract';
  const name = tok?.symbol || meta?.symbol || null;
  const known = TRUSTED.has(id);
  if (known && !points.some((x) => x.level === 'bad')) points.unshift(pt('good', 'A well-known NEAR contract.'));
  let v = verdictOf(points, auditing ? 'pending' : 'safe');
  if (v === 'safe' && audit?.level && ['critical', 'high'].includes(audit.level)) v = 'caution';
  // a well-known contract whose only problems are the powers its issuer keeps (a stablecoin's freeze, an upgradable protocol): not a scam
  const centralOnly = known && !look && !(rep?.flags || []).length && !tok?.outcome?.rugged && !tok?.creator_blacklisted;
  if (centralOnly && v === 'danger') { v = 'caution'; for (const x of points) if (x.level === 'bad') x.level = 'warn'; }
  if (v === 'caution' && !centralOnly && !points.some((x) => x.level === 'bad') && audit?.level && ['critical', 'high'].includes(audit.level)) points.push(pt('info', 'These powers are common, but they mean you trust whoever holds them. A DAO or a multisig is safer than a single wallet.'));
  const label = kind === 'token' ? `the token ${name || id}` : kind === 'nft_collection' ? 'this NFT collection' : `this ${audit?.type?.label?.toLowerCase() || 'contract'}`;
  const headline = centralOnly && v === 'caution' ? `A well-known ${kind === 'token' ? 'token' : 'contract'}, but whoever runs ${name || id} keeps strong powers over it (listed below).` : v === 'danger' ? `Be careful with ${label}: we found serious problems.` : v === 'caution' ? `Some risks with ${label}: read them before using it.` : v === 'pending' ? `Checking ${label} …` : `No red flags found for ${label}.`;
  if (!points.length) points.push(pt('good', 'No problem found in its code, its owners or its history.'));
  return { kind, verdict: v, headline: audit?.summary?.headline && v !== 'pending' && !centralOnly ? `${headline} ${audit.summary.headline}` : headline, account: id, name,
    facts: { type: audit?.type?.label || (kind === 'token' ? 'Fungible token' : 'Contract'), level: audit?.level || null, balance_near: toNear(state.amount), launchpad: tok?.launchpad || null, creator: tok?.creator || null,
      analysis: tok?.analysis?.summary || null, ai_summary: audit?.summary?.summary || null, risks_for_users: audit?.summary?.risks_for_users || [] },
    points, pending: auditing, actions: v === 'danger' ? [kind === 'token' ? 'Do not buy it. If you hold it, it may not be sellable: check before adding more.' : 'Do not approve, deposit or sign anything for this contract.'] : [],
    links: { explorer: nearblocks('address', id), audit: `/audit/${encodeURIComponent(id)}`, ...(kind === 'token' && tok ? { token: `/tokens/${encodeURIComponent(id)}` } : {}), ...(kind === 'nft_collection' ? { nft: `/nfts/${encodeURIComponent(id)}` } : {}) },
    from_site: extra?.from_site || null };
}

/** A wallet's safety: who can sign for it (keys and the apps they belong to), what is flagged around it, risky tokens it holds. */
async function inspectWallet(id, state) {
  const [keys, rep, holdings] = await Promise.all([viewAccessKeyList(id).catch(() => null), accountReputation(id).catch(() => null), fastnearGet(`/v1/account/${encodeURIComponent(id)}/ft`).catch(() => null)]);
  const points = [], actions = [];
  for (const f of rep?.flags || []) points.push(pt(LEVEL_OF[f.severity] || 'warn', /^(This account|A |Received|Funded)/.test(f.detail || '') ? f.detail : `This wallet: ${f.detail || f.reason}`));
  const look = lookalikeOf(id);
  if (look) points.push(pt('bad', `The name imitates ${look}, but it is an ordinary wallet: do not send anything meant for ${look} here.`));
  const full = (keys || []).filter((k) => k.access_key?.permission === 'FullAccess');
  const apps = (keys || []).filter((k) => k.access_key?.permission?.FunctionCall).map((k) => ({ key: k.public_key, ...k.access_key.permission.FunctionCall }));
  if (keys) {
    if (full.length === 0) points.push(pt('info', 'No full-access key: nobody can sign everything for it (a contract or a locked account).'));
    else if (full.length === 1) points.push(pt('good', 'One full-access key: only one device or wallet app can fully control it.'));
    else { points.push(pt('warn', `${full.length} full-access keys: ${full.length} different keys can move everything. Make sure you recognise each one (a phishing site that got you to "connect" may have added one).`)); actions.push('In your wallet, open the account\'s keys / connected devices and remove any full-access key you do not recognise.'); }
  }
  // app keys: grouped by the contract they may call
  const byApp = new Map();
  for (const k of apps) { const g = byApp.get(k.receiver_id) || []; g.push(k); byApp.set(k.receiver_id, g); }
  const appRows = [];
  if (byApp.size) {
    const reps = await Promise.all([...byApp.keys()].slice(0, 25).map((r) => accountReputation(r).catch(() => null)));
    const audits = await col('audits').find({ _id: { $in: [...byApp.keys()] } }, { projection: { 'auto.level': 1, 'auto.label': 1 } }).toArray();
    const lvl = new Map(audits.map((x) => [x._id, x.auto]));
    [...byApp.entries()].slice(0, 25).forEach(([r, ks], i) => {
      const rr = reps[i], look = lookalikeOf(r), bad = look || (rr?.flags || []).some((f) => f.severity === 'critical' || f.severity === 'high') || rr?.exists === false;
      appRows.push({ app: r, keys: ks.length, unlimited: ks.some((k) => k.allowance == null), status: bad ? 'bad' : TRUSTED.has(r) ? 'known' : lvl.get(r)?.level && ['critical', 'high'].includes(lvl.get(r).level) ? 'risky' : 'unknown', note: look ? `imitates ${look}` : (rr?.flags || [])[0]?.reason || (rr?.exists === false ? 'the app no longer exists' : lvl.get(r)?.label || '') });
    });
    const badApps = appRows.filter((x) => x.status === 'bad');
    if (badApps.length) { points.push(pt('bad', `Connected to ${badApps.map((x) => `${x.app} (${x.note})`).join(', ')}. That site can send transactions for you (paid from your NEAR, within the key's limit).`)); actions.push(`Remove the app keys for ${badApps.map((x) => x.app).join(', ')} in your wallet.`); }
    const risky = appRows.filter((x) => x.status === 'risky');
    if (risky.length) points.push(pt('warn', `Connected to contracts our audit rates high risk: ${risky.map((x) => x.app).join(', ')}.`));
    points.push(pt('info', `Logged in to ${byApp.size} app${byApp.size > 1 ? 's' : ''} (${apps.length} app key${apps.length > 1 ? 's' : ''}). App keys can only call their app, not move your tokens, but old ones are worth cleaning up.`));
  }
  // tokens held that the tracker knows went bad
  const held = (holdings?.tokens || []).filter((t) => t.balance && t.balance !== '0').map((t) => t.contract_id);
  if (held.length) {
    const toks = await col('tokens').find({ _id: { $in: held.slice(0, 300) } }, { projection: { symbol: 1, creator: 1, 'outcome.rugged': 1 } }).toArray();
    const black = new Set((await col('blacklist').find({ _id: { $in: toks.map((t) => t.creator).filter(Boolean) } }, { projection: { _id: 1 } }).toArray()).map((b) => b._id));
    const rugged = toks.filter((t) => t.outcome?.rugged), shady = toks.filter((t) => !t.outcome?.rugged && black.has(t.creator));
    if (rugged.length) points.push(pt('info', `Holds ${rugged.length} rugged token${rugged.length > 1 ? 's' : ''} (${rugged.slice(0, 6).map((t) => t.symbol || t._id).join(', ')}): probably worth little now.`));
    if (shady.length) points.push(pt('warn', `Holds ${shady.length} token${shady.length > 1 ? 's' : ''} made by blacklisted ruggers: ${shady.slice(0, 6).map((t) => t.symbol || t._id).join(', ')}.`));
    const lookToks = held.filter((h) => lookalikeOf(h)).slice(0, 5);
    if (lookToks.length) points.push(pt('warn', `Holds fake look-alike tokens (${lookToks.join(', ')}): they are often airdropped as bait. Do not try to sell or "claim" them on a site they point to.`));
  }
  const v = verdictOf(points);
  const flagged = (rep?.flags || []).some((f) => f.severity === 'critical');
  return { kind: 'wallet', verdict: v, account: id, headline: flagged ? 'Do not send anything to this account: it is flagged.' : v === 'danger' ? 'This wallet has a serious problem: act now.' : v === 'caution' ? ((rep?.flags || []).length ? 'Be careful: this account is linked to something reported.' : 'This wallet is fine, but check the points below.') : 'This wallet looks safe.',
    facts: { balance_near: toNear(state.amount), full_access_keys: keys ? full.length : null, app_keys: apps.length, apps: appRows, tokens_held: held.length, label: rep?.label || null },
    points, actions: flagged ? ['Do not send tokens or NEAR to it, buy what it sells, or approve anything it asks for.'] : actions.length ? actions : v === 'safe' ? [] : ['If this is your wallet, review the points above in it.'], links: { explorer: nearblocks('address', id), wallet: `/wallets/${encodeURIComponent(id)}` } };
}

// ------------------------------------------------------------------------------------------------ a token by name
async function inspectTokenSearch(q, extra = {}) {
  const sym = q.replace(/^\$/, '').trim();
  if (KNOWN_TOKENS[sym.toLowerCase()]) return inspectAccount(KNOWN_TOKENS[sym.toLowerCase()]);
  const rx = new RegExp(`^${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const found = await col('tokens').find({ $or: [{ symbol: rx }, { name: rx }] }, { projection: { symbol: 1, name: 1, live_ts: 1, launchpad: 1, 'outcome.rugged': 1 } }).sort({ live_ts: -1 }).limit(10).toArray();
  if (found.length === 1) return inspectAccount(found[0]._id);
  if (found.length > 1) {
    const r = await inspectAccount(found[0]._id);
    return { ...r, also: found.slice(1).map((t) => ({ account: t._id, symbol: t.symbol, launchpad: t.launchpad, live_ts: t.live_ts, rugged: !!t.outcome?.rugged })),
      points: [pt('warn', `${found.length} tokens use the name ${sym}. Showing the newest; copy the exact contract from the project's official site to be sure you have the real one.`), ...(r.points || [])] };
  }
  if (extra.or_account) return inspectAccount(extra.or_account);
  return { kind: 'unknown', verdict: 'unknown', headline: `No token called ${sym} is tracked.`, points: [pt('info', 'Paste the token\'s contract (for example blackdragon.tkn.near) or its NearBlocks link instead.')] };
}

// ------------------------------------------------------------------------------------------------ one NFT
async function inspectNft(contract, tokenId) {
  const base = await inspectAccount(contract);
  if (base.kind === 'missing' || tokenId == null) return base;
  const t = await viewFunction(contract, 'nft_token', { token_id: String(tokenId) }).catch(() => null);
  const points = [...(base.points || [])];
  if (!t) points.unshift(pt('warn', `NFT #${tokenId} does not exist in this collection (it was burned, or the link is wrong).`));
  return { ...base, kind: 'nft', headline: base.headline.replace('this NFT collection', `NFT #${tokenId}'s collection`), points,
    nft: t ? { token_id: t.token_id, owner: t.owner_id, title: t.metadata?.title || null, media: /^https?:|^ipfs:/.test(t.metadata?.media || '') ? t.metadata.media : null, approvals: Object.keys(t.approved_account_ids || {}) } : null,
    links: { ...base.links, explorer: nearblocks('nft-token', `${contract}/${tokenId}`).replace('%2F', '/') } };
}

// ------------------------------------------------------------------------------------------------ a public key
async function inspectPublicKey(pk) {
  const j = await fastnearGet(`/v0/public_key/${encodeURIComponent(pk)}`).catch(() => null);
  const ids = j?.account_ids || [];
  if (!ids.length) return { kind: 'public_key', verdict: 'unknown', headline: 'No account uses this key.', points: [pt('info', 'A public key is safe to share. This one is not on any account (or was removed).')] };
  const reps = await Promise.all(ids.slice(0, 10).map((id) => accountReputation(id).catch(() => null)));
  const points = [pt('info', `This key can sign for ${ids.length} account${ids.length > 1 ? 's' : ''}: ${ids.slice(0, 10).map(short).join(', ')}${ids.length > 10 ? ' …' : ''}.`)];
  reps.forEach((r) => { for (const f of r?.flags || []) points.push(pt(LEVEL_OF[f.severity] || 'warn', `${short(r.account)}: ${f.detail || f.reason}`)); });
  points.push(pt('info', 'If you did not add this key yourself, remove it from your wallet\'s keys.'));
  return { kind: 'public_key', verdict: verdictOf(points), headline: `This key is on ${ids.length} account${ids.length > 1 ? 's' : ''}.`, facts: { accounts: ids.slice(0, 50) }, points };
}

// ------------------------------------------------------------------------------------------------ a website (never fetched: judged by its name)
function siteLookalike(host) {
  const bare = host.replace(/^www\./, '');
  if (NEAR_SITES.some((k) => bare === k || bare.endsWith('.' + k))) return { known: true };
  const name = bare.split('.').slice(-2).join('.'), label = name.split('.')[0];
  const fold = (s) => s.replace(/[0o]/g, 'o').replace(/[1il|]/g, 'l').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[-_.]/g, '');
  for (const k of NEAR_SITES) {
    const kn = k.split('.').slice(-2).join('.'), kl = kn.split('.')[0], whole = fold(kn);
    if (name === kn) continue;
    for (const c of [fold(label), fold(bare)]) if (c === whole || (whole.length >= 7 && lev(c, whole) <= 2)) return { imitates: k };
    if (kl.length < 4) continue;
    if (fold(label) === fold(kl)) return { imitates: k };
    if (lev(fold(label), fold(kl)) <= (kl.length >= 7 ? 2 : 1)) return { imitates: k };
    if (kl.length >= 5 && label.includes(kl) && label !== kl) return { imitates: k };
  }
  return { known: false };
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
async function inspectWebsite(host, extra = {}) {
  const points = [];
  const s = siteLookalike(host);
  if (/(^|\.)xn--/.test(host)) points.push(pt('bad', 'The address uses look-alike letters from other alphabets (punycode): a classic phishing trick.'));
  if (s.imitates) points.push(pt('bad', `The address imitates ${s.imitates}, but it is a different site.`));
  const lure = LURE.test(host) || LURE.test(extra.path || ''), nearName = /near/.test(host) && !s.known;
  if (lure) points.push(pt(s.known ? 'info' : nearName || s.imitates ? 'bad' : 'warn', 'Words like "claim", "airdrop", "verify" or "sync wallet" are what drainer sites use to get you to sign.'));
  if (nearName && !s.imitates) points.push(pt('warn', 'It uses the NEAR name but is not a site we know.'));
  if (extra.https === false) points.push(pt('warn', 'It is not https: what you send to it can be read or changed on the way.'));
  const flag = await col('firewall_flags').findOne({ _id: host }).catch(() => null);
  if (flag) points.push(pt(LEVEL_OF[flag.severity] || 'bad', `Reported: ${flag.reason}`));
  if (s.known && !points.some((x) => x.level === 'bad')) points.unshift(pt('good', 'A well-known NEAR site.'));
  if (!s.known && !points.length) points.push(pt('info', 'We do not know this site. That is not proof it is bad, but be careful.'));
  const v = s.known && !points.some((x) => x.level === 'bad') ? 'safe' : verdictOf(points, 'unknown');
  return { kind: 'website', verdict: v, headline: v === 'danger' ? `Do not use ${host}: it looks like a phishing site.` : v === 'safe' ? `${host} is a known NEAR site.` : v === 'caution' ? `Be careful with ${host}.` : `${host} is not a site we know.`,
    points, actions: ['Never type your seed phrase or private key into a website.', 'Before you sign, paste what your wallet shows into this box: it checks the transaction itself.'].slice(0, v === 'safe' ? 1 : 2), facts: { host } };
}

/**
 * An address on another chain (WP-14): what Safe Near knows from the NEAR cases whose money was sent to it. Never "safe": no case only means nothing is known;
 * danger only when a confirmed case sent money there. The money is not followed on the other chain.
 */
async function inspectChainAddress(id) {
  const c = parseChainId(id), { relationsOf } = await import('../ontology/index.js');
  const rel = (await relationsOf(id, { predicate: 'role_in', direction: 'out' })).filter((f) => !f.valid_to || f.valid_to > Date.now());
  const ids = [...new Set(rel.map((f) => f.object))], cases = ids.length ? await col('incidents').find({ _id: { $in: ids } }, { projection: INC_FIELDS }).toArray() : [];
  const confirmed = cases.filter((d) => d.status === 'confirmed');
  const sent = (await relationsOf(id, { predicate: 'sent_to', direction: 'in' })).reduce((s, f) => s + (f.amount_usd || 0), 0);
  const where = `${c?.name || 'another chain'} address ${short(c?.address || id, 20)}`;
  if (!cases.length) return { kind: 'chain_address', account: id, verdict: 'unknown', headline: `Nothing known about this ${where}.`, points: [pt('info', 'Safe Near has not seen money from a hack it traced go to it. That does not make it safe: it only follows money on NEAR.')] };
  return { kind: 'chain_address', account: id, verdict: confirmed.length ? 'danger' : 'caution',
    headline: `This ${where} received about $${Math.round(sent).toLocaleString('en-US')} from ${confirmed.length ? 'a confirmed hack' : 'a case being watched'} traced on NEAR.`,
    points: [pt(confirmed.length ? 'bad' : 'warn', `Money from ${cases.length} NEAR case${cases.length === 1 ? '' : 's'} was swapped out to it (see the case${cases.length === 1 ? '' : 's'}). Safe Near does not follow the money on ${c?.name || 'that chain'}.`)],
    incidents: cases.map((d) => incRow(d, 'cash_out_address')) };
}
