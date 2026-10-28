// Alert delivery: high-severity alerts to the public Telegram channel and the global webhook; every alert to the Telegram chats and
// webhooks of the watchlists it concerns. The dashboard and the API read alerts directly (pull).
import dns from 'node:dns/promises';
import net from 'node:net';
import { col } from '../db.js';
import { config } from '../config.js';
import { warn } from '../log.js';
import { TYPES, SEVERITIES } from './store.js';
import { ownersFor } from './watch.js';

// ---------------------------------------------------------------- webhooks (SSRF-safe)
/** Is an IP address on the public internet? (no loopback, private, link-local, CGNAT, multicast, cloud metadata, IPv4-mapped tricks) */
export function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (mapped) return isPublicIp(mapped[1]);
    return !(x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff') || x.startsWith('64:ff9b'));
  }
  return false;
}

/** A webhook URL anyone may register: https, a public host name or address, default port. Returns { ok, error? }. */
export async function checkWebhookUrl(raw) {
  let u; try { u = new URL(raw); } catch { return { ok: false, error: 'not a URL' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'webhooks must use https' };
  if (u.username || u.password) return { ok: false, error: 'no credentials in the URL' };
  if (u.port && u.port !== '443') return { ok: false, error: 'only the default https port' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return { ok: false, error: 'local host names are not allowed' };
  let addrs; try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); } catch { return { ok: false, error: 'the host does not resolve' }; }
  if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) return { ok: false, error: 'the host resolves to a private or local address' };
  return { ok: true };
}

/** POST an alert as JSON. The URL is re-checked right before sending (DNS can change); redirects are not followed. */
export async function postWebhook(url, payload) {
  const chk = await checkWebhookUrl(url); if (!chk.ok) throw new Error(`webhook refused: ${chk.error}`);
  const res = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'user-agent': 'safe-near-alerts/1' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
  if (res.status >= 300) throw new Error(`webhook answered ${res.status}`);
}

// ---------------------------------------------------------------- Telegram
const tg = (method, body) => fetch(`https://api.telegram.org/bot${config.alerts.telegramToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }).then((r) => r.json());
const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ICON = { high: '🔴', medium: '🟠', info: '🔵' };
/** The transaction an alert is about, on NearBlocks (null for alerts about a state, e.g. a rug flag or a code change). */
export const txUrl = (a) => (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(a?.data?.hash || '') ? `https://nearblocks.io/txns/${a.data.hash}` : null);
/** When the alert's event happened on chain (or when it was raised, for alerts about a state). */
export const eventTs = (a) => a?.data?.event_ts ?? a?.ts ?? null;
/** Too old to announce: the event happened more than maxAgeMinutes ago (a backlog, downtime). It stays on the dashboard and in the API. */
export const isStale = (a, now = Date.now(), maxAgeMinutes = config.alerts.maxAgeMinutes) => eventTs(a) != null && now - eventTs(a) > maxAgeMinutes * 60e3;
const utc = (ts) => new Date(ts).toISOString().slice(11, 16) + ' UTC';
/** One alert as a Telegram message (HTML), with its time, and links to the dashboard page (when the site URL is configured) and the transaction. */
export const alertMessage = (a) => {
  const at = a.data?.event_ts ? `\n🕒 ${utc(a.data.event_ts)}` : '';
  const links = [a.url && config.alerts.siteUrl ? `<a href="${escHtml(config.alerts.siteUrl + a.url)}">Open on Safe Near</a>` : null, txUrl(a) ? `<a href="${escHtml(txUrl(a))}">Transaction on NearBlocks</a>` : null].filter(Boolean);
  return `${ICON[a.severity] || ''} <b>${escHtml(a.title)}</b>\n${escHtml(a.text)}${at}${links.length ? '\n' + links.join(' · ') : ''}`;
};
export async function sendTelegram(chatId, text) {
  if (!config.alerts.telegramToken) return;
  const r = await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  if (!r.ok) throw new Error(`Telegram: ${r.description || 'send failed'}`);
}

/** The public payload (also what the API returns). */
export const alertPayload = (a) => ({ id: a._id, ts: a.ts, type: a.type, label: TYPES[a.type]?.label, severity: a.severity, title: a.title, text: a.text, url: a.url && config.alerts.siteUrl ? config.alerts.siteUrl + a.url : a.url, tx_url: txUrl(a), event_ts: a.data?.event_ts ?? null, related: a.related });

const atLeast = (sev, min) => SEVERITIES.indexOf(sev) <= SEVERITIES.indexOf(min);
/** Deliver alerts not sent yet (oldest first, a batch at a time). */
export async function deliverPending(limit = 30) {
  const todo = await col('alerts').find({ delivered: false }).sort({ ts: 1 }).limit(limit).toArray();
  let sent = 0;
  for (const a of todo) {
    if (isStale(a)) { await col('alerts').updateOne({ _id: a._id }, { $set: { delivered: true, delivery: { skipped: 'stale' }, delivered_ts: Date.now() } }); continue; }
    const out = { channel: 0, webhook: 0, chats: 0, hooks: 0, errors: [] };
    const tryIt = async (k, fn) => { try { await fn(); out[k]++; } catch (e) { out.errors.push(`${k}: ${e.message}`.slice(0, 160)); } };
    if (atLeast(a.severity, config.alerts.publicSeverity)) {
      if (config.alerts.telegramChannel) await tryIt('channel', () => sendTelegram(config.alerts.telegramChannel, alertMessage(a)));
      if (config.alerts.webhookUrl) await tryIt('webhook', () => postWebhook(config.alerts.webhookUrl, alertPayload(a)));
    }
    for (const w of await ownersFor(a)) {
      if (w._id.startsWith('tg_') && config.alerts.telegramToken) await tryIt('chats', () => sendTelegram(w._id.slice(3), alertMessage(a)));
      if (w.webhook) await tryIt('hooks', () => postWebhook(w.webhook, alertPayload(a)));
    }
    if (out.errors.length) warn(`alert ${a._id}: ${out.errors.join('; ')}`);
    await col('alerts').updateOne({ _id: a._id }, { $set: { delivered: true, delivery: out, delivered_ts: Date.now() } });
    sent++;
  }
  return sent;
}
