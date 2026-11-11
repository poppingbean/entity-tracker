// Money watch, the block scan (docs/money-watch-design.md sections 2 and 5): called with the same blocks the deploy watcher and the hack detector read.
//   - a movement worth WATCH_MIN_USD or more (movementsOf) opens a watch; the work of looking back and judging it is left to the review lane (review.js);
//   - a move out of a watched account is recorded; when it is large enough the receiver is watched too (a partial send keeps the sender, a full send drops it);
//   - a branch ends at an exit: an exchange, a swap out to another chain (1Click), a DeFi contract deposit, a pass-through account.
import { config } from '../config.js';
import { info } from '../log.js';
import { flowsOfReceipt } from '../incident/flows.js';
import { valueOf } from '../incident/prices.js';
import { PASS_THROUGH } from '../incident/trace.js';
import { protocols } from '../incident/detect.js';
import { oneClickSwap } from '../incident/oneclick.js';
import { builtinLabel } from '../labels.js';
import { viewAccount } from '../audit/rpc.js';
import { reads, passThrough } from '../ontology/sync.js';
import { whatIsMany } from '../ontology/index.js';
import { movementsOf, followStep } from './rules.js';
import { activeIndex, openWatch, recordMove, roomFor } from './store.js';

const PSEUDO = /^(mint|burn|intents|chain):/;
/** Passes money through (never a person's money): the ontology's one rule, or the old list. */
export const isPass = (id) => PSEUDO.test(id) || (reads('pass_through') ? passThrough(id) : PASS_THROUGH.has(id));
const NOT_A_PERSON = new Set(['contract', 'service', 'exchange', 'system']);
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
  if (c?.top === 'exchange') return { kind: 'exchange', label: c.label || null };
  if (c && NOT_A_PERSON.has(c.top)) return { kind: 'protocol_deposit', label: c.class };
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
  for (const f of flows) { const v = await valueOf(f.token, f.raw).catch(() => ({})); f.usd = v.usd || 0; f.symbol = v.symbol || null; f.amount = v.amount ?? null; }
  return flows;
}

/** The movements among flows that open a watch: the pure rule, then the receivers that are people's accounts. */
export async function openingMovements(flows, protos) {
  const W = config.watch, cand = movementsOf(flows, { min: W.minUsd, skipFrom: isPass, skipTo: (a) => isPass(a) || protos.has(a) });
  if (!cand.length) return new Set();
  const cls = await whatIsMany([...new Set(cand.map((f) => f.to))]).catch(() => new Map());
  return new Set(cand.filter((f) => !NOT_A_PERSON.has(cls.get(f.to)?.top) && builtinLabel(f.to)?.type !== 'exchange'));
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
      if (!(f.usd >= W.followMinUsd)) continue;
      let exit;
      for (const [wid, ent] of [...entries]) {
        const step = followStep(ent, f, { triggerUsd: ent.trigger_usd, hasRoom: await roomFor(wid), W });
        if (step.why === 'below the follow floor') continue;
        if (exit === undefined) exit = await exitOf(f.to, protos);
        let st = step;
        if (step.follow && !exit) { // an unknown receiver: is it a contract (a deposit into something)?
          exit = await exitOf(f.to, protos, { checkContract: true });
        }
        if (exit) st = { ...step, follow: false, why: `exit: ${exit.kind}` };
        if (await recordMove(wid, f, st, exit)) { out.moves++; info(`watch ${wid}: ${f.from.slice(0, 16)} → ${f.to.slice(0, 16)} ~$${Math.round(f.usd)}${exit ? ` (${exit.kind})` : st.follow ? ' (followed)' : ` (${st.why})`}`); }
      }
      continue;
    }
    if (opening.has(f)) {
      const w = await openWatch(f);
      if (w) { out.opened++; info(`watch opened: ${f.from.slice(0, 16)} → ${f.to.slice(0, 16)} ~$${Math.round(f.usd)} ${f.symbol || f.token}`); }
    }
  }
  return out;
}
