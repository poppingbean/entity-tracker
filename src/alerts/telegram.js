// The Telegram bot: anyone can keep a watchlist from a chat (private or group) and get its alerts there. Long polling (getUpdates), so
// no public endpoint is needed. Commands: /watch, /unwatch, /list, /alerts, /check, /hack, /hacks, /report, /gatepass, /help.
import { config } from '../config.js';
import { metaGet, metaSet } from '../db.js';
import { warn } from '../log.js';
import { resolveTarget, findWatched, setWatch, getWatchlist, alertsFor, setGatePass, KINDS, MAX_ITEMS } from './watch.js';
import { sendTelegram, sendTelegramDocument, alertMessage } from './deliver.js';
import { findIncident, incidentMessage, evidenceFile, latestMessage } from '../incident/botinfo.js';
import { getAnalysis } from '../analysis/token.js';
import { getNftAnalysis } from '../nft/analysis.js';
import { report } from '../incident/signals.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const HELP = `<b>Safe Near alerts</b>
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

const hits = new Map(); // chat -> [ts] (30 commands / 10 min)
const limited = (chat) => { const now = Date.now(), l = (hits.get(chat) || []).filter((t) => now - t < 600e3); l.push(now); hits.set(chat, l); return l.length > 30; };

async function handle(msg) {
  const chat = msg.chat?.id, text = (msg.text || '').trim();
  if (!chat || !text.startsWith('/')) return;
  const [cmdRaw, arg, hint] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase(), owner = `tg_${chat}`;
  if (limited(chat)) return sendTelegram(chat, 'Too many commands, try again in a few minutes.');
  if (cmd === '/start' || cmd === '/help') return sendTelegram(chat, HELP);
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

let running = false;
/** One getUpdates round (long poll up to 25 s). The worker calls it in a loop when a bot token is set. */
export async function pollTelegram() {
  if (!config.alerts.telegramToken || running) return 0;
  running = true;
  try {
    const offset = ((await metaGet('alerts:tg_offset')) || 0) + 1;
    const r = await fetch(`https://api.telegram.org/bot${config.alerts.telegramToken}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`, { signal: AbortSignal.timeout(35000) }).then((x) => x.json());
    if (!r.ok) throw new Error(r.description || 'getUpdates failed');
    for (const u of r.result || []) {
      await metaSet('alerts:tg_offset', u.update_id);
      if (u.message) await handle(u.message).catch((e) => warn(`Telegram command failed: ${e.message}`));
    }
    return (r.result || []).length;
  } finally { running = false; }
}
