// Money watch, people (docs/money-watch-design.md section 7): a person reports an address as part of a hack.
//   in a watch      the report is stored as evidence. With a source (a link) the watch is confirmed and promoted to an incident; without one the
//                   reviewer re-reviews it at once with the report as evidence.
//   in an incident  with a source: the incident is confirmed (the existing human confirmation); without: a note on the case and a deep review.
//   in neither      the funding of the address is looked back over large movements (WATCH_LINK_HOPS); when it reaches an account of a watch or an
//                   incident, the address joins that case and the reviewer re-reviews it with the link and the report (a report about an address
//                   does not by itself confirm the case its money came from). When nothing is found a new watch opens for the address.
import { col } from '../db.js';
import { config } from '../config.js';
import { accountTxHashes, fetchTxs } from '../incident/trace.js';
import { flowsOfTx } from '../incident/flows.js';
import { valueOf } from '../incident/prices.js';
import { confirmIncident, investigate } from '../incident/service.js';
import { scheduleReview } from '../incident/deepreview.js';
import { isPass } from './scan.js';
import { openWatch, setStatus, watchesOf, reopen } from './store.js';

const clean = (a) => String(a || '').trim().toLowerCase();

/** The incident that has `account` (as its attacker or one of its accounts), or null. */
const incidentOf = (account) => col('incidents').findOne({ $or: [{ 'attacker.account': account }, { 'accounts.account': account }] }, { projection: { _id: 1, status: 1, 'attacker.account': 1 } });

/**
 * Who paid `address` large amounts, hop by hop (at most `hops`): the first account found in a watch or an incident, with the path.
 * Returns { kind: 'watch' | 'incident', id, account, path: [address, …, account] } or null. `payersOf` is injectable for tests.
 */
export async function lookBack(address, { hops = config.watch.linkHops, payersOf = bigPayers, isKnown = knownAccount } = {}) {
  let frontier = [{ account: address, path: [address] }];
  const seen = new Set([address]);
  for (let h = 0; h < hops && frontier.length; h++) {
    const next = [];
    for (const f of frontier) {
      for (const p of await payersOf(f.account)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const hit = await isKnown(p);
        if (hit) return { ...hit, account: p, path: [...f.path, p] };
        next.push({ account: p, path: [...f.path, p] });
      }
    }
    frontier = next.slice(0, 10);
  }
  return null;
}

/** An account of a watch or an incident, or null. */
async function knownAccount(account) {
  const w = (await watchesOf(account))[0];
  if (w) return { kind: 'watch', id: w._id };
  const i = await incidentOf(account);
  return i ? { kind: 'incident', id: i._id } : null;
}

/** The accounts that paid `account` at least WATCH_FOLLOW_MIN_USD in one movement (largest first, at most 5; pass-through accounts left out). */
async function bigPayers(account) {
  const hashes = (await accountTxHashes(account, { limit: 300 }).catch(() => ({ hashes: [] }))).hashes || [];
  const txs = await fetchTxs(hashes).catch(() => []), per = new Map();
  for (const f of txs.flatMap(flowsOfTx)) {
    if (f.to !== account || isPass(f.from) || /^(nft|mint|burn):/.test(f.token)) continue;
    const v = await valueOf(f.token, f.raw).catch(() => ({}));
    if ((v.usd || 0) >= config.watch.followMinUsd) per.set(f.from, (per.get(f.from) || 0) + v.usd);
  }
  return [...per].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a);
}

const stamp = (r) => ({ ts: Date.now(), by: r.by || 'operator', source: r.source || null, note: r.note ? String(r.note).slice(0, 500) : null });
const reviewNow = (id) => col('watches').updateOne({ _id: id }, { $set: { last_review_ts: null } });

/** Promote a watch to a confirmed incident (investigate, then the human confirmation). */
export async function confirmWatch(id, { source = null, by = 'operator', note = null } = {}) {
  const w = await col('watches').findOne({ _id: id });
  if (!w) throw new Error(`no watch ${id}`);
  await investigate({ account: w.receiver }, { full: false, ai: true });
  await confirmIncident(w.receiver, { source, reason: note || 'reported by a person', by, accounts: (w.accounts || []).map((a) => a.account) });
  await setStatus(id, 'confirmed', { by, incident: `inc:${w.receiver}`, why: note || 'reported by a person' });
  return { id, status: 'confirmed', incident: `inc:${w.receiver}` };
}

/** Handle a person's report of `address`. Returns what happened: { where: 'watch' | 'incident' | 'linked' | 'new', … }. */
export async function reportAddress(raw, { source = null, note = null, by = 'operator', lookBackFn = lookBack } = {}) {
  const address = clean(raw);
  if (!address) throw new Error('an address is needed');
  if (source && !/^https?:\/\//.test(String(source))) throw new Error('source: a link to the report (an X post, a news story), or none');
  const rep = stamp({ by, source, note });
  // 1. in a watch
  const own = (await watchesOf(address)).filter((w) => w.status !== 'confirmed');
  if (own.length) {
    const w = own[0];
    await col('watches').updateOne({ _id: w._id }, { $push: { reports: rep } });
    if (w.status === 'normal') await reopen(w._id, { by, why: `reported by ${by}` });
    if (source) return { where: 'watch', ...(await confirmWatch(w._id, { source, by, note })) };
    await reviewNow(w._id);
    return { where: 'watch', id: w._id, status: w.status, next: 'the reviewer will look at it with your report' };
  }
  // 2. in an incident
  const inc = await incidentOf(address);
  if (inc) {
    if (source) { await confirmIncident(inc.attacker.account, { source, reason: note || 'reported by a person', by, accounts: [address] }); return { where: 'incident', id: inc._id, status: 'confirmed' }; }
    await col('incidents').updateOne({ _id: inc._id }, { $push: { tags: { $each: [{ tag: 'review', ts: Date.now(), why: `reported by ${by}: ${note || 'no note'}`, by }], $slice: -10 } } });
    await scheduleReview(inc._id, 'incident').catch(() => {});
    return { where: 'incident', id: inc._id, status: inc.status, next: 'a deep review is scheduled' };
  }
  // 3. funds that came from a case: look back
  const link = await lookBackFn(address);
  if (link?.kind === 'watch') {
    await col('watches').updateOne({ _id: link.id }, { $push: { reports: { ...rep, note: `${note || ''} (reported address ${address}, funded through ${link.path.join(' ← ')})`.trim() }, accounts: { account: address, depth: link.path.length, in_usd: 0, out_usd: 0, state: 'active', since: Date.now(), reason: `reported by ${by}; its funds came from ${link.account}` } } });
    await reviewNow(link.id);
    return { where: 'linked', kind: 'watch', id: link.id, path: link.path, next: 'the reviewer will look at the case again with the link and your report' };
  }
  if (link?.kind === 'incident') {
    await col('incidents').updateOne({ _id: link.id }, { $push: { tags: { $each: [{ tag: 'review', ts: Date.now(), why: `${address}, reported by ${by}, was funded from this case (${link.path.join(' ← ')})`, by }], $slice: -10 } } });
    await scheduleReview(link.id, 'incident').catch(() => {});
    return { where: 'linked', kind: 'incident', id: link.id, path: link.path, next: 'a deep review is scheduled' };
  }
  // 4. nothing known: a new watch for the address
  const now = Date.now(), w = await openWatch({ tx: `reported:${address}:${now}`, from: 'reported', to: address, usd: 0, token: 'near', ts: now }, { kind: 'reported', reason: `reported by ${by}` });
  if (!w) throw new Error('could not open a watch');
  await col('watches').updateOne({ _id: w._id }, { $push: { reports: rep } });
  return { where: 'new', id: w._id, next: 'the reviewer will look at it' };
}
