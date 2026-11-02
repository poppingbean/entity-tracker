// Live detection: a hack in progress, from the blocks the deploy watcher already reads. Every token / NEAR flow out of a DeFi protocol
// (pools, lending, liquid staking, order books, farms, bridges, and every contract the audit typed as one of those) is summed per receiver
// over a 30-minute window. A receiver is a suspect when it took a lot for little in return AND looks like an attacker:
//   fresh            its account is younger than INCIDENT_FRESH_HOURS
//   fake tokens      it deployed token contracts of its own in the last day (the Veax / Rhea pattern: fake tokens paired into real pools)
//   many tokens      several different tokens pulled from one protocol in one transaction
// A suspect raises an alert at once and is queued for a full trace (which confirms it, writes it up and flags the accounts).
import { col } from '../db.js';
import { config } from '../config.js';
import { info } from '../log.js';
import { raise } from '../alerts/store.js';
import { txIndexer } from '../near/rpc.js';
import { flowsOfReceipt, NEAR } from './flows.js';
import { valueOf } from './prices.js';
import { enqueueIncident } from './service.js';

// well-known protocols (the audit adds every contract it types as one of PROTOCOL_ROLES)
export const PROTOCOLS = new Set(['veax.near', 'v2.ref-finance.near', 'dclv2.ref-labs.near', 'contract.main.burrow.near', 'meta-pool.near', 'linear-protocol.near', 'lst.rhealab.near',
  'dex.intear.near', 'app.ref-finance.near', 'boost.ref-labs.near', 'v1.orderbook.near', 'spot.spin-fi.near', 'v2_0_2.perp.spin-fi.near', 'tonic.near', 'v1.jumbo_exchange.near',
  'xtoken.ref-finance.near', 'storage.herewallet.near', 'harvest-moon.near', 'nearlytrade.near', 'launchpad.justhoot.near', 'v2-launchpad.justhoot.near', 'meme-cooking.near', 'tkn.near',
  'pembrock.near', 'v1.pembrock.near', 'contract.ref-finance.near', 'factory.bridge.near', 'omft.near', 'aurora', 'token.sweat', 'staker1.msig1.trufin.near']);
export const PROTOCOL_ROLES = ['amm', 'lending', 'liquid_staking', 'orderbook', 'farm', 'bridge'];
// accounts that receive from protocols all day as part of normal operation
const ROUTERS = new Set(['wrap.near', 'intents.near', 'aggregatedex.near', 'v2.ref-finance.near', 'dclv2.ref-labs.near', 'dex.intear.near', 'meteor-relayer.near', 'relay.aurora', 'aurora', 'near', 'system']);

let protoCache = { ts: 0, set: PROTOCOLS };
async function protocols() {
  if (Date.now() - protoCache.ts < 600e3) return protoCache.set;
  const typed = await col('audits').find({ 'auto.role': { $in: PROTOCOL_ROLES } }, { projection: { _id: 1 } }).limit(5000).toArray().catch(() => []);
  protoCache = { ts: Date.now(), set: new Set([...PROTOCOLS, ...typed.map((d) => d._id)]) };
  return protoCache.set;
}

/** Flows out of protocols in one neardata block (pure apart from the protocol set). */
export function protocolOutflows(b, protos) {
  const out = [], ts = Number(b.block.header.timestamp_nanosec) / 1e6, height = b.block.header.height;
  for (const s of b.shards || []) for (const ro of s.receipt_execution_outcomes || []) {
    for (const f of flowsOfReceipt(ro, { tx: ro.tx_hash || null, height, ts })) {
      if (protos.has(f.from) && !ROUTERS.has(f.to) && !protos.has(f.to) && f.kind !== 'mint' && !/^nft:|^intents:/.test(f.token)) out.push({ ...f, protocol: f.from, signer: ro.receipt?.receipt?.Action?.signer_id || null });
    }
  }
  return out;
}

const WINDOW_MS = 30 * 60e3;
const win = new Map(); // receiver|protocol -> { receiver, protocol, flows: [], usd, first, last, txs:Set, tokens:Set, raised }
/** Add a batch of blocks' outflows to the window and raise / queue what crossed the line. Returns the suspects raised. */
export async function scanBlocks(blocks) {
  const C = config.incidents;
  if (!C.enabled || !blocks.length) return [];
  const protos = await protocols();
  for (const b of blocks) for (const f of protocolOutflows(b, protos)) {
    const k = `${f.to}|${f.protocol}`, w = win.get(k) || { receiver: f.to, protocol: f.protocol, flows: [], usd: 0, first: f.ts, last: f.ts, txs: new Set(), tokens: new Set(), raised: false };
    const v = await valueOf(f.token, f.raw);
    w.flows.push({ ...f, usd: v.usd }); w.usd += v.usd || 0; w.last = f.ts; w.txs.add(f.tx); w.tokens.add(f.token);
    win.set(k, w);
  }
  const now = Date.now(), raised = [];
  for (const [k, w] of win) {
    if (now - w.last > WINDOW_MS) { win.delete(k); continue; }
    if (w.raised === true || w.usd < C.minUsd || (w.raised === 'checked' && w.usd < w.checked_usd * 2)) continue;
    const s = await suspicion(w);
    if (!s.suspect) { w.raised = 'checked'; w.checked_usd = w.usd; continue; }
    w.raised = true;
    const detected = { ts: now, protocol: w.protocol, receiver: w.receiver, usd: Math.round(w.usd), txs: [...w.txs].slice(0, 10), tokens: [...w.tokens], reasons: s.reasons };
    await col('incident_detections').updateOne({ _id: `${w.receiver}|${w.protocol}|${Math.floor(w.first / 3600e3)}` }, { $set: detected }, { upsert: true });
    await raise(`drain:${w.receiver}:${w.protocol}:${Math.floor(w.first / 3600e3)}`, { type: 'drain_suspected', severity: 'high', title: `Possible exploit in progress: ${w.receiver} took ~$${Math.round(w.usd).toLocaleString('en-US')} from ${w.protocol}`,
      text: `${s.reasons.join('; ')}. Tracing it now.`, url: `/firewall?q=${encodeURIComponent(w.receiver)}`, related: { wallets: [w.receiver] }, data: detected });
    await enqueueIncident({ account: w.receiver }, { reason: 'detected', detected });
    info(`incident suspected: ${w.receiver} took $${Math.round(w.usd)} from ${w.protocol} (${s.reasons.join('; ')})`);
    raised.push(detected);
  }
  return raised;
}

/** Does this receiver look like an attacker? (account age, own fresh token contracts, many tokens in one go) */
async function suspicion(w) {
  const C = config.incidents, reasons = [];
  const [first, fakes] = await Promise.all([
    txIndexer('/v0/account', { account_id: w.receiver, limit: 1, desc: false }).then((j) => j?.account_txs?.[0]?.tx_block_timestamp).catch(() => null),
    col('contract_deploys').find({ $or: [{ by: w.receiver }, { signer: w.receiver }], ts: { $gt: Date.now() - 86400e3 } }, { projection: { account: 1 } }).limit(20).toArray().catch(() => []),
  ]);
  const ageH = first ? (Date.now() - Number(first) / 1e6) / 3600e3 : null;
  if (ageH != null && ageH < C.freshHours) reasons.push(`the account is ${ageH < 1 ? Math.round(ageH * 60) + ' minutes' : ageH.toFixed(1) + ' hours'} old`);
  const ownTokens = fakes.filter((d) => d.account !== w.receiver);
  if (ownTokens.length) reasons.push(`it deployed ${ownTokens.length} contract${ownTokens.length > 1 ? 's' : ''} of its own in the last day (${ownTokens.slice(0, 4).map((d) => d.account).join(', ')})`);
  const multi = [...w.tokens].length >= 3 && w.txs.size <= 3;
  if (multi) reasons.push(`${w.tokens.size} different tokens pulled in ${w.txs.size} transaction${w.txs.size > 1 ? 's' : ''}`);
  reasons.unshift(`took ~$${Math.round(w.usd).toLocaleString('en-US')} from ${w.protocol} within ${Math.max(1, Math.round((w.last - w.first) / 60e3))} min`);
  const suspect = (ageH != null && ageH < C.freshHours) || ownTokens.length > 0 || (multi && w.usd >= C.minUsd * 3) || w.usd >= C.alwaysUsd;
  return { suspect, reasons };
}
export { NEAR };
