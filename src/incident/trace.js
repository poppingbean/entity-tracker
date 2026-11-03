// Incident tracer: from an attacker account, an attack transaction or a target contract to the whole story, the way an analyst would
// work it by hand:
//   who        the attacker's accounts (the signer, sub-accounts it made, fake tokens it deployed, wallets and NEAR Intents accounts the
//              loot moved through) and who funded and created the first one
//   what       the target (the contract that paid out the most for nothing in return) and the attack transactions
//   how much   what left the target and the victims for the attacker's accounts, per token and in USD (today's prices)
//   who lost   every account whose value ended up with the attacker (the target contract, or each wallet a drainer emptied)
//   where to   the loot's trail, hop by hop, to an exchange, a bridge or NEAR Intents (and the chain address it was withdrawn to)
//   what's left  what the attacker's wallets still hold, and which of it the token's issuer can freeze
// Everything comes from executed receipts (the tx indexer); the AI then writes it up (ai.js) but never changes a number.
import { txIndexer, fastnearGet } from '../near/rpc.js';
import { viewAccount } from '../audit/rpc.js';
import { builtinLabel } from '../labels.js';
import { flowsOfTx, NEAR } from './flows.js';
import { valueOf, baseToken } from './prices.js';
import { oneClickSwap } from './oneclick.js';
import { upstream } from './origin.js';
import { ownFunds } from './ownfunds.js';
import { exchangeWalletMap } from './exchanges.js';
import { view } from '../near/rpc.js';
import { config } from '../config.js';

const IMPLICIT = /^[0-9a-f]{64}$|^0x[0-9a-f]{40}$/;
// accounts that pass value through rather than own it: wrapping, swapping, intents, launch routers
const PASS_THROUGH = new Set(['wrap.near', 'intents.near', 'aggregatedex.near', 'v2.ref-finance.near', 'dclv2.ref-labs.near', 'dex.intear.near', 'meteor-relayer.near', 'relay.aurora', 'near']);
const PSEUDO = /^(mint|burn|intents|chain):/;
export const isRouter = (id) => PASS_THROUGH.has(id) || PSEUDO.test(id);
const FREEZABLE = { 'usdt.tether-token.near': 'Tether can freeze it (add_to_blacklist / destroy_black_funds)', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': 'Circle can freeze it (blacklist)' };
const MAX_TXS = 800, HOP_TXS = 300;
// following the money stays bounded: a busy wallet can pay hundreds of accounts, and each implicit one costs a 1Click status lookup
const HOP_MOVES = 100, FOLLOW_MS = 3 * 60e3;

async function pool(items, n, f) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k], k); } })); return out; }
/** Full transactions for hashes (20 per call). */
export async function fetchTxs(hashes, { concurrency = 4 } = {}) {
  const groups = []; for (let i = 0; i < hashes.length; i += 20) groups.push(hashes.slice(i, i + 20));
  const res = await pool(groups, concurrency, (g) => txIndexer('/v0/transactions', { tx_hashes: g }).then((j) => j.transactions || []).catch(() => []));
  return res.flat().sort((a, b) => (a.execution_outcome?.block_height || 0) - (b.execution_outcome?.block_height || 0));
}
/** Hashes of an account's transactions (newest first, paged), optionally within block heights. */
export async function accountTxHashes(account, { limit = MAX_TXS, from = null, to = null } = {}) {
  const out = []; let resume = null;
  while (out.length < limit) {
    const j = await txIndexer('/v0/account', { account_id: account, limit: Math.min(200, limit - out.length), desc: true, ...(resume ? { resume_token: resume } : {}), ...(from ? { from_tx_block_height: from } : {}), ...(to ? { to_tx_block_height: to } : {}) }).catch(() => null);
    if (!j?.account_txs?.length) break;
    out.push(...j.account_txs);
    if (!j.resume_token) break;
    resume = j.resume_token;
  }
  return { hashes: [...new Set(out.map((r) => r.transaction_hash))], total: null };
}

const usdSum = (rows) => rows.reduce((s, r) => s + (r.usd || 0), 0);
/** Value per token of a set of flows, summed: [{ token, symbol, amount, usd }] sorted by USD. */
async function valued(flows) {
  const by = new Map();
  for (const f of flows) by.set(f.token, (by.get(f.token) || 0n) + BigInt(f.raw));
  const rows = await Promise.all([...by].map(async ([token, raw]) => ({ token: baseToken(token), via_intents: token.startsWith('intents:') || undefined, raw: raw.toString(), ...(await valueOf(token, raw.toString())) })));
  return rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));
}
const actionsOf = (t) => (t.transaction?.actions || []).map((a) => (typeof a === 'string' ? a : a.FunctionCall ? a.FunctionCall.method_name : Object.keys(a)[0]));
const tsOf = (t) => Number(t.execution_outcome?.block_timestamp || 0) / 1e6 || null;

/** Accounts the attacker created in its transactions (CreateAccount receipts), with whether each got code and minted a token. */
function createdBy(account, txs) {
  const made = new Map();
  for (const t of txs) for (const r of t.receipts || []) {
    const a = r.receipt?.receipt?.Action; if (!a || r.execution_outcome?.outcome?.status?.Failure) continue;
    const kinds = (a.actions || []).map((x) => (typeof x === 'string' ? x : Object.keys(x)[0]));
    if (kinds.includes('CreateAccount') && r.receipt.predecessor_id === account) {
      const m = made.get(r.receipt.receiver_id) || { account: r.receipt.receiver_id, tx: t.transaction.hash, ts: tsOf(t), code: false, token: false };
      if (kinds.some((k) => /Deploy/.test(k))) m.code = true;
      if ((a.actions || []).some((x) => /^(new|mint|ft_mint)/.test(x?.FunctionCall?.method_name || ''))) m.token = true;
      made.set(m.account, m);
    }
  }
  return [...made.values()];
}
/** Who created an account and who first funded it (from its earliest transactions). */
function originOf(account, txs, flows) {
  let creator = null, created_ts = null;
  for (const t of txs) {
    for (const r of t.receipts || []) {
      const a = r.receipt?.receipt?.Action;
      if (r.receipt?.receiver_id === account && (a?.actions || []).some((x) => x === 'CreateAccount' || x?.CreateAccount !== undefined)) { creator = { by: r.receipt.predecessor_id, signer: t.transaction.signer_id, tx: t.transaction.hash }; created_ts = tsOf(t); break; }
    }
    if (creator) break;
  }
  const funders = [], called = new Set(txs.filter((t) => t.transaction.signer_id === account).map((t) => t.transaction.receiver_id));
  for (const f of flows) if (f.to === account && f.token === NEAR && !isRouter(f.from) && f.from !== account && !called.has(f.from) && BigInt(f.raw) >= 10n ** 23n && !funders.some((x) => x.from === f.from)) { funders.push(f); if (funders.length >= 3) break; }
  return { creator, created_ts, funders };
}

/**
 * Trace an incident. `input`: { account } (the attacker), { tx } (an attack transaction) or { target, hours } (a contract that was hit:
 * the receivers it paid most in the window become the suspects). Returns the incident document (not saved).
 */
export async function traceIncident(input, { depth = 2, log = () => {}, upstreamDone = null } = {}) {
  let attacker = input.account || null, hint = null, suspects = [];
  if (input.tx) {
    const [t] = await fetchTxs([input.tx]);
    if (!t) throw new Error('transaction not found');
    hint = { tx: input.tx };
    const fl = flowsOfTx(t), signer = t.transaction.signer_id;
    // the attacker is who the value went to: the signer unless the tx paid someone else more
    const gain = new Map();
    for (const f of fl) if (!isRouter(f.to) && f.to !== f.from) gain.set(f.to, [...(gain.get(f.to) || []), f]);
    const ranked = await Promise.all([...gain].map(async ([to, fs]) => ({ to, usd: usdSum(await valued(fs)) })));
    ranked.sort((a, b) => b.usd - a.usd);
    attacker = ranked.find((r) => r.to === signer && r.usd > 0) ? signer : ranked[0]?.to || signer;
  }
  if (input.target && !attacker) {
    suspects = await suspectsOfTarget(input.target, { hours: input.hours || 24 });
    if (!suspects.length) return { _id: `target:${input.target}`, status: 'nothing_found', target: { account: input.target }, input, suspects, scanned: suspects.scanned, capped: suspects.capped, traced_ts: Date.now() };
    attacker = suspects[0].account;
    hint = { target: input.target };
  }
  if (!attacker) throw new Error('give an account, a transaction hash or a target contract');
  log(`tracing ${attacker}`);

  // ---- 1. the attacker's history, flows, own accounts
  const { hashes } = await accountTxHashes(attacker);
  const txs = await fetchTxs(hashes);
  const flows = txs.flatMap(flowsOfTx);
  const made = createdBy(attacker, txs);
  const own = new Map([[attacker, { account: attacker, role: 'attacker' }]]);
  for (const m of made) own.set(m.account, { account: m.account, role: m.token ? 'fake_token' : m.code ? 'contract' : 'sub_account', ts: m.ts });
  for (const t of txs) { const s = t.transaction.signer_id; if (s.endsWith('.' + attacker) && !own.has(s)) own.set(s, { account: s, role: 'sub_account' }); }
  // NEAR Intents accounts that withdrew to the attacker are the attacker's (only the owner can sign an intents withdrawal)
  for (const f of flows) if (f.kind === 'intents_out' && own.has(f.to) && !own.has(f.from)) own.set(f.from, { account: f.from, role: 'intents_account' });
  const origin = originOf(attacker, txs, flows);

  // ---- 1b. where the money came from. An exchange hot wallet that paid a large amount to an account created just before is an exchange
  // drain: its first receiver is the attacker's real wallet (re-rooted there), the pasted one is one of the wallets it paid out to
  log('following the money in');
  const history = async (id) => fetchTxs((await accountTxHashes(id, { limit: HOP_TXS })).hashes);
  const up = upstreamDone || await upstream(attacker, txs, history).catch(() => ({ sources: [], path: [], drain: null }));
  if (up.drain && up.drain.root !== attacker) {
    log(`the money came from ${up.drain.exchange}: re-rooting at ${up.drain.root}`);
    const inc = await traceIncident({ account: up.drain.root, from: input }, { depth, log, upstreamDone: { ...up, sources: up.sources } });
    if (!inc.accounts.some((a) => a.account === attacker)) inc.accounts.push({ account: attacker, role: 'cash_out_wallet' });
    return { ...inc, input, pasted: attacker };
  }
  const drained = new Set((up.drain?.victims || []).map((v) => v.account));
  const funderSet = new Set(origin.funders.map((f) => f.from).filter((a) => !drained.has(a)));
  origin.funders = origin.funders.filter((f) => !drained.has(f.from));

  // ---- 2. who paid the attacker's accounts for nothing: the target and the victims
  const ownSet = new Set(own.keys()), fake = new Set([...own.values()].filter((o) => o.role === 'fake_token').map((o) => o.account));
  const real = (f) => !fake.has(baseToken(f.token)) && !/^nft:/.test(f.token);
  const per = new Map(); // counterparty -> { in: flows to us, out: flows from us }
  for (const f of flows) {
    if (!real(f)) continue;
    const i = ownSet.has(f.to), o = ownSet.has(f.from);
    if (i === o) continue;
    const cp = i ? f.from : f.to;
    if (isRouter(cp) || ownSet.has(cp)) continue;
    const x = per.get(cp) || { in: [], out: [] }; (i ? x.in : x.out).push(f); per.set(cp, x);
  }
  const counter = await Promise.all([...per].map(async ([cp, x]) => {
    const got = await valued(x.in), paid = await valued(x.out);
    return { account: cp, got, paid, got_usd: usdSum(got), paid_usd: usdSum(paid), net_usd: usdSum(got) - usdSum(paid), txs: [...new Set(x.in.map((f) => f.tx))] };
  }));
  // a victim lost value to us; a large paid-out amount to an account that sent nothing back is cash-out, handled in the trail
  const xmap = await exchangeWalletMap().catch(() => new Map());
  const losers = counter.filter((c) => c.net_usd > 1 && c.got_usd > 0 && !funderSet.has(c.account) && (drained.has(c.account) || !xmap.has(c.account))).sort((a, b) => b.net_usd - a.net_usd);
  const states = await pool(losers.slice(0, 30), 6, (c) => viewAccount(c.account).catch(() => null));
  const victims = losers.slice(0, 30).map((c, i) => ({ account: c.account, contract: !!states[i] && (states[i].code_hash !== '11111111111111111111111111111111' || !!states[i].global_contract_hash || !!states[i].global_contract_account_id),
    label: builtinLabel(c.account)?.name || null, lost_usd: Math.round(c.net_usd), tokens: c.got.map((g) => ({ token: g.token, symbol: g.symbol, amount: g.amount, usd: g.usd != null ? Math.round(g.usd) : null })), returned_usd: Math.round(c.paid_usd), txs: c.txs.slice(0, 20) }));
  // an exchange drain: the exchange's hot wallets are the victims (named by the upstream trace), the biggest one is the target
  if (up.drain) for (const v of victims) { const d = up.drain.victims.find((x) => x.account === v.account); if (d) Object.assign(v, { exchange: true, label: d.name, how: d.how }); }
  const target = up.drain ? victims.find((v) => v.exchange) || null : hint?.target ? victims.find((v) => v.account === hint.target) || { account: hint.target } : victims.find((v) => v.contract) || null;
  const attackTxsAll = up.drain ? [...new Set(victims.filter((v) => v.exchange).flatMap((v) => v.txs))] : null;
  const attackTxs = attackTxsAll || target?.txs || [];
  const firstAttack = Math.min(...txs.filter((t) => attackTxs.includes(t.transaction.hash)).map(tsOf).filter(Boolean), Infinity);

  // ---- 3. the loot's trail out of the attacker's accounts
  log('following the money');
  const trail = await followMoney(ownSet, flows, { since: Number.isFinite(firstAttack) ? firstAttack - 60e3 : 0, depth, own, fake });
  // a "wallet" whose money only went on to bridge-mng.near is a 1Click deposit address whose status could not be read: a service, not the attacker's
  const oneClickAddr = new Set(trail.wallets.filter((w) => { const outs = trail.moves.filter((m) => m.from === w.account); return outs.length && outs.every((m) => m.to === 'bridge-mng.near'); }).map((w) => w.account));
  for (const w of trail.wallets) if (!own.has(w.account) && !oneClickAddr.has(w.account)) own.set(w.account, { account: w.account, role: 'cash_out_wallet' });
  // an intents account fed by a 1Click deposit address (run by bridge-mng.near) is 1Click's own swap account sending a refund back,
  // not one of the attacker's: listed apart, never flagged
  const service = [];
  const intentsAccs = [...own.values()].filter((o) => o.role === 'intents_account').slice(0, 10);
  const isOneClick = await pool(intentsAccs, 4, async (o) => { const { hashes } = await accountTxHashes(o.account, { limit: 30 }); return (await fetchTxs(hashes)).some((t) => t.transaction.signer_id === 'bridge-mng.near'); });
  intentsAccs.forEach((o, i) => { if (isOneClick[i]) { own.delete(o.account); service.push({ account: o.account, role: '1Click swap account (refund)' }); } });
  for (const a of oneClickAddr) service.push({ account: a, role: '1Click deposit address (status not readable)' });
  for (const f of origin.funders) if (!own.has(f.from)) own.set(f.from, { account: f.from, role: 'funder' });

  // ---- 4. what is still held, and what can be frozen
  const holdings = await pool([...own.values()].filter((o) => !['fake_token', 'contract'].includes(o.role)).slice(0, 12), 4, (o) => heldBy(o.account));
  const held = holdings.filter(Boolean);

  // ---- 5. the attack transactions and the timeline
  const setup = made.map((m) => ({ ts: m.ts, tx: m.tx, what: m.token ? `deployed token contract ${m.account}` : `created ${m.account}` }));
  const attackRows = txs.filter((t) => attackTxs.includes(t.transaction.hash)).map((t) => ({ tx: t.transaction.hash, ts: tsOf(t), height: t.execution_outcome?.block_height, receiver: t.transaction.receiver_id, methods: actionsOf(t),
    args: (t.transaction.actions || []).filter((a) => a.FunctionCall).slice(0, 8).map((a) => { try { return { method: a.FunctionCall.method_name, args: JSON.parse(Buffer.from(a.FunctionCall.args, 'base64').toString()) }; } catch { return { method: a.FunctionCall.method_name }; } }),
    // what the target itself logged while it was being drained (its events show the real ticks, prices and pool updates)
    events: (t.receipts || []).filter((r) => r.receipt?.receiver_id === t.transaction.receiver_id).flatMap((r) => r.execution_outcome?.outcome?.logs || [])
      .map((l) => { try { const e = JSON.parse(l.replace(/^EVENT_JSON:/, '')); return { event: e.event, data: e.data }; } catch { return null; } }).filter((e) => e && !/storage_balance/.test(e.event)).slice(0, 16) }));
  const timeline = [
    ...(origin.created_ts ? [{ ts: origin.created_ts, kind: 'created', text: `${attacker} created${origin.creator ? ` by ${origin.creator.by}${origin.creator.signer !== origin.creator.by ? ` (signed by ${origin.creator.signer})` : ''}` : ''}`, tx: origin.creator?.tx }] : []),
    ...origin.funders.map((f) => ({ ts: f.ts, kind: 'funded', text: `funded with NEAR by ${f.from}`, tx: f.tx, raw: f.raw })),
    ...setup.map((s) => ({ ts: s.ts, kind: 'setup', text: s.what, tx: s.tx })),
    ...(up.drain ? up.drain.victims.flatMap((v) => v.txs.slice(0, 3).map((h) => ({ ts: v.first_ts, kind: 'attack', text: `${v.name} ${v.account} sent ${v.tokens.map((t) => `${fmt(t.amount)} ${t.symbol}`).join(', ')} (${fmtUsd(v.usd)}) to ${attacker}`, tx: h })))
      : attackRows.map((a) => ({ ts: a.ts, kind: 'attack', text: `${a.methods.join(', ')} on ${a.receiver}`, tx: a.tx }))),
    ...trail.moves.slice(0, 25).map((m) => ({ ts: m.ts, kind: 'cash_out', text: `${m.symbol} ${fmt(m.amount)} from ${m.from} to ${m.to}${m.dest_kind ? ` (${m.dest_kind})` : ''}`, tx: m.tx })),
  ].filter((e) => e.ts).sort((a, b) => a.ts - b.ts).slice(0, 80);

  // ---- 6. what kind of incident this is (rules; the AI explains, never decides)
  const stolen = victims.reduce((s, v) => s + v.lost_usd, 0);
  const walletVictims = victims.filter((v) => !v.contract);
  const emptied = [];
  for (const v of walletVictims.filter((x) => !x.exchange).slice(0, 10)) {
    const t = v.tokens[0]; if (!t) continue;
    const left = t.token === NEAR ? await viewAccount(v.account).then((a) => Number(BigInt(a.amount) / 10n ** 21n) / 1e3).catch(() => null)
      : await view(t.token, 'ft_balance_of', { account_id: v.account }).then(async (b) => (await valueOf(t.token, String(b))).amount).catch(() => null);
    if (left != null && left < 0.1 * (t.amount || 0)) emptied.push(v.account);
  }
  for (const v of victims) if (emptied.includes(v.account)) v.emptied = true;
  // a drainer's fingerprint is in who signed: one key moving several victims' money (the attacker's key added to each), or the attacker itself
  // signing the move (an approval). Wallets sweeping into a fund or an OTC desk sign with their own, different keys
  const byHash = new Map(txs.map((t) => [t.transaction.hash, t]));
  const keyUse = new Map(); let attackerSigned = 0;
  for (const v of victims.filter((x) => x.emptied)) for (const h of v.txs) {
    const t = byHash.get(h); if (!t) continue;
    if (t.transaction.signer_id === attacker) attackerSigned++;
    else if (t.transaction.signer_id === v.account) { const k = t.transaction.public_key; keyUse.set(k, new Set([...(keyUse.get(k) || []), v.account])); }
  }
  const sharedKey = [...keyUse.values()].some((set) => set.size >= 2);
  const youngAttacker = origin.created_ts && Number.isFinite(firstAttack) ? firstAttack - origin.created_ts < 30 * 86400e3 : false;
  const drainerSign = sharedKey || attackerSigned > 0 || youngAttacker;
  const usedFake = attackRows.some((a) => JSON.stringify(a.args || []).match(new RegExp([...fake].map((x) => x.replace(/\./g, '\\.')).join('|') || '^$')));
  const kind = up.drain ? 'exchange_drain' : target?.contract !== false && target && (fake.size || usedFake) ? 'protocol_exploit' : walletVictims.length >= 3 ? 'wallet_drainer' : target?.contract ? 'protocol_exploit' : stolen > 0 ? 'suspicious_transfers' : 'none';
  // "confirmed" (flags, a hack alert) needs an attacker signal, not just value received: fake tokens used against the target, an account that
  // was new when it took the money, an exchange drain, or several wallets emptied. A whale withdrawing its own stake has none of these
  const freshAtAttack = origin.created_ts && Number.isFinite(firstAttack) && firstAttack - origin.created_ts < config.incidents.freshHours * 3600e3;
  const ownCheck = kind === 'protocol_exploit' && target?.account && !fake.size ? await ownFunds(attacker, target.account, { beforeTs: Number.isFinite(firstAttack) ? firstAttack : Date.now(), withdrawnUsd: target.lost_usd || stolen }).catch(() => null) : null;
  const evidence = !ownCheck?.own_funds && (kind === 'exchange_drain' || (kind === 'protocol_exploit' && (fake.size > 0 || usedFake || freshAtAttack)) || (kind === 'wallet_drainer' && emptied.length >= 3 && drainerSign));
  // the evidence, in plain words: it is shown for cases that are only watched too, so it states what happened, not a crime
  const signals = [
    ownCheck?.own_funds ? `not a hack: ${ownCheck.explanation}` : null,
    up.drain ? `${up.drain.victims.length} ${up.drain.exchange.split(', ')[0]} hot wallet${up.drain.victims.length > 1 ? 's' : ''} sent ${fmtUsd(up.drain.usd)} to ${attacker}, ${Math.min(...up.drain.victims.map((v) => v.first_ts)) - up.drain.root_created_ts < 60e3 ? 'an account created by the first of these transfers' : `${hoursBetween(up.drain.root_created_ts, Math.min(...up.drain.victims.map((v) => v.first_ts)))} after it was created`}${up.drain.victims[0].how ? ` (identified as such because it ${up.drain.victims[0].how})` : ''}` : null,
    fake.size ? `deployed ${fake.size} token contract${fake.size > 1 ? 's' : ''} of its own (${[...fake].slice(0, 6).join(', ')})${usedFake ? ' and used them in the key transactions' : ''}` : null,
    origin.created_ts && Number.isFinite(firstAttack) ? `the account was ${hoursBetween(origin.created_ts, firstAttack)} old when the large transfers started` : null,
    target && !up.drain ? `${target.account} paid out ${fmtUsd(target.lost_usd)} and got ${fmtUsd(target.returned_usd || 0)} back` : null,
    emptied.length ? `${emptied.length} wallet${emptied.length > 1 ? 's were' : ' was'} emptied into it${sharedKey ? ', one key signing for several of them' : attackerSigned ? ', moved by the receiving account itself' : youngAttacker ? '' : ' (each signed with its own key: consistent with a wallet consolidating its own funds)'}` : null,
    trail.exits.length ? `the money left: ${Object.entries(trail.exit_usd).map(([k, v]) => `${k} (~$${v.toLocaleString('en-US')})`).join(', ')}` : null,
  ].filter(Boolean);

  return {
    _id: `inc:${attacker}`, status: stolen >= 1000 && evidence ? 'confirmed' : stolen > 0 ? 'suspected' : 'nothing_found', kind, input,
    attacker: { account: attacker, ...origin, created_ts: origin.created_ts, funders: origin.funders.map((f) => ({ account: f.from, tx: f.tx, ts: f.ts, raw: f.raw })) },
    accounts: [...own.values()], service_accounts: service, target, victims, sources: up.sources, source_path: up.path, drain: up.drain ? { exchange: up.drain.exchange, usd: up.drain.usd, root: up.drain.root } : null, attack_txs: attackRows, stolen_usd: Math.round(stolen), losses: target?.tokens || [],
    trail, held, held_usd: Math.round(held.reduce((s, h) => s + (h.usd || 0), 0)), freezable: held.flatMap((h) => h.tokens.filter((t) => t.freeze).map((t) => ({ holder: h.account, ...t }))),
    timeline, signals, suspects, started_ts: Number.isFinite(firstAttack) ? firstAttack : null, last_ts: Math.max(...txs.map(tsOf).filter(Boolean), 0) || null,
    stats: { txs: txs.length, flows: flows.length }, prices_note: 'USD at current prices', traced_ts: Date.now(),
  };
}

const fmt = (x) => (x == null ? '?' : x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : x.toFixed(x < 10 ? 3 : 1));
const fmtUsd = (x) => '$' + Math.round(x || 0).toLocaleString('en-US');
const hoursBetween = (a, b) => { const h = (b - a) / 3600e3; return h < 1 ? `${Math.round(h * 60)} minutes` : h < 48 ? `${h.toFixed(1)} hours` : `${Math.round(h / 24)} days`; };

const contractCache = new Map();
/** Has this account code (a protocol, a token, any contract)? Cached. */
async function isContract(id) {
  if (contractCache.has(id)) return contractCache.get(id);
  const a = await viewAccount(id).catch(() => null);
  const v = !!a && (a.code_hash !== '11111111111111111111111111111111' || !!a.global_contract_hash || !!a.global_contract_account_id);
  contractCache.set(id, v);
  return v;
}

/** Where a destination account sits: exchange, bridge, NEAR Intents, another chain, a DEX, or a wallet to follow. */
function destKind(id) {
  if (id === 'bridge-mng.near') return 'NEAR Intents 1Click'; // the operator of 1Click deposit addresses
  if (id.startsWith('chain:')) return 'withdrawn to another chain';
  if (id === 'intents.near') return 'NEAR Intents';
  const l = builtinLabel(id);
  if (l?.kind === 'exchange') return `exchange (${l.name})`;
  if (/bridge|omft\.near$|\.factory\.bridge\.near$|rainbow|aurora$/.test(id)) return 'bridge';
  if (PASS_THROUGH.has(id) || /ref-finance|ref-labs|veax|dex|swap|router/.test(id)) return 'DEX';
  if (l?.kind) return l.name;
  return null; // a wallet
}

/** Follow value out of the attacker's accounts: hop by hop through new wallets, up to exchanges / bridges / NEAR Intents. */
export async function followMoney(ownSet, flows, { since, depth, own, fake }) {
  const moves = [], exits = [], wallets = [], seen = new Set(ownSet);
  const keep = (f) => f.ts >= since && !fake.has(baseToken(f.token)) && !/^nft:|^mint:|^burn:/.test(f.token) && !(PSEUDO.test(f.to) && !f.to.startsWith('chain:'));
  let frontier = flows.filter((f) => keep(f) && ownSet.has(f.from) && !ownSet.has(f.to));
  const t0 = Date.now(); let capped = null;
  for (let hop = 0; hop <= depth && frontier.length; hop++) {
    if (hop && Date.now() - t0 > FOLLOW_MS) { capped = `stopped after ${hop} hop(s): out of time`; break; }
    const rows = await Promise.all(frontier.map(async (f) => ({ ...f, ...(await valueOf(f.token, f.raw)), hop })));
    const all = rows.filter((r) => (r.usd ?? 0) >= 50 || (r.usd == null && r.token === NEAR));
    // the largest moves only (a busy wallet pays hundreds of accounts)
    const big = all.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)).slice(0, HOP_MOVES);
    if (all.length > big.length) capped = `hop ${hop}: the ${HOP_MOVES} largest of ${all.length} moves followed`;
    const next = new Map();
    // a one-time 1Click deposit address is a cross-chain swap: its status says the chain, the recipient and the destination tx
    const swaps = await pool(big, 3, (r) => (Date.now() - t0 < FOLLOW_MS && !destKind(r.to) && /^[0-9a-f]{64}$/.test(r.to) ? oneClickSwap(r.to) : null)); // three at a time: the status API rate-limits
    for (const [i, r] of big.entries()) {
      const sw = swaps[i];
      if (sw) {
        const refunded = sw.status === 'REFUNDED' || sw.status === 'FAILED';
        moves.push({ tx: r.tx, ts: r.ts, from: r.from, to: r.to, token: baseToken(r.token), symbol: r.symbol, amount: r.amount, usd: r.usd != null ? Math.round(r.usd) : null, hop,
          dest_kind: refunded ? `1Click swap, ${sw.status === 'FAILED' ? 'failed' : 'refunded'}` : `1Click swap to ${sw.asset} on ${sw.chain}`, swap: sw });
        seen.add(r.to);
        if (!refunded) { exits.push({ to: sw.recipient ? `${sw.chain}:${sw.recipient}` : r.to, kind: sw.chain === 'NEAR' ? '1Click swap on NEAR' : `swapped to ${sw.chain}`, chain: sw.chain, asset: sw.asset, recipient: sw.recipient,
          amount_out: sw.amount_out, status: sw.status, dest_txs: sw.dest_txs, deposit_address: r.to, usd: r.usd, token: baseToken(r.token), symbol: r.symbol, amount: r.amount, tx: r.tx, ts: r.ts });
          if (sw.chain === 'NEAR' && sw.recipient && !seen.has(sw.recipient)) next.set(sw.recipient, (next.get(sw.recipient) || 0) + (r.usd || 0)); }
        continue;
      }
      let k = destKind(r.to);
      if (!k && !PSEUDO.test(r.to) && !/^[0-9a-f]{64}$|^0x[0-9a-f]{40}$/.test(r.to)) { const st = await isContract(r.to); if (st) k = 'contract'; }
      moves.push({ tx: r.tx, ts: r.ts, from: r.from, to: r.to, token: baseToken(r.token), symbol: r.symbol, amount: r.amount, usd: r.usd != null ? Math.round(r.usd) : null, hop, dest_kind: k || 'wallet' });
      if (k && k !== 'DEX' && k !== 'contract') exits.push({ to: r.to, kind: k.startsWith('exchange') ? 'an exchange' : k, label: k, usd: r.usd, token: baseToken(r.token), symbol: r.symbol, amount: r.amount, tx: r.tx, ts: r.ts });
      else if (!k && !PSEUDO.test(r.to) && !seen.has(r.to) && (r.usd ?? 0) >= 200) next.set(r.to, (next.get(r.to) || 0) + (r.usd || 0));
    }
    if (hop === depth) break;
    // follow the wallets that took the most
    const follow = [...next].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const more = [];
    for (const [w, usd] of follow) {
      if (Date.now() - t0 > FOLLOW_MS) { capped = `stopped at hop ${hop + 1}: out of time`; break; }
      seen.add(w); wallets.push({ account: w, received_usd: Math.round(usd), hop: hop + 1 });
      const { hashes } = await accountTxHashes(w, { limit: HOP_TXS });
      const fl = (await fetchTxs(hashes)).flatMap((t) => (t.transaction ? [...(t.receipts ? flowsOfTx(t) : [])] : []));
      more.push(...fl.filter((f) => keep(f) && f.from === w && !seen.has(f.to)));
      // intents withdrawals signed from this wallet's intents account land here too
      more.push(...fl.filter((f) => keep(f) && f.kind === 'intents_out' && seen.has(f.from) && !seen.has(f.to)));
    }
    frontier = more;
  }
  // the attacker's own intents withdrawals to other chains
  for (const f of flows) if (f.kind === 'intents_out' && ownSet.has(f.from) && f.to.startsWith('chain:') && keep(f)) { const v = await valueOf(f.token, f.raw); exits.push({ to: f.to, kind: 'withdrawn to another chain', usd: v.usd, token: baseToken(f.token), symbol: v.symbol, amount: v.amount, tx: f.tx, ts: f.ts }); }
  const per = new Map(); // each transfer once (the same move can be seen from two hops)
  for (const e of exits) per.set(`${e.tx}|${e.to}|${e.token}`, e);
  const byKind = {};
  for (const e of per.values()) byKind[e.kind] = Math.round((byKind[e.kind] || 0) + (e.usd || 0));
  return { moves: moves.sort((a, b) => a.ts - b.ts).slice(0, 200), exits, wallets, exit_usd: byKind, capped };
}

/** What one account holds now (NEAR + tokens, valued), with the tokens an issuer can freeze. */
export async function heldBy(account) {
  const j = await fastnearGet(`/v1/account/${encodeURIComponent(account)}/full`).catch(() => null);
  let nearRaw = '0';
  try { nearRaw = (await viewAccount(account))?.amount || '0'; } catch {}
  const toks = (j?.tokens || []).filter((t) => t.balance && t.balance !== '0').slice(0, 60);
  const rows = (await Promise.all(toks.map(async (t) => ({ token: t.contract_id, raw: t.balance, ...(await valueOf(t.contract_id, t.balance)), freeze: FREEZABLE[t.contract_id] || null })))).filter((r) => (r.usd || 0) >= 1 || r.freeze);
  const n = await valueOf(NEAR, nearRaw);
  const tokens = [...(n.amount >= 0.5 ? [{ token: NEAR, symbol: 'NEAR', amount: n.amount, usd: n.usd }] : []), ...rows.map((r) => ({ token: r.token, symbol: r.symbol, amount: r.amount, usd: r.usd != null ? Math.round(r.usd) : null, freeze: r.freeze }))].sort((a, b) => (b.usd || 0) - (a.usd || 0));
  return tokens.length ? { account, tokens, usd: Math.round(usdSum(tokens)) } : null;
}

/** Receivers a contract paid the most (net of what they paid it) in the last `hours`: who to trace when a protocol was hit. */
export async function suspectsOfTarget(target, { hours = 24, limit = 6000 } = {}) {
  const tip = (await txIndexer('/v0/account', { account_id: target, limit: 1, desc: true }).catch(() => null))?.account_txs?.[0]?.tx_block_height;
  if (!tip) return [];
  const { hashes } = await accountTxHashes(target, { limit, from: tip - Math.round(hours * 3600 * 1.0), to: tip });
  const flows = (await fetchTxs(hashes, { concurrency: 8 })).flatMap(flowsOfTx);
  const per = new Map();
  for (const f of flows) {
    if (f.from === target && !isRouter(f.to)) { const x = per.get(f.to) || { got: [], paid: [] }; x.got.push(f); per.set(f.to, x); }
    if (f.to === target && !isRouter(f.from)) { const x = per.get(f.from) || { got: [], paid: [] }; x.paid.push(f); per.set(f.from, x); }
  }
  const rows = await Promise.all([...per].filter(([, x]) => x.got.length).map(async ([acc, x]) => { const g = usdSum(await valued(x.got)), p = usdSum(await valued(x.paid)); return { account: acc, got_usd: Math.round(g), paid_usd: Math.round(p), net_usd: Math.round(g - p), txs: [...new Set(x.got.map((f) => f.tx))].slice(0, 10) }; }));
  const out = rows.filter((r) => r.net_usd > 100).sort((a, b) => b.net_usd - a.net_usd).slice(0, 10);
  out.scanned = hashes.length; out.capped = hashes.length >= limit;
  return out;
}

export { IMPLICIT };
