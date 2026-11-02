// The response to an incident: what people do outside the system, kept next to the evidence (the "Response" panel of an investigation).
//   checklist    the facts to confirm before telling anyone, each ticked by a named operator
//   visibility   private (only operators see it; its flags are held back from the firewall, Safety Check and the blocklist feed; its alerts go
//                only to the ops group) or public. A case the tracer confirms starts private: a person signs off before anything is public
//   contacts     who was told (Binance, SEAL 911, 1Click, a bridge, exchanges), by whom, how, and what they answered
//   owner        the operator on call: pinged in the ops group when the money moves
//   outcome      open, funds frozen, swaps refused, victim confirmed, closed, or a false alarm (which removes the flags and retracts the alerts)
// Operators sign in with a key from OPERATOR_KEYS ("name:key,…"); with no keys set, a local (not hosted) server treats everyone as operator.
import { col } from '../db.js';
import { config } from '../config.js';
import { info } from '../log.js';

// ---- operators
const keys = () => new Map((config.web.operatorKeys || []).map((s) => { const i = s.indexOf(':'); return i > 0 ? [s.slice(i + 1), s.slice(0, i)] : [s, 'operator']; }));
/** The operator a request comes from (x-operator-key), or null. */
export function operatorOf(req) {
  const k = req?.headers?.['x-operator-key'];
  if (k && keys().has(String(k))) return keys().get(String(k));
  if (!keys().size && !config.web.hosted) return 'local';
  return null;
}

// ---- which incidents are private (cached: every public read checks it)
let priv = { ts: 0, set: new Set() };
export async function privateIncidents() {
  if (Date.now() - priv.ts < 15e3) return priv.set;
  const rows = await col('incident_cases').find({ visibility: 'private' }, { projection: { _id: 1 } }).toArray().catch(() => []);
  priv = { ts: Date.now(), set: new Set(rows.map((r) => r._id)) };
  return priv.set;
}
export const isPrivate = async (id) => (await privateIncidents()).has(id);

const CHECKS = {
  exchange_drain: [['source', "The source wallets are the exchange's (e.g. each one sends its reserves to the exchange's cold wallet, checked on NearBlocks)"], ['root', 'The root wallet was created by the drain and still holds what the page says'],
    ['trail', 'The payout wallets and the cross-chain recipients (BTC / ETH addresses, destination transactions) are checked'], ['not_legit', 'Ruled out a legitimate move (an exchange migrating to a new wallet, its own reshuffle)']],
  protocol_exploit: [['target', 'The target contract and the attack transactions are checked'], ['mechanism', 'The attack mechanism makes sense (fake tokens, missing check …)'],
    ['trail', 'The cash-out wallets and cross-chain recipients are checked'], ['not_legit', 'Ruled out a legitimate move (a withdrawal of its own deposit, an upgrade, a migration)']],
  wallet_drainer: [['victims', 'The emptied wallets did not move their own funds (a shared key, an approval, a new account)'], ['trail', 'The cash-out wallets and cross-chain recipients are checked'],
    ['not_legit', 'Ruled out a fund or an OTC desk consolidating its own wallets']],
};
export const PARTIES = ['Victim (e.g. Binance security)', 'SEAL 911', 'NEAR Intents / 1Click', 'Omni Bridge', 'Exchange', 'Chain analytics', 'NEAR Foundation', 'Law enforcement (through the victim)', 'Other'];
export const OUTCOMES = { open: 'Open', frozen: 'Funds frozen', refused: 'Swaps refused', victim_confirmed: 'Victim confirmed', closed: 'Closed', false_alarm: 'False alarm' };

/** A case, or the default one: existing (pre-panel) incidents are public, as they already were. */
export async function getCase(id, inc = null) {
  const c = await col('incident_cases').findOne({ _id: id });
  const kind = inc?.kind || c?.kind || 'protocol_exploit';
  const list = CHECKS[kind] || CHECKS.protocol_exploit;
  const base = c || { _id: id, visibility: 'public', legacy: true, checklist: {}, contacts: [], owner: null, outcome: { status: 'open' }, history: [] };
  return { ...base, kind, checks: list.map(([key, label]) => ({ key, label, ...(base.checklist?.[key] || {}) })), parties: PARTIES, outcomes: OUTCOMES };
}

/** A confirmed incident gets a private case the first time (nothing public until an operator signs off). Returns true when it is private. */
export async function openCase(inc) {
  const r = await col('incident_cases').updateOne({ _id: inc._id }, { $setOnInsert: { _id: inc._id, kind: inc.kind, visibility: 'private', checklist: {}, contacts: [], owner: null, outcome: { status: 'open' }, created_ts: Date.now(),
    history: [{ ts: Date.now(), by: 'system', what: 'case opened (private until an operator makes it public)' }] } }, { upsert: true });
  if (r.upsertedCount) { priv.ts = 0; info(`case ${inc._id}: opened, private`); }
  return isPrivate(inc._id);
}

/** Hold a case's flags back (private) or let them act (public). */
async function setFlagsPrivate(id, on) {
  await col('firewall_flags').updateMany({ source: 'incident', incident: id }, on ? { $set: { private: true } } : { $unset: { private: 1 } });
}

/** One operator action. Returns the updated case or { error }. */
export async function caseAction(id, a, by) {
  const inc = await col('incidents').findOne({ _id: id }, { projection: { kind: 1, status: 1 } });
  if (!inc) return { error: 'no such incident' };
  const now = Date.now(), log = (what) => ({ ts: now, by, what: String(what).slice(0, 300) });
  const str = (x, n = 300) => String(x ?? '').trim().slice(0, n);
  await col('incident_cases').updateOne({ _id: id }, { $setOnInsert: { _id: id, kind: inc.kind, visibility: 'public', checklist: {}, contacts: [], owner: null, outcome: { status: 'open' }, created_ts: now, history: [] } }, { upsert: true });
  let set = {}, push = null, what;
  switch (a.type) {
    case 'check': set[`checklist.${str(a.key, 40)}`] = { done: true, by, ts: now, note: str(a.note) }; what = `checked: ${a.key}`; break;
    case 'uncheck': set[`checklist.${str(a.key, 40)}`] = { done: false, by, ts: now }; what = `unchecked: ${a.key}`; break;
    case 'visibility': {
      const v = a.value === 'private' ? 'private' : 'public';
      if (v === 'public') {
        const c = await getCase(id, inc);
        if (c.checks.some((x) => !x.done) && !a.force) return { error: 'tick every check first (or confirm to publish anyway)' };
      }
      set.visibility = v; what = v === 'public' ? 'made public: flags now protect users, alerts can go out publicly' : 'made private: flags held back';
      await setFlagsPrivate(id, v === 'private'); priv.ts = 0; break;
    }
    case 'owner': set.owner = str(a.value, 60) || null; what = set.owner ? `on call: ${set.owner}` : 'no one on call'; break;
    case 'contact_add': {
      const c = { id: `c${now.toString(36)}`, party: str(a.party, 80), channel: str(a.channel, 120), by, ts: now, status: 'sent', note: str(a.note, 600), reply: '' };
      if (!c.party) return { error: 'who was contacted?' };
      push = { contacts: c }; what = `contacted ${c.party}${c.channel ? ` via ${c.channel}` : ''}`; break;
    }
    case 'contact_update': {
      const status = ['sent', 'replied', 'no_reply', 'acting'].includes(a.status) ? a.status : 'replied';
      const r = await col('incident_cases').updateOne({ _id: id, 'contacts.id': str(a.contact, 40) }, { $set: { 'contacts.$.status': status, 'contacts.$.reply': str(a.reply, 1000), 'contacts.$.reply_ts': now, 'contacts.$.reply_by': by } });
      if (!r.matchedCount) return { error: 'no such contact' };
      what = `contact update: ${status}${a.reply ? ` (${str(a.reply, 80)})` : ''}`; break;
    }
    case 'note': if (!str(a.note)) return { error: 'empty note' }; what = `note: ${str(a.note, 280)}`; break;
    case 'outcome': {
      const status = OUTCOMES[a.status] ? a.status : 'open';
      set.outcome = { status, note: str(a.note, 600), by, ts: now }; what = `outcome: ${OUTCOMES[status]}${a.note ? ` (${str(a.note, 80)})` : ''}`;
      if (status === 'false_alarm') {
        // not a crime: the flags go, the alerts say so, and the incident stops being confirmed
        const r = await col('firewall_flags').deleteMany({ source: 'incident', incident: id });
        await col('alerts').updateMany({ $or: [{ _id: `incident:${id}` }, { 'data.incident': id }], title: { $not: /^Retracted/ } }, [{ $set: { title: { $concat: ['Retracted (false alarm): ', '$title'] }, severity: 'info' } }]).catch(() => {});
        await col('incidents').updateOne({ _id: id }, { $set: { status: 'dismissed', dismissed: { by, ts: now, note: str(a.note, 300) } } });
        what += `; ${r.deletedCount} flags removed, alerts retracted`;
      }
      break;
    }
    default: return { error: 'unknown action' };
  }
  const upd = { $push: { history: { $each: [log(what)], $slice: -300 } } };
  if (Object.keys(set).length) upd.$set = set;
  if (push) upd.$push = { ...upd.$push, ...Object.fromEntries(Object.entries(push).map(([k, v]) => [k, v])) };
  await col('incident_cases').updateOne({ _id: id }, upd);
  info(`case ${id}: ${by}: ${what}`);
  return getCase(id, inc);
}

// ---- the evidence pack: the same short brief for every party, always from the latest trace
const usd = (x) => (x == null ? '?' : '$' + Math.round(x).toLocaleString('en-US'));
const amt = (x) => (x == null ? '?' : Number(x).toLocaleString('en-US', { maximumFractionDigits: 4 }));
const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '?');
/** Markdown brief of an incident for the people who can act. */
export function evidencePack(inc, { siteUrl = config.alerts.siteUrl, held = true } = {}) {
  const T = inc.trail || {}, src = (inc.sources || []).filter((s) => s.kind === 'exchange');
  const lines = [];
  lines.push(`# ${inc.kind === 'exchange_drain' ? `Exchange hot-wallet drain${inc.drain?.exchange ? ` (${inc.drain.exchange})` : ''}` : inc.kind === 'protocol_exploit' ? `Exploit of ${inc.target?.account || 'a contract'}` : 'Incident'} on NEAR`);
  lines.push('', `Prepared by Safe Near from executed on-chain transactions. USD at today's prices. Investigation: ${siteUrl ? `${siteUrl}/firewall/${encodeURIComponent(inc._id)}` : inc._id}`, '');
  if (inc.ai?.headline) lines.push(`**Summary.** ${inc.ai.headline}`, '');
  lines.push(`- **Taken:** ${usd(inc.stolen_usd)}${inc.started_ts ? `, starting ${when(inc.started_ts)}` : ''}`);
  lines.push(`- **Attacker's main wallet:** \`${inc.attacker?.account}\`${inc.attacker?.created_ts ? ` (created ${when(inc.attacker.created_ts)})` : ''}`);
  if (held) lines.push(`- **Still on NEAR:** ${usd(inc.held_usd)} across the attacker's wallets (see "Still held")`);
  if (src.length) {
    lines.push('', '## Where the money came from');
    for (const s of src) lines.push(`- \`${s.account}\`: ${s.name} (${s.how}) sent ${s.tokens.map((t) => `${amt(t.amount)} ${t.symbol}`).join(', ')} (${usd(s.usd)}) to \`${s.to}\` at ${when(s.first_ts)}; tx ${(s.txs || []).slice(0, 2).map((h) => `\`${h}\``).join(', ')}`);
  } else if (inc.target) {
    lines.push('', '## Target', `- \`${inc.target.account}\` lost ${usd(inc.target.lost_usd)}: ${(inc.target.tokens || []).map((t) => `${amt(t.amount)} ${t.symbol}`).join(', ')}`);
    for (const t of (inc.attack_txs || []).slice(0, 5)) lines.push(`- attack tx \`${t.tx}\` at ${when(t.ts)}: ${t.methods.join(', ')} on ${t.receiver}`);
  }
  const wallets = (inc.accounts || []).filter((a) => ['attacker', 'cash_out_wallet', 'sub_account', 'intents_account'].includes(a.role));
  lines.push('', '## Attacker wallets on NEAR (please refuse swaps, deposits and bridging from these)');
  for (const a of wallets) { const h = (inc.held || []).find((x) => x.account === a.account); lines.push(`- \`${a.account}\` (${a.role.replace(/_/g, ' ')})${h ? `: holds ${h.tokens.map((t) => `${amt(t.amount)} ${t.symbol}`).join(', ')} (${usd(h.usd)})` : ''}`); }
  const xs = (T.exits || []).filter((e) => e.recipient || e.chain);
  if (xs.length) {
    lines.push('', '## Where it went off NEAR');
    const byRecipient = new Map();
    for (const e of xs) { const k = `${e.chain || '?'}|${e.recipient || e.to}`; const x = byRecipient.get(k) || { chain: e.chain, recipient: e.recipient || e.to, usd: 0, out: [], txs: [] }; x.usd += e.usd || 0; if (e.amount_out) x.out.push(`${amt(Number(e.amount_out))} ${e.asset || ''}`.trim()); x.txs.push(...(e.dest_txs || [])); byRecipient.set(k, x); }
    for (const x of byRecipient.values()) lines.push(`- ${x.chain || '?'} \`${x.recipient}\`: ${usd(x.usd)}${x.out.length ? ` (received ${x.out.join(' + ')})` : ''}${x.txs.length ? `; destination tx ${x.txs.slice(0, 4).map((h) => `\`${h}\``).join(', ')}` : ''}`);
  }
  const bridge = (T.exits || []).filter((e) => e.kind === 'bridge' || /bridge/i.test(e.to || ''));
  if (bridge.length) lines.push('', '## Bridged', ...bridge.slice(0, 10).map((e) => `- ${amt(e.amount)} ${e.symbol} (${usd(e.usd)}) via \`${e.to}\`, tx \`${e.tx}\``));
  lines.push('', '## How the source was identified', inc.kind === 'exchange_drain'
    ? 'The source wallets have no NEAR name. They are identified as the exchange\'s hot wallets because each one sends its reserves to the exchange\'s named cold wallet, and each sent most or all of its balance, far above its usual withdrawals, to a wallet created by that very transfer.'
    : (inc.signals || []).map((s) => `- ${s}`).join('\n'));
  lines.push('', `Live: every attacker wallet above is watched block by block; any new move is reported at once. Contact: reply to the sender of this brief.`);
  return lines.join('\n');
}
export { CHECKS };
