// Incidents: trace (trace.js) -> AI write-up (ai.js) -> saved (`incidents`) -> the attacker's accounts flagged for the transaction firewall
// and Safety Check -> an alert. Investigations come from the live detector (detect.js), the page, the API or the CLI; they run one at a
// time in the worker from `incident_queue`, or in this process for a page that asks (a web-only server has no worker).
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { raise } from '../alerts/store.js';
import { validNearAddress } from '../audit/service.js';
import { traceIncident } from './trace.js';
import { aiIncidentReport } from './ai.js';
import { scheduleReview } from './deepreview.js';
import { followUpIncident } from './followup.js';

// a case traced by an older version is traced in full once more (the rules improve); after that, re-runs are follow-ups
export const INCIDENT_V = 3;
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
  const what = `${inc.kind === 'wallet_drainer' ? 'drained wallets' : inc.kind === 'exchange_drain' ? `received the money drained from ${inc.drain?.exchange || 'an exchange'}'s hot wallets` : `exploited ${inc.target?.account || 'a contract'}`}${inc.started_ts ? ` on ${new Date(inc.started_ts).toISOString().slice(0, 10)}` : ''} (~$${Math.round(inc.stolen_usd).toLocaleString('en-US')} taken)`;
  const reason = what;
  const DETAIL = { accomplice: `One of the attacker's own accounts (named in public reports): it ${what}. Do not send anything to it or trade with it.`, attacker: `This account ${what}. Do not send anything to it or trade with it.`, sub_account: `A sub-account of the attacker that ${what}.`, contract: `A contract deployed by the attacker that ${what}.`,
    fake_token: `A fake token made by the attacker that ${what}. It has no value.`, intents_account: `A NEAR Intents account of the attacker that ${what}.`, cash_out_wallet: `Received money from an attacker that ${what}.`, funder: `Funded the account that ${what}.` };
  const sev = { accomplice: 'critical', attacker: 'critical', fake_token: 'critical', sub_account: 'critical', intents_account: 'high', cash_out_wallet: 'high', funder: 'medium' };
  const swapAddrs = new Set((inc.trail?.moves || []).filter((m) => m.swap).map((m) => m.to));
  const rows = (inc.accounts || []).filter((a) => sev[a.role] && !swapAddrs.has(a.account) && a.account !== inc.target?.account);
  // the flags follow the latest trace: an account no longer in the attacker's set loses this incident's flag
  await col('firewall_flags').deleteMany({ source: 'incident', incident: inc._id, _id: { $nin: rows.map((a) => a.account) } });
  for (const a of rows) {
    // this incident's own flag is refreshed with the latest wording; a flag from another source (a hand report, another incident) is kept
    await col('firewall_flags').updateOne({ _id: a.account, source: 'incident', incident: inc._id }, { $set: { severity: sev[a.role], reason: `${a.role === 'funder' ? 'funded an attacker that ' : ''}${reason}`.slice(0, 120),
      detail: DETAIL[a.role], source: 'incident', incident: inc._id }, $setOnInsert: { ts: Date.now() } }, { upsert: true }).catch((e) => { if (e.code !== 11000) throw e; });
  }
  return rows.length;
}

/**
 * A full trace rebuilds a case's accounts from the chain, so accounts an analyst added by hand (marked `added_by`: a manual trace, a
 * laundering ring found by looking at tokens) would drop out, and their flags and role_in facts with them. They are carried over: an
 * account the new trace found too keeps the trace's role and gets the mark, so a later trace that loses it still keeps it. The target
 * and the victims are never added back as the attacker's.
 */
export function keepHandAdded(inc, prevAccounts) {
  inc.accounts = inc.accounts || [];
  const not = new Set([inc.target?.account, ...(inc.victims || []).map((v) => v.account)].filter(Boolean));
  for (const a of prevAccounts || []) {
    if (!a?.added_by || !a.account || not.has(a.account)) continue;
    const now = inc.accounts.find((x) => x.account === a.account);
    if (now) now.added_by ??= a.added_by;
    else inc.accounts.push(a);
  }
  return inc;
}

/** A saved case that a re-run can follow up rather than trace again: the account's own case, or the case it was re-rooted into. */
async function followable(input) {
  if (!input.account) return null;
  const prev = await col('incidents').findOne({ $or: [{ _id: `inc:${input.account}` }, { pasted: input.account }] }, { projection: { _id: 1, v: 1, status: 1 } });
  return prev && prev.v === INCIDENT_V && prev.status !== 'nothing_found' ? col('incidents').findOne({ _id: prev._id }) : null;
}

/**
 * Trace, write up, save, flag and alert. Returns the saved incident. A case traced before is followed up (only what happened since, with a
 * short NEAR AI note) unless `full` is asked for or the follow-up finds new money coming in.
 */
export async function investigate(input, { ai = true, detected = null, review = true, full = false, log = () => {} } = {}) {
  const prior = full ? null : await followable(input).catch(() => null);
  if (prior) {
    const r = await followUpIncident(prior, { log }).catch((e) => ({ full: `follow-up failed: ${e.message}` }));
    if (r.inc) {
      const doc = { ...r.inc, detected: detected || prior.detected || null, updated_ts: Date.now() };
      await col('incidents').replaceOne({ _id: doc._id }, doc);
      const flagged = await flagAccounts(doc).catch(() => 0); // new cash-out wallets of a proven case are flagged too
      const f = r.followup;
      info(`incident ${doc._id}: follow-up, ${f.txs_read} new transactions, ${f.new_moves} new moves ($${f.moved_usd}), still held $${f.held_after}${f.note ? ' · NEAR AI note' : ''} (${flagged} accounts flagged)`);
      return doc;
    }
    log(`full trace: ${r.full}`);
    info(`incident ${prior._id}: full trace (${r.full})`);
  }
  const inc = await traceIncident(input, { log });
  const prev = await col('incidents').findOne({ _id: inc._id }, { projection: { confirmed_by: 1, followups: 1, first_seen_ts: 1, detected: 1, ai: 1, alerted: 1, review: 1, tags: 1, status: 1, cleared: 1, accounts: 1 } });
  // accounts an analyst added by hand survive the re-trace (before the confirmation, so a public report's role still wins)
  if (prev?.accounts) keepHandAdded(inc, prev.accounts);
  // confirmed by a public report (an operator, with its source): it stays a hack whatever the chain alone can prove
  if (prev?.confirmed_by) applyConfirmation(inc, prev.confirmed_by);
  // cleared by a deep review and still not confirmed by the rules: it stays cleared
  else if (prev?.status === 'cleared' && inc.status !== 'confirmed') inc.status = 'cleared';
  const report = ai && inc.status !== 'nothing_found' ? await aiIncidentReport(inc).catch((e) => { warn(`incident AI: ${e.message}`); return null; }) : null;
  const doc = { ...inc, v: INCIDENT_V, ...(prev?.followups ? { followups: prev.followups } : {}), ai: report || prev?.ai || null, detected: detected || prev?.detected || null, first_seen_ts: prev?.first_seen_ts || Date.now(), updated_ts: Date.now(), ...(prev?.alerted ? { alerted: true } : {}), ...(prev?.review ? { review: prev.review } : {}), ...(prev?.tags ? { tags: prev.tags } : {}), ...(prev?.cleared ? { cleared: prev.cleared } : {}) };
  await col('incidents').replaceOne({ _id: doc._id }, doc, { upsert: true });
  if (review && !prev && !detected && ['confirmed', 'suspected'].includes(doc.status)) await scheduleReview(doc._id, 'incident').catch(() => {});
  // traced from one of its wallets and re-rooted: an earlier empty investigation of that wallet now points here
  if (doc.pasted && doc.pasted !== doc.attacker.account) await col('incidents').deleteOne({ _id: `inc:${doc.pasted}`, status: 'nothing_found' }).catch(() => {});
  const flagged = await flagAccounts(doc).catch(() => 0);
  // no longer confirmed (a re-trace with better evidence): its flags go, and its alert says it was retracted
  if (doc.status !== 'confirmed') {
    const r = await col('firewall_flags').deleteMany({ source: 'incident', incident: doc._id });
    if (prev?.alerted) await col('alerts').updateOne({ _id: `incident:${doc._id}`, title: { $not: /^Retracted/ } }, [{ $set: { title: { $concat: ['Retracted (not a hack): ', '$title'] }, severity: 'info' } }]).catch(() => {});
    await retractMoveAlerts([doc._id]);
    if (r.deletedCount) info(`incident ${doc._id}: no longer confirmed, ${r.deletedCount} flags removed`);
  }
  // found long after the attack (an April hack reported today): it is history, not news. No alert; only new moves of its money warn
  const old = doc.started_ts && Date.now() - doc.started_ts > config.incidents.alertMaxAgeDays * 86400e3;
  if (doc.status === 'confirmed' && !prev?.alerted && old) {
    await col('incidents').updateOne({ _id: doc._id }, { $set: { alerted: true, alert_skipped: `the attack was on ${new Date(doc.started_ts).toISOString().slice(0, 10)}, found ${new Date().toISOString().slice(0, 10)}` } });
    info(`incident ${doc._id}: confirmed, but the attack is from ${new Date(doc.started_ts).toISOString().slice(0, 10)}: no alert`);
  } else if (doc.status === 'confirmed' && !prev?.alerted) {
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

/**
 * What a public report establishes, laid over what the chain alone could trace (a collector account seen alone looks like a receiver, its
 * master like a victim): the status, the kind, the target and the reported loss, and the attacker's other accounts the report names, which
 * become the case's own (flagged, followed, never victims). Accounts that only delivered the attacker's swaps (NEAR Intents solvers) are not
 * victims either.
 */
function applyConfirmation(inc, cb) {
  const known = new Set(cb.accounts || []), services = new Set((inc.sources || []).filter((x) => x.kind === 'service').map((x) => x.account));
  inc.confirmed_by = cb;
  inc.status = 'confirmed';
  if (cb.kind) inc.kind = cb.kind;
  inc.accounts = [...(inc.accounts || []).filter((a) => !known.has(a.account)), ...[...known].map((account) => ({ account, role: 'accomplice' }))];
  inc.victims = (inc.victims || []).filter((v) => !known.has(v.account) && !services.has(v.account));
  inc.sources = (inc.sources || []).map((x) => (known.has(x.account) ? { ...x, kind: 'attacker', name: 'the attacker\'s own account (public report)' } : x));
  if (cb.target) inc.target = { ...(inc.target?.account === cb.target ? inc.target : {}), account: cb.target, contract: true, ...(cb.loss_usd ? { lost_usd: cb.loss_usd } : {}) };
  // the report names who lost the money: that is the victim; the accounts the trace saw paying the collector are kept apart (its swaps,
  // its other counterparties), never shown as people who lost money to it
  if (cb.target) { inc.counterparties = inc.victims; inc.victims = [{ account: cb.target, contract: true, label: 'named in public reports', lost_usd: cb.loss_usd ? Math.round(cb.loss_usd) : null, tokens: [], txs: [] }]; }
  if (cb.loss_usd) { inc.stolen_usd = Math.round(cb.loss_usd); inc.prices_note = 'as reported publicly'; }
  inc.signals = [`confirmed by public reports: ${cb.reason}`, ...(inc.signals || []).filter((s) => !/^confirmed by public reports/.test(s))];
}

/**
 * Confirm a case from outside the chain: a hack the rules cannot prove alone (a key compromise, signed intents), confirmed by public reports.
 * `source` is the link (an X post, a news story), `reason` one line. The case is traced again and stays confirmed from then on: the rules
 * cannot un-confirm it and NEAR AI cannot clear it. Its attacker's accounts are flagged and followed (never the accounts that paid in).
 */
export async function confirmIncident(account, { source, reason, by = 'operator', kind = null, target = null, loss_usd = null, accounts = [] }) {
  if (source && !/^https?:\/\//.test(String(source))) throw new Error('source: a link to the public report (an X post or a news story), or none'); // a link can be added later
  const id = `inc:${account}`;
  if (!(await col('incidents').findOne({ _id: id }, { projection: { _id: 1 } }))) throw new Error(`no case ${id}: investigate the account first`);
  const confirmed_by = { by, source: source ? String(source).slice(0, 300) : null, reason: String(reason || 'confirmed by operator').slice(0, 200), ts: Date.now(),
    kind: kind || null, target: target || null, loss_usd: loss_usd ? Number(loss_usd) : null, accounts: [...new Set((accounts || []).map((a) => String(a).toLowerCase()))].filter((a) => a !== account).slice(0, 100) };
  await col('incidents').updateOne({ _id: id }, { $set: { confirmed_by }, $push: { tags: { $each: [{ tag: 'hack', ts: Date.now(), why: confirmed_by.reason, by }], $slice: -10 } } });
  const doc = await investigate({ account }, { full: true });
  await col('deep_reviews').updateOne({ _id: id }, { $set: { status: 'done', done_ts: Date.now(), result: { tag: 'hack', why: confirmed_by.reason, status: 'confirmed' } } }).catch(() => {});
  return doc;
}

/**
 * Unconfirm a case: remove confirmation, revert status to suspected, strip firewall flags and retract alerts.
 */
export async function unconfirmIncident(account, { by = 'operator', reason = 'unconfirmed by operator' } = {}) {
  const id = `inc:${account}`;
  const inc = await col('incidents').findOne({ _id: id });
  if (!inc) throw new Error(`no case ${id}`);
  await col('incidents').updateOne({ _id: id }, {
    $unset: { confirmed_by: '' },
    $set: { status: 'suspected', updated_ts: Date.now() },
    $push: { tags: { $each: [{ tag: 'review', ts: Date.now(), why: reason, by }], $slice: -10 } }
  });
  await col('deep_reviews').deleteOne({ _id: id }).catch(() => {});
  const doc = await investigate({ account }, { full: true });
  return doc;
}

/**
 * Mark a case as cleared/normal (e.g. moved funds from solvers or hot wallet exchanges, routine transfer):
 * sets status: 'cleared', tag: 'safe', removes flags and alerts.
 */
export async function clearIncident(account, { by = 'operator', reason = 'Normal fund movement / solver activity' } = {}) {
  const id = `inc:${account}`;
  const inc = await col('incidents').findOne({ _id: id });
  if (!inc) throw new Error(`no case ${id}`);
  const cleared = { ts: Date.now(), why: reason, by };
  await col('incidents').updateOne({ _id: id }, {
    $unset: { confirmed_by: '' },
    $set: { status: 'cleared', cleared, updated_ts: Date.now() },
    $push: { tags: { $each: [{ tag: 'safe', ts: Date.now(), why: reason, by }], $slice: -10 } }
  });
  await col('firewall_flags').deleteMany({ source: 'incident', incident: id });
  await col('alerts').updateMany({ $or: [{ _id: `incident:${id}` }, { 'data.incident': id }, { 'related.wallets': account, type: { $in: ['drain_suspected', 'incident'] } }], title: { $not: /^(Not a hack|Retracted|Safe)/ } }, [{ $set: { title: { $concat: ['Safe after review: ', '$title'] }, severity: 'info' } }]).catch(() => {});
  await retractMoveAlerts([id]);
  await col('deep_reviews').deleteOne({ _id: id }).catch(() => {});
  return col('incidents').findOne({ _id: id });
}

/** The "stolen funds moved" alerts of cases that are not (or no longer) confirmed say they were retracted. Returns how many. */
export async function retractMoveAlerts(ids = null) {
  if (!ids) { const proven = new Set(await col('incidents').distinct('_id', { status: 'confirmed' })); ids = (await col('alerts').distinct('data.incident', { type: 'stolen_funds_moved' })).filter((i) => !proven.has(i)); }
  if (!ids.length) return 0;
  const r = await col('alerts').updateMany({ type: 'stolen_funds_moved', 'data.incident': { $in: ids }, title: { $not: /^Retracted/ } }, [{ $set: { title: { $concat: ['Retracted (not a hack): ', '$title'] }, severity: 'info' } }]).catch(() => null);
  return r?.modifiedCount || 0;
}

export const enqueueIncident = (input, { reason = 'manual', detected = null } = {}) => col('incident_queue').updateOne({ _id: JSON.stringify(input) },
  { $set: { input, reason, detected, status: 'pending', ts: Date.now() }, $setOnInsert: { attempts: 0 } }, { upsert: true });

/** Investigate the next queued incident (worker). */
// a job "running" this long was cut off (a restart, a crash) and is taken again; one investigation gets this long before the next one starts
const STALE_MS = 15 * 60e3;
export const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => { const t = setTimeout(() => no(new Error(`${what}: no result after ${Math.round(ms / 60e3)} min`)), ms); t.unref?.(); })]);

export async function processIncidentQueue() {
  const job = await col('incident_queue').findOneAndUpdate({ attempts: { $lt: 3 }, $or: [{ status: 'pending' }, { status: 'running', started_ts: { $lt: Date.now() - STALE_MS } }] },
    { $set: { status: 'running', started_ts: Date.now() }, $inc: { attempts: 1 } }, { sort: { ts: 1 }, returnDocument: 'after' });
  const j = job?.value !== undefined && job?.ok !== undefined ? job.value : job;
  if (!j) return null;
  try {
    const doc = await withTimeout(investigate(j.input, { detected: j.detected }), config.incidents.investigateTimeoutMinutes * 60e3, 'investigation');
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
export function startInvestigation(input, { full = false } = {}) {
  const key = JSON.stringify(input), cur = jobs.get(key);
  if (cur?.running) return cur;
  const j = { running: true, started: Date.now(), error: null, id: null, step: 'starting' };
  jobs.set(key, j);
  investigate(input, { full, log: (m) => { j.step = m; } }).then((d) => { j.id = d._id; }).catch((e) => { j.error = e.message; }).finally(() => { j.running = false; });
  if (jobs.size > 200) for (const [k, v] of jobs) if (!v.running) { jobs.delete(k); if (jobs.size < 150) break; }
  return j;
}
export const investigationJob = (input) => jobs.get(JSON.stringify(input)) || null;
