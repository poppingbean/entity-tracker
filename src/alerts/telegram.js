// The Telegram bot: anyone can keep a watchlist from a chat (private or group) and get its alerts there. Long polling (getUpdates), so
// no public endpoint is needed. Commands: /safe (or a pasted address in a private chat), /whatis, /audit, /watch, /unwatch, /list, /alerts,
// /check, /hack, /hacks, /report, /gatepass, /help. The answers come from the same code as the website and the API: Safety Check (inspect),
// the ontology (entityView), the contract audit (contractReport), the incident store.
import { config } from '../config.js';
import { metaGet, metaSet } from '../db.js';
import { warn } from '../log.js';
import { resolveTarget, findWatched, setWatch, getWatchlist, alertsFor, setGatePass, KINDS, MAX_ITEMS } from './watch.js';
import { sendTelegram, sendTelegramDocument, alertMessage, tg } from './deliver.js';
import { findIncident, incidentMessage, evidenceFile, latestMessage } from '../incident/botinfo.js';
import { getAnalysis } from '../analysis/token.js';
import { getNftAnalysis } from '../nft/analysis.js';
import { report } from '../incident/signals.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const HELP = `<b>Safe Near</b>: is it safe, and is it part of a hack?
/safe &lt;anything&gt; – is it safe? A wallet, token (or its name), contract, NFT, transaction hash, link or website. In a private chat you can also just paste it
/whatis &lt;account&gt; – what Safe Near calls an account (a person, an exchange, a NEAR Intents solver, a contract …) and why
/audit &lt;contract&gt; – the contract audit: what it is, the powers its code gives someone, who holds them
/watch &lt;token symbol or contract | wallet | group | creator | NFT collection&gt; – get alerts about it here (e.g. /watch THREE)
/unwatch &lt;id&gt; – stop
/list – what this chat watches
/alerts – the latest alerts for this chat's watchlist
/check &lt;token | NFT collection&gt; – its current risk notes
/hack &lt;wallet | transaction | link&gt; – is it part of a hack? Where the money came from and went, what is still held, and an evidence file to forward
/hacks – the latest hacks on NEAR
/report &lt;account | transaction hash&gt; [what happened] – report a hack, drainer or stolen funds: it is investigated from the chain
/gatepass off|on – every chat that tracks something gets a report each time a new launch passes every hard gate of the scanner; turn it off or on
Kinds are detected from the id (c_… is a group); force one with e.g. <code>/watch alice.near creator</code>. Up to ${MAX_ITEMS} items per chat.`;

// the "/" menu Telegram shows (registered once per process)
export const COMMANDS = [
  ['safe', 'Is it safe? A wallet, token, contract, transaction or link'], ['hack', 'Is it part of a hack? With an evidence file'], ['hacks', 'The latest hacks on NEAR'],
  ['whatis', 'What is this account? (exchange, solver, person …)'], ['audit', 'The contract audit of a contract'], ['check', 'Risk notes of a tracked token or NFT collection'],
  ['watch', 'Get alerts about a token, wallet, group, creator or NFT'], ['unwatch', 'Stop watching something'], ['list', 'What this chat watches'], ['alerts', 'The latest alerts for this chat'],
  ['report', 'Report a hack, drainer or stolen funds'], ['gatepass', 'Gate-pass reports on or off'], ['help', 'All commands'],
];
const KNOWN_CMDS = new Set(COMMANDS.map(([c]) => `/${c}`).concat('/start'));
// something worth a Safety Check when pasted without a command: an account, a transaction hash, an explorer link, a URL
const LOOKS_CHECKABLE = /^(https?:\/\/\S+|[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(near|tg)|[0-9a-f]{64}|0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{43,44})$/;
const LEVEL_ICON = { bad: '🔴', warn: '🟠', info: '⚪', good: '🟢' };
const VERDICT_ICON = { danger: '🔴', caution: '🟠', careful: '🟠', safe: '🟢', unknown: '⚪' };
const site = (path) => (config.alerts.siteUrl ? `${config.alerts.siteUrl}${path}` : null);

/** A Safety Check answer for a chat (Telegram HTML, under 4,000 characters). */
export function safeMessage(q, r) {
  const pts = (r.points || []).filter((p) => p.level !== 'info').slice(0, 6), info = (r.points || []).filter((p) => p.level === 'info').slice(0, 2);
  const url = site(`/firewall?q=${encodeURIComponent(q)}`);
  return [`${VERDICT_ICON[r.verdict] || '⚪'} <b>${esc(String(r.verdict || 'unknown').toUpperCase())}</b>: ${esc(String(r.headline || '').slice(0, 400))}`,
    ...[...pts, ...info].map((p) => `${LEVEL_ICON[p.level] || '•'} ${esc(String(p.text || '').slice(0, 300))}`),
    ...((r.actions || []).slice(0, 2).map((a) => `👉 ${esc(String(a).slice(0, 300))}`)),
    url ? `<a href="${esc(url)}">Full answer on Safety Check</a>` : null].filter(Boolean).join('\n').slice(0, 3900);
}

/** What Safe Near calls an account, for a chat. */
export function whatIsMessage(r) {
  const extra = [r.operator && `operated by ${String(r.operator).replace(/^org:/, '')}`, r.pass_through && 'passes money through (an endpoint, not an owner)',
    r.flagged && `flagged ${r.flagged.severity}${r.flagged.reason ? `: ${r.flagged.reason}` : ''}`, ...(r.cases || []).slice(0, 3).map((c) => `${String(c.role || 'involved').replace(/_/g, ' ')} in ${c.case}`)].filter(Boolean);
  const url = site(`/wallets/${encodeURIComponent(r.account)}`);
  return [`<code>${esc(r.account)}</code> is <b>${esc(r.is || 'unknown')}</b>${r.label ? ` (${esc(r.label)})` : ''}`, r.why ? `Why: ${esc(String(r.why).slice(0, 500))}` : null,
    ...extra.map((x) => `• ${esc(x)}`), url ? `<a href="${esc(url)}">More</a>` : null].filter(Boolean).join('\n');
}

/** A contract audit, for a chat. */
export function auditMessage(id, r) {
  if (!r || (r.status && r.status !== 'ok')) return `No audit yet for <code>${esc(id)}</code>${r?.status ? ` (${esc(r.status)})` : ''}. It has been queued: try again in a few minutes. Until then, treat it as unknown.`;
  const f = (r.findings || []).filter((x) => x.severity !== 'info').slice(0, 6);
  const url = site(`/audit/${encodeURIComponent(id)}`);
  return [`<b>${esc(String(r.level || 'unknown').toUpperCase())}</b>: ${esc(r.type?.label || r.type?.role || 'contract')} <code>${esc(id)}</code>`, r.control?.summary ? `Control: ${esc(r.control.summary)}` : null,
    r.summary?.headline ? esc(String(r.summary.headline).slice(0, 400)) : null, ...f.map((x) => `${x.severity === 'critical' || x.severity === 'high' ? '🔴' : '🟠'} ${esc(String(x.title).slice(0, 200))}`),
    url ? `<a href="${esc(url)}">Full audit</a>` : null].filter(Boolean).join('\n').slice(0, 3900);
}

/** Who a command is for: ours, another bot's (ignored in a group), or nobody named. Pure. */
export function commandFor(text, me = config.alerts.telegramBot) {
  const m = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?/i.exec(String(text || '').trim());
  if (!m) return null;
  return { cmd: `/${m[1].toLowerCase()}`, ours: !m[2] || m[2].toLowerCase() === String(me || '').toLowerCase() };
}

const hits = new Map(); // chat -> [ts] (30 commands / 10 min)
const limited = (chat) => { const now = Date.now(), l = (hits.get(chat) || []).filter((t) => now - t < 600e3); l.push(now); hits.set(chat, l); return l.length > 30; };

async function handle(msg) {
  const chat = msg.chat?.id, text = (msg.text || '').trim(), priv = msg.chat?.type === 'private';
  if (!chat || !text) return;
  // a private chat can paste an address, a transaction or a link with no command: it gets the Safety Check
  if (!text.startsWith('/')) {
    if (!priv || !LOOKS_CHECKABLE.test(text)) return;
    if (limited(chat)) return sendTelegram(chat, 'Too many requests, try again in a few minutes.');
    return safeReply(chat, text);
  }
  const who = commandFor(text);
  if (!who?.ours) return; // a command for another bot in the same group
  const [, arg, hint] = text.split(/\s+/);
  const cmd = who.cmd, owner = `tg_${chat}`;
  if (!KNOWN_CMDS.has(cmd)) return priv || /@/.test(text.split(/\s+/)[0]) ? sendTelegram(chat, `I don't know <code>${esc(cmd.slice(0, 32))}</code>. Send /help for the commands, or just paste an address to check it.`) : undefined;
  if (limited(chat)) return sendTelegram(chat, 'Too many commands, try again in a few minutes.');
  if (cmd === '/start' || cmd === '/help') return sendTelegram(chat, HELP);
  if (cmd === '/safe') return arg ? safeReply(chat, text.split(/\s+/).slice(1).join(' ')) : sendTelegram(chat, 'Usage: /safe &lt;wallet | token | contract | transaction | link&gt;');
  if (cmd === '/whatis') {
    if (!arg) return sendTelegram(chat, 'Usage: /whatis &lt;account&gt;');
    const { entityView } = await import('../ontology/index.js');
    return sendTelegram(chat, whatIsMessage(await entityView(arg.trim().toLowerCase())));
  }
  if (cmd === '/audit') {
    if (!arg) return sendTelegram(chat, 'Usage: /audit &lt;contract account&gt;');
    const id = arg.trim().toLowerCase(), { contractReport } = await import('../audit/report.js');
    return sendTelegram(chat, auditMessage(id, await contractReport(id, { start: true }).catch(() => null)));
  }
  if (cmd === '/list') {
    const w = await getWatchlist(owner);
    return sendTelegram(chat, w.items.length ? `<b>Watching ${w.items.length}</b>\n${w.items.map((x) => `• ${x.kind}: <code>${esc(x.id)}</code>`).join('\n')}` : 'This chat watches nothing yet. Try /watch &lt;id&gt;.');
  }
  if (cmd === '/gatepass') {
    if (!config.alerts.gatePass) return sendTelegram(chat, 'Gate-pass reports are turned off on this server.');
    const want = (arg || '').toLowerCase();
    const w = await getWatchlist(owner), registered = !!w.created_ts;
    if (want !== 'on' && want !== 'off') return sendTelegram(chat, registered ? `Gate-pass reports are <b>${w.gate_pass === false ? 'off' : 'on'}</b> for this chat. Use /gatepass off or /gatepass on.` : 'Gate-pass reports reach every chat that tracks something here: /watch a token, wallet or creator to start (or /gatepass on for the reports only).');
    const on = await setGatePass(owner, want === 'on');
    return sendTelegram(chat, on ? 'This chat gets a report each time a new launch passes every hard gate of the scanner. Passing the gates is not a buy signal. /gatepass off to stop.' : 'Gate-pass reports stopped for this chat. /gatepass on to get them again.');
  }
  if (cmd === '/alerts') {
    const list = await alertsFor(owner, { limit: 5 });
    return sendTelegram(chat, list.length ? list.map(alertMessage).join('\n\n') : 'No alerts for this watchlist yet.');
  }
  if (cmd === '/watch' || cmd === '/unwatch') {
    if (!arg) return sendTelegram(chat, `Usage: ${cmd} &lt;id&gt;`);
    const h = KINDS.includes(hint) ? hint : null;
    const t = (cmd === '/unwatch' && await findWatched(owner, arg, h)) || await resolveTarget(arg, h);
    if (!t) return sendTelegram(chat, `<code>${esc(arg.slice(0, 64))}</code> is not in the system. Watch a token the tracker follows (contract or symbol), a wallet, a creator, an NFT collection or a c_… group id.`);
    const r = await setWatch(owner, t, cmd === '/watch');
    return sendTelegram(chat, r.ok ? `${cmd === '/watch' ? 'Watching' : 'Stopped watching'} ${t.kind} <code>${esc(t.id)}</code>.` : esc(r.error));
  }
  if (cmd === '/hacks') return sendTelegram(chat, await latestMessage());
  if (cmd === '/hack') {
    if (!arg) return sendTelegram(chat, 'Usage: /hack &lt;wallet | transaction hash | NearBlocks link&gt;');
    const f = await findIncident(arg);
    if (f?.checked) return sendTelegram(chat, `Safe Near has looked at <code>${esc(arg.slice(0, 70))}</code>: no hack is confirmed. That is not a guarantee: send /report with what you saw if you think it is one.`);
    if (!f) {
      // nothing known yet: investigate it (a report: nothing is flagged on it alone) and say when to ask again
      const r = await report(arg, { via: 'telegram', who: owner, note: '/hack' });
      return sendTelegram(chat, r.error ? esc(r.error) : `No hack is linked to <code>${esc(arg.slice(0, 70))}</code> yet. It is being investigated from the chain now: send /hack again in a few minutes.`);
    }
    await sendTelegram(chat, await incidentMessage(f.inc, { role: f.role, id: f.id }));
    const file = evidenceFile(f.inc);
    return sendTelegramDocument(chat, file.name, file.text, 'Evidence pack (Markdown): forward it as is.');
  }
  if (cmd === '/report') {
    if (!arg) return sendTelegram(chat, 'Usage: /report &lt;account | transaction hash&gt; [what happened]');
    const r = await report(arg, { via: 'telegram', who: owner, note: text.split(/\s+/).slice(2).join(' ') });
    if (r.error) return sendTelegram(chat, esc(r.error));
    const url = config.alerts.siteUrl ? `${config.alerts.siteUrl}/firewall?q=${encodeURIComponent(arg)}` : null;
    return sendTelegram(chat, `Thanks. <code>${esc(arg.slice(0, 70))}</code> is being investigated from the chain (a few minutes). Nothing is flagged on a report alone: only what the trace confirms.${url ? `
<a href="${esc(url)}">Follow it on Safety Check</a>` : ''}`);
  }
  if (cmd === '/check') {
    if (!arg) return sendTelegram(chat, 'Usage: /check &lt;token or NFT collection&gt;');
    const t = await resolveTarget(arg);
    const a = t?.kind === 'token' ? await getAnalysis(t.id) : t?.kind === 'collection' ? await getNftAnalysis(t.id) : null;
    if (!a) return sendTelegram(chat, `<code>${esc(arg.slice(0, 64))}</code> is not a tracked token or NFT collection.`);
    const flags = (a.flags || []).filter((f) => f.level !== 'info').slice(0, 6);
    const url = config.alerts.siteUrl ? `\n<a href="${esc(`${config.alerts.siteUrl}/${t.kind === 'token' ? 'analysis' : 'nfts'}/${encodeURIComponent(t.id)}`)}">Full analysis</a>` : '';
    return sendTelegram(chat, `<b>${esc(a.symbol || a.info?.name || t.id)}</b>\n${flags.length ? flags.map((f) => `${f.level === 'high' ? '🔴' : '🟠'} ${esc(f.text)}`).join('\n') : 'No high or medium risk notes.'}${url}`);
  }
}

async function safeReply(chat, q) {
  const { inspect } = await import('../firewall/inspect.js');
  const r = await inspect(q.slice(0, 300)).catch((e) => ({ verdict: 'unknown', headline: `Could not check it: ${e.message}` }));
  return sendTelegram(chat, safeMessage(q, r));
}

/**
 * Updates grouped by chat: each chat's commands run in order, different chats at the same time (a few at once), so one slow command (an
 * investigation, a fresh analysis) never holds up everyone else. Pure grouping, exported for tests.
 */
export function byChat(updates) {
  const m = new Map();
  for (const u of updates) { const c = u.message?.chat?.id; if (c == null) continue; (m.get(c) || m.set(c, []).get(c)).push(u.message); }
  return [...m.values()];
}

let running = false, menuSet = false;
/** One getUpdates round (long poll up to 25 s). The worker calls it in a loop when a bot token is set. */
export async function pollTelegram() {
  if (!config.alerts.telegramToken || running) return 0;
  running = true;
  try {
    if (!menuSet) { menuSet = true; await tg('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }).catch(() => {}); }
    const offset = ((await metaGet('alerts:tg_offset')) || 0) + 1;
    const r = await fetch(`https://api.telegram.org/bot${config.alerts.telegramToken}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`, { signal: AbortSignal.timeout(35000) }).then((x) => x.json());
    if (!r.ok) throw new Error(r.description || 'getUpdates failed');
    const updates = r.result || [];
    // the offset moves past the whole batch first (a command is answered at most once, as before)
    if (updates.length) await metaSet('alerts:tg_offset', updates[updates.length - 1].update_id);
    const chats = byChat(updates);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(5, chats.length) }, async () => {
      while (next < chats.length) for (const m of chats[next++]) await handle(m).catch((e) => warn(`Telegram command failed: ${e.message}`));
    }));
    return (r.result || []).length;
  } finally { running = false; }
}
