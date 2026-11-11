// Money watch, the block scan (docs/money-watch-design.md sections 2 and 5): called with the same blocks the deploy watcher and the hack detector read.
//   - a movement worth WATCH_MIN_USD or more (movementsOf) opens a watch; the work of looking back and judging it is left to the review lane (review.js);
//   - a move out of a watched account is recorded; when it is large enough the receiver is watched too (a partial send keeps the sender, a full send drops it);
//   - a branch ends at an exit: an exchange, a swap out to another chain (1Click), a DeFi contract deposit, a pass-through account.
import { config } from '../config.js';
import { info } from '../log.js';
import { flowsOfReceipt } from '../incident/flows.js';
import { usdPrice, tokenMeta, units } from '../incident/prices.js';
import { PASS_THROUGH } from '../incident/trace.js';
import { protocols } from '../incident/detect.js';
import { oneClickSwap } from '../incident/oneclick.js';
import { builtinLabel } from '../labels.js';
import { viewAccount } from '../audit/rpc.js';
import { reads, passThrough } from '../ontology/sync.js';
import { whatIsMany } from '../ontology/index.js';
import { movementsOf, followStep } from './rules.js';
import { activeIndex, openWatch, recordMove, recordInbound, pendingOf, roomFor } from './store.js';

const PSEUDO = /^(mint|burn|intents|chain):/;
/** Passes money through (never a person's money): the ontology's one rule, or the old list. */
export const isPass = (id) => PSEUDO.test(id) || (reads('pass_through') ? passThrough(id) : PASS_THROUGH.has(id));
const NOT_A_PERSON = new Set(['contract', 'service', 'exchange', 'system']);
/** An exchange the ontology knows only because it is busy (a behaviour fact: no sweep, no hand entry, no name) is not proof (WP-08): it is followed. */
export const busyOnly = (c) => !!c && c.top === 'exchange' && c.source === 'behaviour' && !c.operator;
/** Not a person's account: a contract, a service, the system, or a proven exchange. */
export const notAPerson = (c) => !!c && NOT_A_PERSON.has(c.top) && !busyOnly(c);
const EMPTY_CODE = '11111111111111111111111111111111';

/** Where does a branch end when it reaches `to`? An exit object, or null when the receiver looks like an ordinary account. */
export async function exitOf(to, protos, { checkContract = false } = {}) {
  if (isPass(to)) return { kind: 'router' };
  if (/^[0-9a-f]{64}$/.test(to)) {
    const sw = await oneClickSwap(to).catch(() => null);
    if (sw) return { kind: 'swap_out', chain: sw.chain, asset: sw.asset, recipient: sw.recipient || null };
  }
  const lab = builtinLabel(to);
  if (lab?.type === 'exchange') return { kind: 'exchange', label: lab.label };
  if (protos.has(to)) return { kind: 'protocol_deposit', label: to };
  const c = (await whatIsMany([to]).catch(() => new Map())).get(to);
  if (c?.top === 'exchange' && !busyOnly(c)) return { kind: 'exchange', label: c.label || null };
  if (notAPerson(c)) return { kind: 'protocol_deposit', label: c.class };
  if (checkContract) {
    const st = await viewAccount(to).catch(() => null);
    if (st && (st.code_hash !== EMPTY_CODE || st.global_contract_hash || st.global_contract_account_id)) return { kind: 'protocol_deposit', label: 'a contract' };
  }
  return null;
}

/** Decode and value the flows of a batch of blocks (mints, burns and NFTs left out). */
export async function flowsOfBlocks(blocks) {
  const flows = [];
  for (const b of blocks) {
    const height = b.block.header.height, ts = Number(b.block.header.timestamp_nanosec) / 1e6;
    for (const s of b.shards || []) for (const ro of s.receipt_execution_outcomes || []) {
      for (const f of flowsOfReceipt(ro, { tx: ro.tx_hash || null, height, ts })) {
        if (f.kind === 'mint' || f.kind === 'burn' || /^(nft|mint|burn):/.test(f.token)) continue;
        flows.push(f);
      }
    }
  }
  // each token priced once per batch, in parallel; a token with no price today is worth 0 here and its metadata is never fetched
  // (most flows of a busy block are spam or unpriced tokens: no RPC for them)
  const px = new Map(await Promise.all([...new Set(flows.map((f) => f.token))].map(async (t) => {
    const p = await usdPrice(t).catch(() => null);
    return [t, p ? { p, m: await tokenMeta(t).catch(() => null) } : null];
  })));
  for (const f of flows) {
    const x = px.get(f.token), amount = x?.m ? units(String(f.raw), x.m.decimals) : null;
    f.usd = amount != null ? amount * x.p : 0; f.symbol = x?.m?.symbol || null; f.amount = amount;
  }
  return flows;
}

/** The movements among flows that open a watch: the pure rule, then the receivers that are people's accounts. */
export async function openingMovements(flows, protos) {
  const W = config.watch, cand = movementsOf(flows, { min: W.minUsd, skipFrom: isPass, skipTo: (a) => isPass(a) || protos.has(a) });
  if (!cand.length) return new Set();
  const cls = await whatIsMany([...new Set(cand.map((f) => f.to))]).catch(() => new Map());
  return new Set(cand.filter((f) => !notAPerson(cls.get(f.to)) && builtinLabel(f.to)?.type !== 'exchange'));
}

export async function scanWatches(blocks) {
  const W = config.watch, out = { opened: 0, moves: 0 };
  if (!W.enabled || !blocks.length) return out;
  const idx = await activeIndex(), protos = await protocols(), flows = await flowsOfBlocks(blocks);
  if (!flows.length) return out;
  const opening = await openingMovements(flows, protos);
  for (const f of flows) {
    const entries = idx.map.get(f.from);
    if (entries?.size) {
      // every move worth recordMinUsd counts (followed or not): small transfers still empty the sender, and splits to one receiver are summed
      if (!(f.usd >= W.recordMinUsd)) continue;
      let exit;
      for (const [wid, ent] of [...entries]) {
        const pendingUsd = f.usd < W.followCapUsd ? await pendingOf(wid, f.to) : 0;
        const step = followStep(ent, f, { triggerUsd: ent.trigger_usd, hasRoom: await roomFor(wid), pendingUsd, W });
        let st = { ...step, pendingUsd }, ex = null;
        if (step.why !== 'below the follow floor') {
          if (exit === undefined) exit = await exitOf(f.to, protos);
          if (step.follow && !exit) exit = await exitOf(f.to, protos, { checkContract: true }); // an unknown receiver: is it a contract (a deposit into something)?
          ex = exit || null;
          if (ex) st = { ...st, follow: false, why: `exit: ${ex.kind}` };
        }
        if (await recordMove(wid, f, st, ex)) {
          out.moves++;
          if (st.follow || ex || f.usd >= W.followMinUsd) info(`watch ${wid}: ${f.from.slice(0, 16)} → ${f.to.slice(0, 16)} ~$${Math.round(f.usd)}${ex ? ` (${ex.kind})` : st.follow ? ' (followed)' : ` (${st.why})`}`);
        }
      }
      continue;
    }
    // money into a watched account from outside the watch: evidence for the reviewer (the reverse link), never a new watched account
    const into = idx.map.get(f.to);
    if (into?.size && f.usd >= W.followMinUsd && !isPass(f.from)) {
      for (const wid of into.keys()) if (await recordInbound(wid, f)) out.moves++;
      continue;
    }
    if (opening.has(f)) {
      const w = await openWatch(f);
      if (w) { out.opened++; info(`watch opened: ${f.from.slice(0, 16)} → ${f.to.slice(0, 16)} ~$${Math.round(f.usd)} ${f.symbol || f.token}`); }
    }
  }
  return out;
}
