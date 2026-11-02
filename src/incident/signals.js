// Off-chain signals: many crimes are known off-chain first (an exchange announcement, a news story, someone in a Telegram group asking
// "does anyone know this wallet?"). Two ways in, both ending in an investigation, never in a flag by themselves (flags come only from a
// confirmed trace):
//   reports   anyone can report an account or a transaction: the @safenear_bot /report command, or the form on Safety Check
//   news      security stories about NEAR from public news feeds (NEWS_FEEDS); NEAR accounts and transaction hashes named in a story are
//             investigated, and the story shows in the live feed and raises an alert
import { col } from '../db.js';
import { config } from '../config.js';
import { info } from '../log.js';
import { raise } from '../alerts/store.js';
import { cleanText, looksLikeInjection } from '../ai/tools/untrusted.js';
import { parseInvestigation, enqueueIncident } from './service.js';

/** A report from a person. Returns { ok, id, input } or { error }. Rate limiting is the caller's job. */
export async function report(text, { via = 'web', who = null, note = '' } = {}) {
  let input;
  try { input = parseInvestigation(String(text || '').trim().split(/\s+/)[0]); } catch (e) { return { error: e.message }; }
  const id = `rep:${JSON.stringify(input)}`;
  const n = cleanText(note || '', 300);
  await col('reports').updateOne({ _id: id }, { $setOnInsert: { _id: id, input, first_ts: Date.now() }, $set: { last_ts: Date.now() }, $inc: { count: 1 }, $push: { notes: { $each: n && !looksLikeInjection(n) ? [{ via, who, note: n, ts: Date.now() }] : [], $slice: -20 } } }, { upsert: true });
  await enqueueIncident(input, { reason: `reported (${via})` });
  info(`report via ${via}: ${JSON.stringify(input)}`);
  return { ok: true, id, input };
}

// ---- news
const NEAR_RX = /\bNEAR\b|near protocol|near intents|\.near\b|aurora/;
const CRIME_RX = /\b(hack(ed|er|s)?|exploit(ed)?|drain(ed|er)?|stolen|theft|breach|compromised?|attack(ed|er)?|rug ?pull|scam|phishing|launder(ing|ed)?|suspicious (outflow|withdrawal)s?)\b/i;
const ACCOUNT_RX = /\b([a-z0-9_-]{2,40}(?:\.[a-z0-9_-]{2,40})*\.(?:near|tg))\b|\b([0-9a-f]{64})\b/g;
const TX_RX = /(?:nearblocks\.io\/txns\/|pikespeak\.ai\/transaction-viewer\/|tx(?:\s*hash)?[:\s]+)([1-9A-HJ-NP-Za-km-z]{43,44})/g;
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const tag = (x, t) => decode((x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')) || [])[1]);

/** Items of an RSS / Atom feed: [{ title, link, text, ts }]. Pure. */
export function parseFeed(xml) {
  return (String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || []).map((x) => ({
    title: tag(x, 'title'), link: tag(x, 'link') || (x.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '',
    text: `${tag(x, 'description')} ${tag(x, 'content:encoded')} ${tag(x, 'summary')}`.slice(0, 6000), ts: Date.parse(tag(x, 'pubDate') || tag(x, 'published') || tag(x, 'updated')) || Date.now() }));
}
/** Is a story about a NEAR crime, and which accounts / transactions does it name? Pure. */
export function newsSignal(item) {
  const all = `${item.title} ${item.text}`;
  if (!NEAR_RX.test(all) || !CRIME_RX.test(all)) return null;
  const accounts = [...new Set([...all.toLowerCase().matchAll(ACCOUNT_RX)].map((m) => m[1] || m[2]))].filter((a) => !/^(near|www|app|docs|blog)\./.test(a)).slice(0, 5);
  const txs = [...new Set([...all.matchAll(TX_RX)].map((m) => m[1]))].slice(0, 3);
  const exchange = (all.match(/\b(Binance|OKX|Bybit|Coinbase|Kraken|KuCoin|Gate\.io|HTX|Huobi|Bitget|MEXC|Upbit|Bithumb|Crypto\.com|Bitfinex)\b/) || [])[1] || null;
  return { accounts, txs, exchange };
}

/** Read the news feeds once. Returns how many new NEAR security stories were found. */
export async function pollNews() {
  const feeds = config.incidents.newsFeeds;
  let found = 0;
  for (const url of feeds) {
    const xml = await fetch(url, { headers: { 'user-agent': 'SafeNear/1.0 (+security news)' }, signal: AbortSignal.timeout(20000) }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    for (const it of parseFeed(xml).slice(0, 50)) {
      if (!it.link || Date.now() - it.ts > 7 * 86400e3) continue;
      const sig = newsSignal(it);
      if (!sig) continue;
      const id = `news:${it.link}`;
      const r = await col('security_news').updateOne({ _id: id }, { $setOnInsert: { _id: id, title: cleanText(it.title, 200), link: it.link, source: new URL(url).hostname, ts: it.ts, seen_ts: Date.now(), ...sig } }, { upsert: true });
      if (!r.upsertedCount) continue;
      found++;
      for (const a of sig.accounts) await enqueueIncident({ account: a }, { reason: `news: ${new URL(it.link).hostname}` });
      for (const t of sig.txs) await enqueueIncident({ tx: t }, { reason: `news: ${new URL(it.link).hostname}` });
      await raise(id, { type: 'security_news', severity: sig.accounts.length || sig.txs.length || sig.exchange ? 'high' : 'medium', title: `In the news: ${cleanText(it.title, 160)}`,
        text: `${new URL(url).hostname}${sig.exchange ? ` · mentions ${sig.exchange}` : ''}${sig.accounts.length ? ` · names ${sig.accounts.join(', ')} (investigating)` : ''}${sig.txs.length ? ` · ${sig.txs.length} transaction(s) (investigating)` : ''}. ${it.link}`,
        url: sig.accounts[0] ? `/firewall?q=${encodeURIComponent(sig.accounts[0])}` : null, related: { wallets: sig.accounts }, data: { link: it.link, ...sig }, ts: it.ts });
    }
  }
  if (found) info(`security news: ${found} new NEAR stories`);
  return found;
}
