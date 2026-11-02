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
import { exchangeWalletMap, unusualOutflow } from './exchanges.js';
import { isPrivate } from './cases.js';
import { oneClickSwap } from './oneclick.js';
import { viewAccount } from '../audit/rpc.js';
import { builtinLabel } from '../labels.js';

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

// ---- exchanges: drains of hot wallets, and key changes on them (the registry and baselines are in exchanges.js)
/** NEAR and token flows out of exchange wallets in one neardata block, and key changes on them (pure apart from the registry). */
export function exchangeEvents(b, wallets) {
  const flows = [], keys = [], ts = Number(b.block.header.timestamp_nanosec) / 1e6, height = b.block.header.height;
  for (const s of b.shards || []) for (const ro of s.receipt_execution_outcomes || []) {
    const rc = ro.receipt, act = rc?.receipt?.Action;
    if (act && wallets.has(rc.receiver_id) && !ro.execution_outcome?.outcome?.status?.Failure) for (const a of act.actions || []) {
      if (a?.AddKey || a?.DeleteKey) keys.push({ wallet: rc.receiver_id, kind: a.AddKey ? 'added' : 'removed', full: a.AddKey ? a.AddKey.access_key?.permission === 'FullAccess' : null, key: (a.AddKey || a.DeleteKey).public_key, tx: ro.tx_hash || null, ts, height, signer: act.signer_id });
    }
    for (const f of flowsOfReceipt(ro, { tx: ro.tx_hash || null, height, ts })) {
      const w = wallets.get(f.from);
      if (w?.kind === 'hot' && !wallets.has(f.to) && !ROUTERS.has(f.to) && !/^(nft|intents|mint|burn):/.test(f.token) && builtinLabel(f.to)?.type !== 'exchange') flows.push({ ...f, exchange: f.from, exchange_name: w.exchange || null });
    }
  }
  return { flows, keys };
}
/** Kept for tests and old callers: just the flows, from a set of hot wallets. */
export const exchangeOutflows = (b, hubs) => exchangeEvents(b, new Map([...hubs].map((h) => [h, { kind: 'hot' }]))).flows;

const recentX = new Map(); // receiver -> [{ wallet, exchange, usd, ts }] in the last hour: several hot wallets paying one account
async function scanExchanges(blocks) {
  const C = config.incidents, wallets = await exchangeWalletMap();
  if (!wallets.size) return [];
  const raised = [];
  for (const b of blocks) {
    const { flows, keys } = exchangeEvents(b, wallets);
    for (const k of keys) {
      const w = wallets.get(k.wallet);
      if (k.kind === 'added' && k.full === false) continue; // an app key: routine
      await raise(`xkey:${k.wallet}:${k.key}:${k.kind}`, { type: 'exchange_key_change', severity: k.full ? 'high' : 'medium', title: `${w?.exchange || 'Exchange'} hot wallet ${k.wallet.slice(0, 12)}…: a ${k.full ? 'full-access ' : ''}key was ${k.kind}`,
        text: `Signed by ${k.signer}. Exchanges rotate keys, but an unexpected full-access key on a hot wallet is how a takeover starts: watch where its money goes next.`, url: `/firewall?q=${encodeURIComponent(k.wallet)}`, related: { wallets: [k.wallet] }, data: k, ts: k.ts });
    }
    for (const f of flows) {
      const v = await valueOf(f.token, f.raw);
      const usd = v.usd || 0;
      if (usd < C.exchangeMinUsd) continue;
      const w = wallets.get(f.exchange);
      // several hot wallets of one exchange paying the same account within an hour
      const list = (recentX.get(f.to) || []).filter((x) => f.ts - x.ts < 3600e3);
      if (!list.some((x) => x.wallet === f.exchange)) list.push({ wallet: f.exchange, exchange: w?.exchange, usd, ts: f.ts });
      recentX.set(f.to, list);
      const [first, state] = await Promise.all([txIndexer('/v0/account', { account_id: f.to, limit: 1, desc: false }).then((j) => j?.account_txs?.[0]).catch(() => null),
        f.token === NEAR ? viewAccount(f.exchange).catch(() => null) : null]);
      const ageH = first ? (f.ts - Number(first.tx_block_timestamp) / 1e6) / 3600e3 : 0; // not indexed yet: created by this transfer
      const fresh = ageH <= C.freshHours;
      const unusual = f.token === NEAR ? unusualOutflow(w, v.amount, state ? Number(BigInt(state.amount) / 10n ** 21n) / 1e3 : null) : [];
      const correlated = list.length >= 2;
      if (!((fresh && unusual.length) || (fresh && usd >= C.alwaysUsd) || (correlated && list.reduce((s, x) => s + x.usd, 0) >= C.exchangeMinUsd * 2))) continue;
      const name = w?.exchange || 'an exchange';
      const reasons = [`${name} hot wallet ${f.exchange.slice(0, 12)}… sent ~$${Math.round(usd).toLocaleString('en-US')} (${Math.round(v.amount).toLocaleString('en-US')} ${v.symbol})`,
        ageH < 0.02 ? 'to an account created by this transfer' : `to an account ${ageH < 48 ? ageH.toFixed(1) + ' hours' : Math.round(ageH / 24) + ' days'} old`, ...unusual,
        ...(correlated ? [`${list.length} hot wallets${list.every((x) => x.exchange && x.exchange === list[0].exchange) ? ` of ${list[0].exchange}` : ''} paid this account within an hour (~$${Math.round(list.reduce((s, x) => s + x.usd, 0)).toLocaleString('en-US')})`] : [])];
      const detected = { ts: Date.now(), event_ts: f.ts, protocol: f.exchange, exchange: w?.exchange || null, receiver: f.to, usd: Math.round(usd), txs: [f.tx], tokens: [f.token], reasons, kind: 'exchange', correlated: list.length };
      const key = `xdrain:${f.to}:${Math.floor(f.ts / 3600e3)}`;
      await col('incident_detections').updateOne({ _id: key }, { $set: detected }, { upsert: true });
      const sev = correlated || usd >= C.alwaysUsd ? 'high' : 'medium';
      if (await raise(key, { type: 'drain_suspected', severity: sev, title: `Possible ${name === 'an exchange' ? 'exchange' : name} hot-wallet drain: ~$${Math.round(usd).toLocaleString('en-US')} to a new account ${f.to.slice(0, 16)}…`,
        text: `${reasons.join('; ')}. Tracing it now.`, url: `/firewall?q=${encodeURIComponent(f.to)}`, related: { wallets: [f.to] }, data: detected, ts: f.ts })) {
        await enqueueIncident({ account: f.to }, { reason: 'detected', detected });
        raised.push(detected);
      }
    }
  }
  for (const [k, l] of recentX) if (!l.some((x) => Date.now() - x.ts < 3600e3)) recentX.delete(k);
  return raised;
}

// ---- stolen money on the move: every transfer out of a confirmed incident's accounts, as it happens
const FOLLOW_ROLES = new Set(['attacker', 'sub_account', 'intents_account', 'cash_out_wallet']);
let followCache = { ts: 0, map: new Map() };
/** account -> { incident, role, last_out_ts } for every confirmed incident (cached 5 minutes). */
async function followed() {
  if (Date.now() - followCache.ts < 300e3) return followCache.map;
  const docs = await col('incidents').find({ status: 'confirmed' }, { projection: { accounts: 1, 'trail.moves': 1, 'attacker.account': 1, drain: 1 } }).limit(500).toArray().catch(() => []);
  const map = new Map();
  for (const d of docs) {
    const last = new Map(); for (const m of d.trail?.moves || []) last.set(m.from, Math.max(last.get(m.from) || 0, m.ts || 0));
    for (const a of d.accounts || []) if (FOLLOW_ROLES.has(a.role) && !map.has(a.account)) map.set(a.account, { incident: d._id, role: a.role, root: d.attacker?.account, last_out_ts: last.get(a.account) || null });
  }
  const moves = await col('incident_moves').aggregate([{ $group: { _id: '$from', ts: { $max: '$ts' } } }]).toArray().catch(() => []);
  for (const m of moves) if (map.has(m._id)) map.get(m._id).last_out_ts = Math.max(map.get(m._id).last_out_ts || 0, m.ts);
  followCache = { ts: Date.now(), map };
  return map;
}
async function followStolen(blocks) {
  const C = config.incidents, map = await followed();
  if (!map.size) return [];
  const out = [], retrace = new Set();
  for (const b of blocks) for (const s of b.shards || []) for (const ro of s.receipt_execution_outcomes || []) {
    for (const f of flowsOfReceipt(ro, { tx: ro.tx_hash || null, height: b.block.header.height, ts: Number(b.block.header.timestamp_nanosec) / 1e6 })) {
      const src = map.get(f.from);
      if (!src || map.has(f.to) || /^(nft|mint|burn):/.test(f.token)) continue;
      const v = await valueOf(f.token, f.raw);
      if ((v.usd || 0) < C.followMinUsd) continue;
      const idleH = src.last_out_ts && f.ts > src.last_out_ts ? (f.ts - src.last_out_ts) / 3600e3 : null; // how long the money sat still
      const swap = /^[0-9a-f]{64}$/.test(f.to) ? await oneClickSwap(f.to).catch(() => null) : null;
      const where = swap ? `a 1Click swap to ${swap.asset} on ${swap.chain}${swap.recipient ? ` (${swap.recipient})` : ''}` : builtinLabel(f.to)?.label || (ROUTERS.has(f.to) ? f.to : `${f.to.slice(0, 16)}…`);
      const move = { _id: `${f.tx}:${f.receipt}:${f.to}:${f.token}`, incident: src.incident, from: f.from, role: src.role, to: f.to, token: f.token, symbol: v.symbol, amount: v.amount, usd: Math.round(v.usd || 0), tx: f.tx, ts: f.ts, idle_h: idleH != null ? Math.round(idleH) : null, swap: swap || null };
      const r = await col('incident_moves').updateOne({ _id: move._id }, { $setOnInsert: move }, { upsert: true });
      if (!r.upsertedCount) continue;
      src.last_out_ts = Math.max(src.last_out_ts || 0, f.ts);
      const woke = idleH != null && idleH >= 24;
      const kase = await col('incident_cases').findOne({ _id: src.incident }, { projection: { owner: 1, visibility: 1 } }).catch(() => null);
      await raise(`moved:${move._id}`, { type: 'stolen_funds_moved', severity: v.usd >= C.alwaysUsd || woke ? 'high' : 'medium',
        title: `${woke ? `Stolen funds woke up after ${idleH >= 48 ? Math.round(idleH / 24) + ' days' : Math.round(idleH) + ' hours'}: ` : 'Stolen funds moved: '}${Math.round(v.amount).toLocaleString('en-US')} ${v.symbol} (~$${Math.round(v.usd).toLocaleString('en-US')}) from ${f.from.slice(0, 14)}…`,
        text: `From the ${src.role.replace(/_/g, ' ')} of incident ${src.incident.replace(/^inc:/, '').slice(0, 16)}… to ${where}.`, url: `/firewall/${encodeURIComponent(src.incident)}`, related: { wallets: [f.from, f.to] }, data: { ...move, private: kase?.visibility === 'private' || undefined, owner: kase?.owner || undefined }, ts: f.ts });
      // the receiver joins the incident (flagged, followed from now on) unless it is a router or a swap service
      const toState = !ROUTERS.has(f.to) && !swap && !builtinLabel(f.to) ? await viewAccount(f.to).catch(() => null) : null;
      const toContract = !!toState && (toState.code_hash !== '11111111111111111111111111111111' || !!toState.global_contract_hash || !!toState.global_contract_account_id);
      if (!ROUTERS.has(f.to) && !swap && !builtinLabel(f.to) && !toContract) { // a protocol deposit is a destination, never flagged
        await col('incidents').updateOne({ _id: src.incident, 'accounts.account': { $ne: f.to } }, { $push: { accounts: { account: f.to, role: 'cash_out_wallet', ts: f.ts, live: true } } });
        await col('firewall_flags').updateOne({ _id: f.to }, { $setOnInsert: { _id: f.to, severity: 'high', reason: 'received stolen funds', detail: `Received ${Math.round(v.amount).toLocaleString('en-US')} ${v.symbol} from an account of incident ${src.incident}.`, ts: Date.now(), source: 'incident', incident: src.incident } }, { upsert: true });
        map.set(f.to, { incident: src.incident, role: 'cash_out_wallet', root: src.root, last_out_ts: null });
      }
      retrace.add(src.incident);
      out.push(move);
    }
  }
  // the trail grows: re-trace each incident that moved (the queue skips one traced in the last hour)
  for (const id of retrace) {
    const d = await col('incidents').findOne({ _id: id }, { projection: { 'attacker.account': 1, updated_ts: 1 } });
    if (d && Date.now() - (d.updated_ts || 0) > 3600e3) await enqueueIncident({ account: d.attacker.account }, { reason: 'funds moved' });
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
  const xraised = await scanExchanges(blocks).catch((e) => { info(`exchange scan: ${e.message}`); return []; });
  await followStolen(blocks).catch((e) => info(`stolen funds follow: ${e.message}`));
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
  return [...xraised, ...raised];
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
  // size alone is never enough: a whale withdrawing its own stake is the biggest outflow a protocol sees. An attacker signal is needed
  const young = ageH != null && ageH < 30 * 24;
  const suspect = (ageH != null && ageH < C.freshHours) || ownTokens.length > 0 || (multi && young && w.usd >= C.minUsd * 3) || (young && w.usd >= C.alwaysUsd);
  return { suspect, reasons };
}
export { NEAR };
