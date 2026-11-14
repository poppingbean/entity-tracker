// Money watch storage (collection `watches`, docs/money-watch-design.md section 3) and the in-memory index of watched accounts the block scan reads.
//   _id 'w:<tx>:<receiver>'   status 'watching' | 'normal' | 'custody' | 'suspicious' | 'confirmed'
//   trigger { tx, from, to, usd, token, symbol, amount, ts, kind: 'movement' | 'reported' }
//   accounts [{ account, depth, in_usd, out_usd, state: 'active' | 'dropped' | 'closed', since, reason }]
//   moves [{ ts, tx, from, to, usd, token, symbol, amount, exit, followed, why }], reviews [{ ts, verdict, ... }], reports [{ ts, by, source, note }]
import { col } from '../db.js';
import { config } from '../config.js';

const MAX_MOVES = 300;

/** account → Map(watch id → { depth, in_usd, out_usd, trigger_usd, accounts: n }) for every active account of every open watch. Rebuilt from the database at most every 5 minutes; updated in place by the writes below. */
let index = { ts: 0, map: new Map(), size: new Map() };
export async function activeIndex(force = false) {
  if (!force && Date.now() - index.ts < 300e3) return index;
  const map = new Map(), size = new Map();
  const rows = await col('watches').find({ status: { $in: ['watching', 'suspicious'] } }, { projection: { accounts: 1, 'trigger.usd': 1 } }).toArray();
  for (const w of rows) {
    let n = 0;
    for (const a of w.accounts || []) {
      if (a.state !== 'active') continue;
      n++;
      (map.get(a.account) || map.set(a.account, new Map()).get(a.account)).set(w._id, { depth: a.depth || 0, in_usd: a.in_usd || 0, out_usd: a.out_usd || 0, trigger_usd: w.trigger?.usd || 0 });
    }
    size.set(w._id, n);
  }
  index = { ts: Date.now(), map, size };
  return index;
}
const drop = (account, wid) => { const m = index.map.get(account); if (m) { m.delete(wid); if (!m.size) index.map.delete(account); } };

/** Open a watch for one movement. Returns the watch, or null when it already exists. */
export async function openWatch(mv, { kind = 'movement', reason = 'a movement of ' + Math.round(mv.usd).toLocaleString('en-US') + ' USD' } = {}) {
  const now = Date.now(), _id = `w:${mv.tx}:${mv.to}`;
  const doc = { _id, status: 'watching', opened_ts: now, last_move_ts: mv.ts || now, receiver: mv.to,
    trigger: { tx: mv.tx, from: mv.from, to: mv.to, usd: Math.round(mv.usd), token: mv.token, symbol: mv.symbol || null, amount: mv.amount ?? null, ts: mv.ts || now, kind },
    origin: null, accounts: [{ account: mv.to, depth: 0, in_usd: Math.round(mv.usd), out_usd: 0, state: 'active', since: now, reason }],
    moves: [], reviews: [], reports: [], status_history: [{ ts: now, status: 'watching', by: 'rules' }], incident: null, last_review_ts: null, moved_since_review_usd: 0, new_exit: false };
  const r = await col('watches').updateOne({ _id }, { $setOnInsert: doc }, { upsert: true });
  if (!r.upsertedCount) return null;
  const idx = await activeIndex();
  (idx.map.get(mv.to) || idx.map.set(mv.to, new Map()).get(mv.to)).set(_id, { depth: 0, in_usd: Math.round(mv.usd), out_usd: 0, trigger_usd: Math.round(mv.usd) });
  idx.size.set(_id, 1);
  return doc;
}

/**
 * A move out of an account of a watch. `step` is rules.followStep's answer; `exit` (or null) says where the money ended up when the branch stops here.
 * Every move counts toward what the sender has sent on (followed or not, so splitting into small transfers still empties the sender); a move
 * too small to follow adds to what this watch has sent that receiver (`watch_pending`: splits to one receiver are summed and followed once
 * they reach the floor). Only followed moves, exits and moves of `listMinUsd` or more are listed on the watch. Each move is recorded once
 * (`watch_moves`, keyed by watch, transaction, sides, token and amount), whatever the watch's own list keeps.
 */
export async function recordMove(wid, mv, step, exit = null, { listMinUsd = config.watch.followMinUsd } = {}) {
  const idx = await activeIndex(), now = Date.now(), usd = Math.round(mv.usd);
  const key = [wid, mv.tx, mv.from, mv.to, mv.token, mv.raw ?? usd].join('|');
  const fresh = await col('watch_moves').insertOne({ _id: key, watch: wid, ts: mv.ts || now, tx: mv.tx, from: mv.from, to: mv.to, usd, token: mv.token, followed: !!step.follow, why: step.why, exit: exit || null })
    .then(() => true).catch((e) => { if (e.code === 11000) return false; throw e; });
  if (!fresh) return false; // seen before (a re-read block range)
  const move = { ts: mv.ts, tx: mv.tx, from: mv.from, to: mv.to, usd, token: mv.token, symbol: mv.symbol || null, amount: mv.amount ?? null, exit, followed: !!step.follow, why: step.why };
  const listed = step.follow || !!exit || usd >= listMinUsd;
  await col('watches').updateOne({ _id: wid }, { ...(listed ? { $push: { moves: { $each: [move], $slice: -MAX_MOVES } } } : {}), $set: { last_move_ts: mv.ts || now, ...(exit ? { new_exit: true } : {}) }, $inc: { moved_since_review_usd: usd } });
  const ent = index.map.get(mv.from)?.get(wid);
  await col('watches').updateOne({ _id: wid, 'accounts.account': mv.from }, { $inc: { 'accounts.$.out_usd': usd }, ...(step.sender === 'drop' ? { $set: { 'accounts.$.state': 'dropped' } } : {}) });
  if (ent) { ent.out_usd += usd; if (step.sender === 'drop') { drop(mv.from, wid); idx.size.set(wid, Math.max(0, (idx.size.get(wid) || 1) - 1)); } }
  const pk = `${wid}|${mv.to}`;
  if (!step.follow && step.why === 'below the follow floor' && !exit) { await col('watch_pending').updateOne({ _id: pk }, { $inc: { usd }, $set: { watch: wid, to: mv.to, ts: now } }, { upsert: true }); return true; }
  if (step.follow) {
    const pend = (await col('watch_pending').findOneAndDelete({ _id: pk }).catch(() => null)) || null;
    const inUsd = usd + Math.round((pend?.value ?? pend)?.usd || 0);
    // an account that was dropped (sent everything) and receives again is active again: it counts toward the account limit again
    const re = await col('watches').updateOne({ _id: wid, accounts: { $elemMatch: { account: mv.to, state: { $ne: 'active' } } } }, { $inc: { 'accounts.$.in_usd': inUsd }, $set: { 'accounts.$.state': 'active' } });
    if (re.modifiedCount) idx.size.set(wid, (idx.size.get(wid) || 0) + 1);
    else {
      const has = await col('watches').updateOne({ _id: wid, 'accounts.account': mv.to }, { $inc: { 'accounts.$.in_usd': inUsd } });
      if (!has.matchedCount) {
        await col('watches').updateOne({ _id: wid }, { $push: { accounts: { account: mv.to, depth: step.depth, in_usd: inUsd, out_usd: 0, state: 'active', since: now, reason: `received ${inUsd} USD from ${mv.from}` } } });
        idx.size.set(wid, (idx.size.get(wid) || 0) + 1);
      }
    }
    const e2 = index.map.get(mv.to)?.get(wid);
    if (e2) e2.in_usd += inUsd; else (idx.map.get(mv.to) || idx.map.set(mv.to, new Map()).get(mv.to)).set(wid, { depth: step.depth, in_usd: inUsd, out_usd: 0, trigger_usd: ent?.trigger_usd || 0 });
  }
  return true;
}

/** What this watch already sent `to` in moves too small to follow (summed splits). */
export const pendingOf = async (wid, to) => (await col('watch_pending').findOne({ _id: `${wid}|${to}` }).catch(() => null))?.usd || 0;

/**
 * Money coming INTO a watched account from an account the watch does not hold (the design's reverse link): listed on the watch as evidence
 * and counted for the next review. The sender is not watched: its money is not the case's.
 */
export async function recordInbound(wid, mv) {
  const now = Date.now(), usd = Math.round(mv.usd), key = [wid, 'in', mv.tx, mv.from, mv.to, mv.token, mv.raw ?? usd].join('|');
  const fresh = await col('watch_moves').insertOne({ _id: key, watch: wid, ts: mv.ts || now, tx: mv.tx, from: mv.from, to: mv.to, usd, token: mv.token, inbound: true })
    .then(() => true).catch((e) => { if (e.code === 11000) return false; throw e; });
  if (!fresh) return false;
  await col('watches').updateOne({ _id: wid }, { $push: { moves: { $each: [{ ts: mv.ts, tx: mv.tx, from: mv.from, to: mv.to, usd, token: mv.token, symbol: mv.symbol || null, amount: mv.amount ?? null, exit: null, followed: false, inbound: true, why: 'money in from an account outside the watch' }], $slice: -MAX_MOVES } }, $inc: { moved_since_review_usd: usd } });
  return true;
}

/** Close a watch with a status ('normal', 'suspicious', 'confirmed'): its accounts stop being watched, the case stays. */
export async function setStatus(wid, status, { by = 'rules', review = null, incident = null, why = null } = {}) {
  const now = Date.now(), w = await col('watches').findOne({ _id: wid }, { projection: { accounts: 1, status: 1 } });
  if (!w) return false;
  const closing = status === 'normal' || status === 'confirmed' || status === 'custody'; // a suspicious watch is still followed (its incident follows it too)
  await col('watches').updateOne({ _id: wid }, {
    $set: { status, ...(closing ? { closed_ts: now } : {}), ...(incident ? { incident } : {}), ...(review ? { last_review_ts: now, moved_since_review_usd: 0, new_exit: false, ai_missing: false } : {}) },
    $push: { status_history: { ts: now, status, by, ...(why ? { why } : {}) }, ...(review ? { reviews: review } : {}) },
  });
  if (closing) {
    await col('watches').updateOne({ _id: wid }, { $set: { 'accounts.$[a].state': 'closed' } }, { arrayFilters: [{ 'a.state': 'active' }] });
    for (const a of w.accounts || []) drop(a.account, wid);
    index.size.delete(wid);
  }
  return true;
}

/** A closed (normal) watch gets a report from a person: it is watched again. */
export async function reopen(wid, { by = 'operator', why = 'reported by a person' } = {}) {
  const now = Date.now();
  await col('watches').updateOne({ _id: wid }, { $set: { status: 'watching', closed_ts: null, last_review_ts: null, 'accounts.$[a].state': 'active' }, $push: { status_history: { ts: now, status: 'watching', by, why } } }, { arrayFilters: [{ 'a.state': 'closed' }] });
  await activeIndex(true);
}

/** Record a review that did not change the status (keep watching): moves the review clock. `review` null: nothing new to add to the history. */
export async function noteReview(wid, review, { aiMissing = false } = {}) {
  await col('watches').updateOne({ _id: wid }, { $set: { last_review_ts: Date.now(), moved_since_review_usd: 0, new_exit: false, ai_missing: aiMissing }, ...(review ? { $push: { reviews: { $each: [review], $slice: -30 } } } : {}) });
}

/** The open watches that have an account `account` (for a report by address). */
export const watchesOf = (account) => col('watches').find({ 'accounts.account': account }).sort({ opened_ts: -1 }).limit(20).toArray();

export const roomFor = async (wid) => ((await activeIndex()).size.get(wid) || 0) < config.watch.maxAccounts;
