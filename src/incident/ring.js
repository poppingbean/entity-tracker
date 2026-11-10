// Ring detector: finds laundering through memecoins. A confirmed case's money is paid to fresh wallets, which buy a token almost alone;
// the token's own price then "pays" the attacker (or the creator) with money that looks like trading proceeds.
//   hops 1-3: who the case's accounts paid in NEAR (>= minNear, the biggest few per hop; hubs and exchanges never count: they link nothing, docs/ontology-design.md 5.3)
//   tokens those wallets bought (a pool paid them the token), then who else bought each token
//   a token where >= minLinked linked wallets are >= minShare of its buyers is a ring
// It only PROPOSES (`ring_proposals` + an alert). Flags change what other people see, so an operator approves:
// `node src/cli.js ring-approve <id>` runs case-add with the proposal as its plan. A creator is only ever "suspected".
import { col } from '../db.js';
import { info } from '../log.js';
import { raise } from '../alerts/store.js';
import { accountRows, fetchTxs } from '../near/indexer.js';
import { classOf } from '../ontology/sync.js';
import { isKnownQuote } from '../near/quotes.js';
import { addToCase } from './caseadd.js';

export const RING = { minNear: 100, minLinked: 2, minShare: 0.8, seedsMax: 40, hops: 3, perHop: 40, perAccount: 200, tokenTxs: 400, tokensMax: 12 };
const WATCH = new Set(['attacker', 'accomplice', 'sub_account', 'intents_account', 'cash_out_wallet']);
const skip = (a) => !a || /^(mint|burn|intents|chain|nft):/.test(a) || classOf(a).cuts_links;

/** Pure: who `seeds` paid in NEAR (decoded txs, `inflows`), summed per receiver, with the first transfer as evidence. */
export function paidBy(txs, seeds, { min = RING.minNear, exclude = new Set() } = {}) {
  const out = new Map();
  for (const t of txs) for (const f of t.inflows) {
    if (!seeds.has(f.from) || seeds.has(f.to) || exclude.has(f.to) || skip(f.to) || f.near < 0.0001) continue;
    const e = out.get(`${f.from}>${f.to}`) || { from: f.from, to: f.to, near: 0, n: 0, tx: t.hash, ts: t.ts };
    e.near += f.near; e.n++; out.set(`${f.from}>${f.to}`, e);
  }
  return [...out.values()].filter((e) => e.near >= min).map((e) => ({ ...e, near: Math.round(e.near * 100) / 100 }));
}

/** Pure: tokens `wallet` bought in these txs: it signed, and a pool paid it the token (not a mint, not wNEAR or a quote token). */
export function boughtBy(txs, wallet) {
  const out = new Set();
  for (const t of txs) if (t.signer === wallet) for (const e of t.events) {
    if (e.standard !== 'nep141' || e.event !== 'ft_transfer' || e.executor === 'wrap.near' || isKnownQuote(e.executor)) continue;
    for (const d of e.data || []) if (d.new_owner_id === wallet && d.old_owner_id !== wallet) out.add(e.executor);
  }
  return out;
}

/** Pure: the accounts that bought a token, from the token contract's own transactions (signer was paid the token). */
export function buyersOf(token, txs) {
  const out = new Set();
  for (const t of txs) for (const e of t.events) if (e.standard === 'nep141' && e.event === 'ft_transfer' && e.executor === token) for (const d of e.data || []) if (d.new_owner_id === t.signer && d.old_owner_id !== t.signer) out.add(t.signer);
  return out;
}

/** Pure: how much of a token's buying is by linked wallets (the creator is left out). */
export function shareOf(buyers, linked, creator = null) {
  const all = [...buyers].filter((b) => b !== creator);
  const l = all.filter((b) => linked.has(b));
  return { linked: l.length, total: all.length, share: all.length ? l.length / all.length : 0 };
}

const txsOf = async (acc, n, cache) => {
  if (!cache.has(acc)) { const { rows } = await accountRows(acc, { desc: true, maxRows: n }); cache.set(acc, await fetchTxs(rows.map((r) => r.hash))); }
  return cache.get(acc);
};

/** Look at one confirmed case. Returns { proposals, edges, linked } (nothing is stored). */
export async function scanCase(inc, { log = () => {} } = {}) {
  const cache = new Map();
  const caseSet = new Set((inc.accounts || []).map((a) => a.account));
  let frontier = new Set((inc.accounts || []).filter((a) => WATCH.has(a.role)).slice(0, RING.seedsMax).map((a) => a.account));
  const edges = [], linked = new Set();
  for (let hop = 0; hop < RING.hops && frontier.size; hop++) {
    const txs = [];
    for (const s of frontier) txs.push(...await txsOf(s, RING.perAccount, cache));
    const found = paidBy(txs, frontier, { exclude: new Set([...caseSet, ...linked]) }).sort((a, b) => b.near - a.near).slice(0, RING.perHop); // the biggest payments: dust is noise
    edges.push(...found);
    frontier = new Set(found.map((e) => e.to));
    frontier.forEach((a) => linked.add(a));
  }
  log(`${inc._id}: ${linked.size} wallets paid by the case`);
  const mine = new Map(); // token -> linked wallets that bought it
  for (const w of linked) for (const tok of boughtBy(await txsOf(w, RING.perAccount, cache), w)) { if (!mine.has(tok)) mine.set(tok, new Set()); mine.get(tok).add(w); }
  const proposals = [];
  log(`tokens bought by linked wallets: ${[...mine].map(([k, s]) => `${k}=${s.size}`).join(' ')}`);
  for (const [token, set] of [...mine].filter(([, s]) => s.size >= RING.minLinked).slice(0, RING.tokensMax)) {
    const txs = await txsOf(token, RING.tokenTxs, cache);
    const first = await accountRows(token, { desc: false, maxRows: 5 }); // the creating transaction is the oldest
    const creator = (await fetchTxs(first.rows.map((r) => r.hash))).find((t) => t.calls.some((c) => /create_token/.test(c.method)))?.signer || null;
    const s = shareOf(buyersOf(token, txs), linked, creator);
    log(`${token}: ${s.linked}/${s.total} buyers linked (${s.share.toFixed(2)})`);
    if (s.linked >= RING.minLinked && s.share >= RING.minShare) proposals.push({ token, creator, ...s, buyers: [...set] });
  }
  return { proposals, edges, linked: [...linked] };
}

/** Store and announce what a scan found. One proposal per case and token; an approved or rejected one is left alone. */
export async function proposeRings(inc, found) {
  let n = 0;
  for (const p of found.proposals) {
    const _id = `ring:${inc._id.slice(4, 16)}:${p.token}`;
    const hubs = new Set(found.edges.filter((e) => p.buyers.includes(e.to)).map((e) => e.from));
    const plan = {
      name: `ring-${inc._id.slice(4, 12)}-${p.token.split('.')[0]}`,
      accounts: [...new Set([...hubs, ...p.buyers])].map((account) => ({ account, role: 'cash_out_wallet', why: `${p.buyers.includes(account) ? 'bought' : 'paid the buyers of'} ${p.token}; paid by the case's wallets` })),
      edges: found.edges.filter((e) => p.buyers.includes(e.to)),
      suspected: p.creator ? [{ account: p.creator, token: p.token, why: `created ${p.token}, ${Math.round(p.share * 100)}% bought by wallets paid by the case` }] : [],
      blacklist: p.creator ? [{ account: p.creator, token: p.token, why: `created ${p.token} (laundering ring)` }] : [],
    };
    const r = await col('ring_proposals').updateOne({ _id }, { $setOnInsert: { _id, case: inc._id, token: p.token, status: 'open', ts: Date.now() }, $set: { share: p.share, linked: p.linked, total: p.total, creator: p.creator, plan, updated_ts: Date.now() } }, { upsert: true });
    if (r.upsertedCount) {
      n++;
      await raise(`ring:${_id}`, { type: 'incident', severity: 'high', title: `Possible laundering ring: ${p.token}`, text: `${p.linked} of ${p.total} buyers of ${p.token} (${Math.round(p.share * 100)}%) were paid by wallets of a confirmed hack. Review, then approve: node src/cli.js ring-approve ${_id}`, url: `/firewall/${encodeURIComponent(inc._id)}`, related: { wallets: p.buyers.slice(0, 20) }, data: { ring: _id, case: inc._id } });
    }
  }
  return n;
}

/** One worker pass: confirmed cases, a few at a time, the longest-unscanned first. */
export async function ringPass({ max = 2, log = () => {} } = {}) {
  const cases = await col('incidents').find({ status: 'confirmed' }, { projection: { accounts: 1, target: 1 } }).sort({ ring_scan_ts: 1 }).limit(max).toArray();
  let total = 0;
  for (const c of cases) {
    const found = await scanCase(c, { log }).catch((e) => { log(`ring scan ${c._id}: ${e.message}`); return null; });
    await col('incidents').updateOne({ _id: c._id }, { $set: { ring_scan_ts: Date.now() } });
    if (found) total += await proposeRings(c, found);
  }
  if (total) info(`ring detector: ${total} new proposal(s)`);
  return total;
}

/** An operator approves a proposal: case-add runs with its plan. `dry` only reads and builds. */
export async function approveRing(id, { dry = false, log = () => {} } = {}) {
  const p = await col('ring_proposals').findOne({ _id: id });
  if (!p) throw new Error(`no proposal ${id}`);
  if (p.status !== 'open' && !dry) throw new Error(`${id} is already ${p.status}`);
  const r = await addToCase(p.case, p.plan, { dry, log });
  if (!dry) await col('ring_proposals').updateOne({ _id: id }, { $set: { status: 'approved', approved_ts: Date.now() } });
  return r;
}
export const rejectRing = (id, reason) => col('ring_proposals').updateOne({ _id: id }, { $set: { status: 'rejected', reason: reason || null, rejected_ts: Date.now() } });
