// Money watch rules (docs/money-watch-design.md). Pure: no database, no network, so every decision can be tested on made-up flows.
import { config } from '../config.js';

/** Statuses that are still watched: a suspicious watch (escalated to an incident) keeps being followed and reviewed. */
export const OPEN = ['watching', 'suspicious'];
const SKIP_TOKEN = /^(nft|mint|burn):/;

/**
 * The real movements among one batch of flows. Each flow carries `usd` (its value, whatever the token). A movement is one transfer worth at
 * least `min` that is not: a mint / burn / NFT; to or from an account `skipFrom` / `skipTo` say is not a person's money (pass-through accounts,
 * protocols as receivers, Intents solvers and bridges); or a swap leg (the receiver also gave away something of comparable value in the same
 * transaction: it traded, it did not receive).
 */
export function movementsOf(flows, { min = config.watch.minUsd, skipFrom = () => false, skipTo = () => false } = {}) {
  const byTx = new Map();
  for (const f of flows) (byTx.get(f.tx) || byTx.set(f.tx, []).get(f.tx)).push(f);
  const out = [], seen = new Set();
  for (const f of flows) {
    if (!(f.usd >= min) || SKIP_TOKEN.test(f.token) || f.kind === 'mint' || f.kind === 'burn' || f.from === f.to) continue;
    if (skipFrom(f.from) || skipTo(f.to)) continue;
    if ((byTx.get(f.tx) || []).some((g) => g !== f && g.from === f.to && g.usd >= 0.5 * f.usd)) continue; // a swap leg
    const key = [f.tx, f.from, f.to, f.token, f.raw].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Where did the money come from (step 1)? `o`:
 *   payer: 'staking' | 'farm' | 'lending' | 'amm' | 'exchange' | 'service' | 'wallet' | 'unknown'
 *   own_funds: the receiver had paid into that protocol before (ownfunds.js); earlier_transfers: earlier payments from the payer to the receiver
 *   receiver_age_days, payer_age_days, receiver_txs: how long they have been active and how busy (null = unknown)
 *   exchange_unusual: the payer is an exchange hot wallet and the amount is unusual for it (exchanges.js)
 * Returns { class, lean: 'normal' | 'low' | 'high', reasons[] }: `normal` is closed by the rules alone; `low` / `high` go to the reviewer
 * with that much suspicion.
 */
export function classifyOrigin(o, { freshHours = config.incidents.freshHours } = {}) {
  const protocol = ['staking', 'farm', 'lending', 'amm'].includes(o.payer);
  if (protocol && o.own_funds) return { class: 'own_funds_withdrawal', lean: 'normal', reasons: [`the receiver had paid into this ${o.payer} contract before`] };
  if ((o.earlier_transfers || 0) >= 3) return { class: 'routine_relationship', lean: 'normal', reasons: [`${o.earlier_transfers} earlier payments from the same account to the receiver`] };
  if (o.payer === 'exchange') {
    if (o.exchange_unusual) return { class: 'unusual_exchange_outflow', lean: 'high', reasons: ['an exchange wallet paid far more than it usually pays one account'] };
    if ((o.receiver_age_days ?? 0) >= 30) return { class: 'exchange_withdrawal', lean: 'normal', reasons: ['an exchange paying an account that is more than 30 days old, in an ordinary amount'] };
    return { class: 'exchange_to_new_account', lean: 'high', reasons: ['an exchange paying a new account'] };
  }
  const fresh = o.receiver_age_days != null && o.receiver_age_days * 24 < freshHours;
  if (fresh) return { class: 'fresh_receiver', lean: 'high', reasons: [`the receiver is ${Math.max(0, Math.round(o.receiver_age_days * 24))} hours old`] };
  if (protocol) return { class: 'protocol_payout', lean: 'low', reasons: [`paid out by a ${o.payer} contract; the receiver has no earlier deposit in it`] };
  const old = (o.receiver_age_days ?? 0) >= 180 && (o.payer_age_days ?? 0) >= 180 && (o.receiver_txs ?? 0) >= 100;
  if (old) return { class: 'established_accounts', lean: 'low', reasons: ['both accounts are old and active; they have no earlier payments between them'] };
  return { class: 'no_history', lean: 'low', reasons: ['no earlier relationship between the two accounts, and not enough history to call them established'] };
}

/** The rules' own verdict from the origin: `normal` when the origin class is one the rules close, otherwise null (the reviewer decides). */
export const rulesVerdict = (origin) => (origin.lean === 'normal' ? { verdict: 'normal', by: 'rules', reasons: origin.reasons, what_it_is: origin.class.replace(/_/g, ' ') } : null);

/**
 * What a move out of a watched account does. `entry`: { in_usd, out_usd, depth } (what the account received from the case and has sent on);
 * `move.usd`; `triggerUsd` the opening movement. `hasRoom`: the case may still add an account.
 * Returns { follow, why, sender: 'keep' | 'drop', depth } (`follow` false = recorded as a move, the receiver is not watched).
 * A partial send keeps the sender; only when (almost) all of what it received has gone does it stop being watched.
 */
export function followStep(entry, move, { triggerUsd, hasRoom = true, W = config.watch } = {}) {
  const floor = Math.max(W.followMinUsd, W.followShare * (triggerUsd || 0));
  const out = (entry.out_usd || 0) + move.usd, left = (entry.in_usd || 0) - out;
  const sender = left < Math.max(W.dustUsd, W.dustShare * (entry.in_usd || 0)) ? 'drop' : 'keep';
  if (move.usd < floor) return { follow: false, why: 'below the follow floor', sender: 'keep', depth: entry.depth };
  if ((entry.depth || 0) + 1 > W.maxDepth) return { follow: false, why: 'depth limit', sender, depth: entry.depth };
  if (!hasRoom) return { follow: false, why: 'account limit', sender, depth: entry.depth };
  return { follow: true, why: null, sender, depth: (entry.depth || 0) + 1 };
}

/** A watch with no move for `maxIdleDays` is closed as normal (idle). */
export const isIdle = (watch, now = Date.now(), W = config.watch) => now - (watch.last_move_ts || watch.opened_ts || now) > W.maxIdleDays * 86400e3;

/** Is it time to review this watch again after new moves? (at most once per gap; only when enough moved or a new exit appeared) */
export function reviewDue(watch, now = Date.now(), W = config.watch) {
  if (!OPEN.includes(watch.status)) return false;
  if (!watch.last_review_ts) return true;
  if (now - watch.last_review_ts < W.reviewGapMinutes * 60e3) return false;
  return (watch.moved_since_review_usd || 0) >= W.reviewMinUsd || !!watch.new_exit;
}

/**
 * What a review does, from the rules' origin, the AI's answer (or null: off, budget spent, failed) and the watch.
 * Returns { action: 'normal' | 'keep' | 'suspicious', by: 'rules' | 'ai', why }.
 *   - the rules close what they can (own funds, routine relationship, an exchange in an ordinary amount) unless a person reported the address;
 *   - the AI closes a watch only with medium or high confidence, never one a person reported with a source, and never one whose incident is still open;
 *   - the AI can escalate (medium or high confidence); nothing here confirms a hack: only a person or a public report does.
 */
export function decide(watch, origin, ai, { incidentOpen = false } = {}) {
  const reported = (watch.reports || []).length > 0;
  const rv = rulesVerdict(origin);
  if (rv && !reported && watch.status === 'watching') return { action: 'normal', by: 'rules', why: rv.what_it_is };
  if (!ai) return { action: 'keep', by: 'rules', why: 'no AI verdict (off, budget spent or failed): the watch goes on' };
  const sure = ai.confidence === 'high' || ai.confidence === 'medium';
  if (ai.verdict === 'suspicious' && sure) return { action: 'suspicious', by: 'ai', why: ai.what_it_is || 'suspicious movement' };
  if (ai.verdict === 'normal' && sure && !(watch.reports || []).some((r) => r.source) && !incidentOpen) return { action: 'normal', by: 'ai', why: ai.what_it_is || 'normal activity' };
  return { action: 'keep', by: 'ai', why: ai.what_it_is || 'too early to tell' };
}
