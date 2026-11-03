// The incident in a Telegram chat: /hack <wallet | tx | link> answers with what Safe Near knows about it (the summary, where the money came
// from and went, what is still held, the attacker's wallets) and attaches the evidence pack to forward to whoever can act; /hacks lists the
// latest. Everything here is what the public investigation page already shows.
import { col } from '../db.js';
import { config } from '../config.js';
import { parseInvestigation } from './service.js';
import { evidencePack } from './pack.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const usd = (x) => (x == null ? '?' : '$' + Math.round(x).toLocaleString('en-US'));
const amt = (x) => (x == null ? '?' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const day = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '?');
const short = (a, n = 14) => (a && a.length > n + 4 ? `${a.slice(0, n)}…` : a || '?');
const KIND = { exchange_drain: 'Exchange hot-wallet drain', protocol_exploit: 'Protocol exploit', wallet_drainer: 'Wallet drainer', suspicious_transfers: 'Suspicious transfers' };
const ROLE = { attacker: 'the attacker', cash_out_wallet: 'a payout wallet the stolen money went through', sub_account: "a sub-account of the attacker", intents_account: "the attacker's NEAR Intents account", fake_token: 'a fake token the attacker made', funder: 'the account that funded the attacker', target: 'the contract that was hit', attack_tx: 'one of the attack transactions', source: 'where the money was taken from' };

/** The confirmed incident a pasted wallet / transaction / link / incident id belongs to, with the role it plays in it. Unconfirmed cases are
 * never shown as hacks (a suspicion is not an accusation): { checked: true } says it was looked at and nothing was confirmed. */
export async function findIncident(q) {
  const s = String(q || '').trim();
  if (/^inc:/.test(s)) { const d = await col('incidents').findOne({ _id: s }); return !d ? null : d.status === 'confirmed' ? { inc: d, role: null } : { checked: true }; } // a watched case is not a hack
  let input; try { input = parseInvestigation(s); } catch { return null; }
  const or = input.tx ? [{ 'attack_txs.tx': input.tx }] : input.account ? [{ 'accounts.account': input.account }, { 'target.account': input.account }, { 'sources.account': input.account }] : [{ 'target.account': input.target }];
  const docs = await col('incidents').find({ $or: or }).sort({ stolen_usd: -1 }).limit(5).toArray();
  const inc = docs.find((d) => d.status === 'confirmed');
  if (!inc) return docs.length ? { checked: true } : null;
  const id = input.account || input.target;
  const role = input.tx ? 'attack_tx' : (inc.sources || []).some((x) => x.account === id && x.kind === 'exchange') || (inc.kind === 'exchange_drain' && inc.target?.account === id) ? 'source'
    : inc.target?.account === id ? 'target' : inc.accounts?.find((a) => a.account === id)?.role || null;
  return { inc, role, id: id || input.tx };
}

/** The chat answer for one incident (Telegram HTML, under 4,000 characters). */
export async function incidentMessage(inc, { role = null, id = null } = {}) {
  const T = inc.trail || {}, exits = Object.entries(T.exit_usd || {});
  const moves = await col('incident_moves').find({ incident: inc._id }).sort({ ts: -1 }).limit(3).toArray().catch(() => []);
  const site = config.alerts.siteUrl;
  const L = [];
  L.push(`🚨 <b>${esc(KIND[inc.kind] || 'Incident')}${inc.drain?.exchange ? ` from ${esc(inc.drain.exchange)}` : inc.target?.account && inc.kind !== 'exchange_drain' ? ` on ${esc(inc.target.account)}` : ''}</b>${inc.status !== 'confirmed' ? ` <i>(${esc(inc.status)})</i>` : ''}`);
  if (id && role) L.push(`<code>${esc(short(id, 24))}</code> is ${esc(ROLE[role] || role)} in this case.`);
  if (inc.ai?.headline) L.push('', esc(inc.ai.headline));
  L.push('', `💰 <b>Taken:</b> ${usd(inc.stolen_usd)}${inc.started_ts ? ` · from ${day(inc.started_ts)}` : ''}`);
  const src = (inc.sources || []).filter((x) => x.kind === 'exchange');
  if (src.length) L.push(`⬅️ <b>Came from:</b> ${src.length} ${esc(src[0].name)}${src.length > 1 ? 's' : ''} (${esc(src[0].how)})`);
  else if (inc.target?.account) L.push(`🎯 <b>Target:</b> <code>${esc(inc.target.account)}</code>`);
  L.push(`👤 <b>Attacker's main wallet:</b> <code>${esc(inc.attacker?.account)}</code>`);
  if (exits.length) L.push(`➡️ <b>Left NEAR:</b> ${exits.map(([k, v]) => `${esc(k)} ${usd(v)}`).join(', ')}`);
  const offChain = new Map(); for (const e of T.exits || []) if (e.recipient && e.chain && e.chain !== 'NEAR') offChain.set(`${e.chain}|${e.recipient}`, { chain: e.chain, to: e.recipient, usd: (offChain.get(`${e.chain}|${e.recipient}`)?.usd || 0) + (e.usd || 0) });
  for (const x of [...offChain.values()].sort((a, b) => b.usd - a.usd).slice(0, 4)) L.push(`   • ${esc(x.chain)} <code>${esc(x.to)}</code> ${usd(x.usd)}`);
  L.push(`🏦 <b>Still on NEAR:</b> ${usd(inc.held_usd)}`);
  const wallets = (inc.held || []).filter((h) => (inc.accounts || []).some((a) => a.account === h.account && a.role !== 'funder')).sort((a, b) => b.usd - a.usd).slice(0, 6);
  for (const h of wallets) L.push(`   • <code>${esc(h.account)}</code> ${h.tokens.slice(0, 2).map((t) => `${amt(t.amount)} ${esc(t.symbol)}`).join(', ')} (${usd(h.usd)})`);
  const n = (inc.accounts || []).filter((a) => ['attacker', 'cash_out_wallet', 'sub_account', 'intents_account'].includes(a.role)).length;
  if (n > wallets.length) L.push(`   … ${n} attacker wallets in all (in the evidence file)`);
  if (moves.length) L.push('', `⚡ <b>Latest move:</b> ${amt(moves[0].amount)} ${esc(moves[0].symbol)} (${usd(moves[0].usd)}) from <code>${esc(short(moves[0].from, 16))}</code>, ${day(moves[0].ts)}`);
  else L.push('', '👀 Every attacker wallet is watched: the next move is reported at once.');
  if (site) L.push('', `<a href="${esc(`${site}/firewall/${encodeURIComponent(inc._id)}`)}">Full investigation</a>`);
  L.push('', '📎 The evidence file below is ready to forward to whoever can act: the victim, SEAL 911 (@seal_911_bot), NEAR Intents / 1Click, bridges, exchanges.');
  return L.join('\n').slice(0, 3900);
}

/** The evidence file: { name, text }. */
export const evidenceFile = (inc) => ({ name: `safe-near-${inc._id.replace(/^inc:/, '').slice(0, 16)}-evidence.md`, text: evidencePack(inc) });

/** /hacks: the latest confirmed incidents. */
export async function latestMessage(limit = 6) {
  const rows = await col('incidents').find({ status: 'confirmed' }, { projection: { kind: 1, 'attacker.account': 1, 'target.account': 1, drain: 1, stolen_usd: 1, held_usd: 1, started_ts: 1, first_seen_ts: 1 } }).sort({ started_ts: -1, first_seen_ts: -1 }).limit(limit).toArray();
  if (!rows.length) return 'No hack confirmed yet.';
  return `<b>Latest hacks on NEAR</b>\n\n${rows.map((r) => `🚨 <b>${esc(KIND[r.kind] || r.kind)}</b>${r.drain?.exchange ? ` from ${esc(r.drain.exchange)}` : r.target?.account ? ` on ${esc(short(r.target.account, 24))}` : ''}\n${usd(r.stolen_usd)} taken · ${usd(r.held_usd)} still on NEAR · ${day(r.started_ts || r.first_seen_ts)}\n/hack ${esc(r.attacker?.account)}`).join('\n\n')}\n\nSend /hack &lt;wallet or transaction&gt; for the details and the evidence file.`;
}
