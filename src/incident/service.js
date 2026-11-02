// Incidents: trace (trace.js) -> AI write-up (ai.js) -> saved (`incidents`) -> the attacker's accounts flagged for the transaction firewall
// and Safety Check -> an alert. Investigations come from the live detector (detect.js), the page, the API or the CLI; they run one at a
// time in the worker from `incident_queue`, or in this process for a page that asks (a web-only server has no worker).
import { col } from '../db.js';
import { info, warn } from '../log.js';
import { raise } from '../alerts/store.js';
import { validNearAddress } from '../audit/service.js';
import { traceIncident } from './trace.js';
import { aiIncidentReport } from './ai.js';

export const INCIDENT_V = 1;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** { account } | { tx } | { target } from what someone typed: an account, a tx hash, or "target:<contract>". */
export function parseInvestigation(q) {
  const s = String(q || '').trim().replace(/^https?:\/\/[^/]+\/(txns?|transactions?|address|accounts?)\//i, '').split(/[?#]/)[0];
  if (TX_HASH.test(s)) return { tx: s };
  const t = s.match(/^target:(.+)$/i);
  if (t && validNearAddress(t[1].toLowerCase())) return { target: t[1].toLowerCase() };
  if (validNearAddress(s.toLowerCase())) return { account: s.toLowerCase() };
  throw new Error('give an attacker account, an attack transaction hash, or target:<contract>');
}

/** Flag the attacker's own accounts (not 1Click deposit addresses or the target) so every check that touches them warns. */
async function flagAccounts(inc) {
  if (inc.status !== 'confirmed') return 0;
  const what = `${inc.kind === 'wallet_drainer' ? 'drained wallets' : inc.kind === 'exchange_drain' ? `received the money drained from ${inc.drain?.exchange || 'exchange'} hot wallets` : `exploited ${inc.target?.account || 'a contract'}`}${inc.started_ts ? ` on ${new Date(inc.started_ts).toISOString().slice(0, 10)}` : ''} (~$${Math.round(inc.stolen_usd).toLocaleString('en-US')} taken)`;
  const reason = what;
  const DETAIL = { attacker: `This account ${what}. Do not send anything to it or trade with it.`, sub_account: `A sub-account of the attacker that ${what}.`, contract: `A contract deployed by the attacker that ${what}.`,
    fake_token: `A fake token made by the attacker that ${what}. It has no value.`, intents_account: `A NEAR Intents account of the attacker that ${what}.`, cash_out_wallet: `Received money from an attacker that ${what}.`, funder: `Funded the account that ${what}.` };
  const sev = { attacker: 'critical', fake_token: 'critical', sub_account: 'critical', intents_account: 'high', cash_out_wallet: 'high', funder: 'medium' };
  const swapAddrs = new Set((inc.trail?.moves || []).filter((m) => m.swap).map((m) => m.to));
  const rows = (inc.accounts || []).filter((a) => sev[a.role] && !swapAddrs.has(a.account) && a.account !== inc.target?.account);
  for (const a of rows) {
    await col('firewall_flags').updateOne({ _id: a.account }, { $setOnInsert: { _id: a.account, severity: sev[a.role], reason: `${a.role === 'funder' ? 'funded an attacker that ' : ''}${reason}`.slice(0, 120),
      detail: DETAIL[a.role], ts: Date.now(), source: 'incident', incident: inc._id } }, { upsert: true });
  }
  return rows.length;
}

/** Trace, write up, save, flag and alert. Returns the saved incident. */
export async function investigate(input, { ai = true, detected = null, log = () => {} } = {}) {
  const inc = await traceIncident(input, { log });
  const prev = await col('incidents').findOne({ _id: inc._id }, { projection: { first_seen_ts: 1, detected: 1, ai: 1, alerted: 1 } });
  const report = ai && inc.status !== 'nothing_found' ? await aiIncidentReport(inc).catch((e) => { warn(`incident AI: ${e.message}`); return null; }) : null;
  const doc = { ...inc, v: INCIDENT_V, ai: report || prev?.ai || null, detected: detected || prev?.detected || null, first_seen_ts: prev?.first_seen_ts || Date.now(), updated_ts: Date.now() };
  await col('incidents').replaceOne({ _id: doc._id }, doc, { upsert: true });
  // traced from one of its wallets and re-rooted: an earlier empty investigation of that wallet now points here
  if (doc.pasted && doc.pasted !== doc.attacker.account) await col('incidents').deleteOne({ _id: `inc:${doc.pasted}`, status: 'nothing_found' }).catch(() => {});
  const flagged = await flagAccounts(doc).catch(() => 0);
  if (doc.status === 'confirmed' && !prev?.alerted) {
    const t = doc.target?.account || 'wallets';
    const exits = Object.entries(doc.trail?.exit_usd || {}).map(([k, v]) => `${k}: $${v.toLocaleString('en-US')}`).join(', ');
    const from = doc.kind === 'exchange_drain' ? `${doc.drain?.exchange || 'an exchange'} (${doc.victims.filter((v) => v.exchange).length} hot wallets)` : t;
    await raise(`incident:${doc._id}`, { type: 'incident', severity: 'high', title: `${{ wallet_drainer: 'Wallet drainer', exchange_drain: 'Exchange hot-wallet drain' }[doc.kind] || 'Exploit'}: ~$${doc.stolen_usd.toLocaleString('en-US')} taken from ${from} by ${doc.attacker.account}`,
      text: `${doc.ai?.headline || doc.signals.join('; ')}${exits ? `. Money went to ${exits}` : ''}${doc.held_usd ? `. The attacker still holds ~$${doc.held_usd.toLocaleString('en-US')}` : ''}.`,
      url: `/firewall/${encodeURIComponent(doc._id)}`, related: { wallets: [doc.attacker.account] }, data: { incident: doc._id, target: doc.target?.account, stolen_usd: doc.stolen_usd } });
    await col('incidents').updateOne({ _id: doc._id }, { $set: { alerted: true } });
  }
  info(`incident ${doc._id}: ${doc.status} ${doc.kind} $${doc.stolen_usd} (${flagged} accounts flagged)`);
  return doc;
}

export const enqueueIncident = (input, { reason = 'manual', detected = null } = {}) => col('incident_queue').updateOne({ _id: JSON.stringify(input) },
  { $set: { input, reason, detected, status: 'pending', ts: Date.now() }, $setOnInsert: { attempts: 0 } }, { upsert: true });

/** Investigate the next queued incident (worker). */
export async function processIncidentQueue() {
  const job = await col('incident_queue').findOneAndUpdate({ status: 'pending', attempts: { $lt: 3 } }, { $set: { status: 'running', started_ts: Date.now() }, $inc: { attempts: 1 } }, { sort: { ts: 1 }, returnDocument: 'after' });
  const j = job?.value !== undefined && job?.ok !== undefined ? job.value : job;
  if (!j) return null;
  try {
    const doc = await investigate(j.input, { detected: j.detected });
    await col('incident_queue').updateOne({ _id: j._id }, { $set: { status: 'done', done_ts: Date.now(), incident: doc._id } });
    return doc;
  } catch (e) {
    await col('incident_queue').updateOne({ _id: j._id }, { $set: { status: j.attempts >= 3 ? 'error' : 'pending', error: e.message } });
    warn(`incident ${j._id}: ${e.message}`);
    return null;
  }
}

// investigations started from the page (a web-only server has no worker)
const jobs = new Map();
export function startInvestigation(input) {
  const key = JSON.stringify(input), cur = jobs.get(key);
  if (cur?.running) return cur;
  const j = { running: true, started: Date.now(), error: null, id: null, step: 'starting' };
  jobs.set(key, j);
  investigate(input, { log: (m) => { j.step = m; } }).then((d) => { j.id = d._id; }).catch((e) => { j.error = e.message; }).finally(() => { j.running = false; });
  if (jobs.size > 200) for (const [k, v] of jobs) if (!v.running) { jobs.delete(k); if (jobs.size < 150) break; }
  return j;
}
export const investigationJob = (input) => jobs.get(JSON.stringify(input)) || null;
