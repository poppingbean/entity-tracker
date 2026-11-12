// Safe Near Academy as an autonomous business (docs/academy-business.md). A person sets the rules in academy-business.json (prices, the
// revenue split, limits, a kill switch); the agent runs the rest:
//   sell      agents buy an exam certificate, a training pass or a dataset pass (academy_buy); the free tier stays free
//   get paid  on NEAR (NEAR or USDC to the treasury) or from any chain through NEAR Intents (a 1Click deposit address that pays the treasury).
//            Every order has a unique amount, so a payment is matched by its exact amount, with or without a memo
//   spend     NEAR AI's token use is booked as a cost every day; the reserve the revenue builds buys extra AI calls beyond the base budget
//   pay out   once a day the revenue is split (reserve, contributors, treasury). Each payout is checked by Safe Near's own Agent Guard, then
//            proposed and approved on the treasury DAO by the agent, whose key is a FUNCTION-CALL key for that DAO only (never full access)
//   ledger    every sale, cost, payout and certificate is a public row (GET /api/v1/academy/ledger, the /academy/ledger page)
// The pure parts are exported for tests; the rest reads and writes MongoDB and the chain.
import { createHash, randomInt } from 'node:crypto';
import { col, metaGet, metaSet } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';

const DAY = 86400e3, YOCTO = 10n ** 24n;
const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;
export const rules = () => config.academy.business;

export const PRODUCTS = {
  exam_certificate: 'one certified result of the fixed exam on a track (academy_certify), public on the ledger',
  training_pass: 'unlimited training tasks for the pass days (the free tier has a daily cap)',
  dataset_pass: 'unlimited dataset export for the pass days (the free tier has a daily cap)',
};

// ------------------------------------------------------------------ pure
/** The exact amounts of an order: price + the order's number (`ref`, 1..999) in the smallest units, so the amount itself names the order. */
export function orderAmounts(usd, nearUsd, ref) {
  if (!(usd > 0)) throw new Error('price must be above 0');
  if (!(ref >= 1 && ref <= 999)) throw new Error('ref must be 1..999');
  const usdc = BigInt(Math.round(usd * 1e6)) + BigInt(ref); // + up to $0.000999
  const near = nearUsd > 0 ? (BigInt(Math.ceil((usd / nearUsd) * 1e4)) * (YOCTO / 10000n)) + BigInt(ref) : null;
  return { usdc_raw: usdc.toString(), near_yocto: near != null ? near.toString() : null };
}
/** The open order a payment pays: the exact amount (NEAR in yocto or USDC raw). A memo naming the order also matches. Pure. */
export function matchOrder(orders, pay) {
  const open = orders.filter((o) => o.status === 'open');
  if (pay.currency === 'near') return open.find((o) => o.near_yocto === pay.raw) || null;
  return open.find((o) => o.usdc_raw === pay.raw) || (pay.memo ? open.find((o) => o.ref_code === pay.memo && BigInt(pay.raw) >= BigInt(o.usdc_raw)) : null) || null;
}
/** Split an amount by the rules: the reserve, the contributors (equal parts), the treasury (keeps the rest, rounding included). Pure. */
export function splitShares(raw, split, { reserveAccount, contributors = [] }) {
  const total = BigInt(raw), out = [];
  const part = (f) => (total * BigInt(Math.round(f * 1e6))) / 1000000n;
  const reserve = reserveAccount ? part(split.reserve || 0) : 0n;
  if (reserve > 0n) out.push({ role: 'reserve', to: reserveAccount, raw: reserve });
  let given = reserve;
  if (contributors.length && split.contributors > 0) {
    const each = part(split.contributors) / BigInt(contributors.length);
    for (const c of contributors) if (each > 0n) { out.push({ role: 'contributor', to: c, raw: each }); given += each; }
  }
  out.push({ role: 'treasury', to: null, raw: total - given });
  return out.map((x) => ({ ...x, raw: x.raw.toString() }));
}
/** The USD cost of NEAR AI tokens at the rules' prices. Pure. */
export const costUsd = ({ prompt = 0, completion = 0 }, inf) => r4((prompt / 1e6) * inf.usd_per_million_input_tokens + (completion / 1e6) * inf.usd_per_million_output_tokens);
/** Extra AI calls a day the reserve pays for: what is left of it after costs, at the price of one call, capped. Pure. */
export const extraCalls = (reserveUsd, inf) => Math.max(0, Math.min(inf.max_extra_ai_calls_per_day, Math.floor(reserveUsd / inf.usd_per_ai_call)));
/** The entitlements after a purchase. Pure. */
export function grant(ent = {}, product, passDays, now = Date.now()) {
  const e = { certificates: 0, ...ent }, until = (cur) => Math.max(now, cur || 0) + passDays * DAY;
  if (product === 'exam_certificate') e.certificates += 1;
  else if (product === 'training_pass') e.training_until = until(e.training_until);
  else if (product === 'dataset_pass') e.dataset_until = until(e.dataset_until);
  else throw new Error(`unknown product ${product}`);
  return e;
}
/** The Agent Guard policy every payout must pass. Pure. */
export function payoutPolicy(R) {
  return { max_usd_per_tx: R.limits.max_usd_per_payout, max_usd_per_day: R.limits.max_usd_per_day, allowed_receivers: [R.usdc, R.reserve_account, ...R.contributors].filter(Boolean), block_on: ['block', 'warn'], ask_on: ['caution'] };
}
/** The transaction a payout amounts to (the DAO sending it), for the Agent Guard to check. Pure. */
export function payoutTx(R, { to, currency, raw }) {
  return currency === 'near'
    ? { signer_id: R.treasury, receiver_id: to, actions: [{ Transfer: { deposit: raw } }] }
    : { signer_id: R.treasury, receiver_id: R.usdc, actions: [{ FunctionCall: { method_name: 'ft_transfer', args: { receiver_id: to, amount: raw }, gas: '30000000000000', deposit: '1' } }] };
}
/** The DAO proposal kind of a payout (Sputnik DAO Transfer). Pure. */
export const transferKind = (R, { to, currency, raw }) => ({ Transfer: { token_id: currency === 'near' ? '' : R.usdc, receiver_id: to, amount: raw, msg: null } });

/** What blocks the business from running, if anything (missing accounts, a paused switch). Pure. */
export function notReady(R, { paused = false } = {}) {
  if (!R.enabled) return 'the business is off (academy-business.json "enabled", or ACADEMY_BUSINESS)';
  if (R.paused || paused) return 'the business is paused (the kill switch)';
  if (!R.treasury) return 'no treasury account set';
  return null;
}

// ------------------------------------------------------------------ state
const paused = async () => !!(await metaGet('academy_business_paused', false));
export async function setPaused(on) { await metaSet('academy_business_paused', !!on); await ledgerRow({ _id: `switch:${Date.now()}`, kind: on ? 'paused' : 'resumed', note: on ? 'kill switch on: no new orders, no payouts' : 'kill switch off' }); }
async function ledgerRow(row) {
  await col('academy_ledger').updateOne({ _id: row._id }, { $setOnInsert: { ts: Date.now(), day: day(), ...row } }, { upsert: true });
}

/** An agent's entitlements (passes, certificates). */
export async function entitlements(agent) { return (await col('academy_agents').findOne({ _id: agent }, { projection: { ent: 1 } }))?.ent || {}; }

/** Free-tier gate for a training task: null when allowed, else the reason. Off when the business is off. */
export async function trainingGate(agent) {
  const R = rules();
  if (!R.enabled) return null;
  const e = await entitlements(agent);
  if ((e.training_until || 0) > Date.now()) return null;
  const since = Date.parse(`${day()}T00:00:00Z`);
  const n = await col('academy_attempts').countDocuments({ agent, split: 'train', ts: { $gte: since } });
  return n >= R.free.training_tasks_per_day ? `the free tier is ${R.free.training_tasks_per_day} training tasks a day (used). A training pass (academy_buy, product training_pass, $${R.prices_usd.training_pass}) lifts it for ${R.pass_days} days; the exam stays free.` : null;
}
/** Free-tier rows of the dataset left today for an agent (Infinity with a pass, or when the business is off); counts the rows it takes. */
export async function datasetAllowance(agent, want) {
  const R = rules();
  if (!R.enabled) return want;
  if (!agent) throw new Error(`agent: name your agent to export the dataset (free: ${R.free.dataset_rows_per_day} rows a day)`);
  const e = await entitlements(agent);
  if ((e.dataset_until || 0) > Date.now()) return want;
  const id = `academy_ds:${agent}:${day()}`;
  const used = (await metaGet(id, 0)) || 0, left = Math.max(0, R.free.dataset_rows_per_day - used), take = Math.min(left, want);
  if (take > 0) await metaSet(id, used + take);
  return take;
}

/** Create an order: what to pay, where, and the exact amount that identifies it. `pay_with`: near, usdc, or intents (any chain via 1Click). */
export async function createOrder(agent, product, { pay_with = 'usdc', origin_asset = null, refund_to = null } = {}) {
  const R = rules(), why = notReady(R, { paused: await paused() });
  if (why) throw new Error(`the Academy is not selling right now: ${why}`);
  if (!PRODUCTS[product]) throw new Error(`product: one of ${Object.keys(PRODUCTS).join(', ')}`);
  const usd = R.prices_usd[product];
  const { nearUsdPrice } = await import('../near/quotes.js');
  const nearUsd = pay_with === 'near' ? await nearUsdPrice() : null;
  if (pay_with === 'near' && !(nearUsd > 0)) throw new Error('the NEAR price is not known right now: pay in USDC, or try again');
  // a number no other open order of the last day uses
  const busy = new Set((await col('academy_orders').find({ status: 'open', created_ts: { $gt: Date.now() - DAY } }, { projection: { ref: 1 } }).toArray()).map((o) => o.ref));
  let ref = 0; for (let i = 0; i < 50 && (!ref || busy.has(ref)); i++) ref = randomInt(1, 1000);
  if (busy.has(ref)) throw new Error('too many open orders right now: try again in a minute');
  const amt = orderAmounts(usd, nearUsd, ref), now = Date.now();
  const o = { _id: `ord:${createHash('sha1').update(`${agent}|${product}|${now}|${ref}`).digest('hex').slice(0, 12)}`, agent, product, usd, ref, ref_code: `SN-${ref}`, pay_with, ...amt,
    status: 'open', created_ts: now, expires_ts: now + R.order_minutes * 60e3 };
  if (pay_with === 'intents') {
    if (!origin_asset || !refund_to) throw new Error('intents: origin_asset (the 1Click asset id you pay with, e.g. nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near) and refund_to (your address on that chain) are needed');
    const q = await oneClickQuote(R, { origin_asset, refund_to, usdc_raw: o.usdc_raw, deadline: new Date(o.expires_ts).toISOString() });
    Object.assign(o, { origin_asset, refund_to, deposit_address: q.depositAddress, deposit_amount: q.amountInFormatted, deposit_memo: q.depositMemo || null });
  }
  await col('academy_orders').insertOne(o);
  return { order: o._id, product, usd, expires: new Date(o.expires_ts).toISOString(), how_to_pay: howToPay(R, o) };
}
function howToPay(R, o) {
  const near = o.near_yocto ? `${(Number(BigInt(o.near_yocto) / 10n ** 18n) / 1e6).toFixed(6)} NEAR (exactly ${o.near_yocto} yoctoNEAR)` : null;
  if (o.pay_with === 'near') return { send: near, to: R.treasury, note: 'A plain NEAR transfer of exactly this amount: the amount names your order.' };
  if (o.pay_with === 'usdc') return { send: `${(Number(o.usdc_raw) / 1e6).toFixed(6)} USDC (exactly ${o.usdc_raw} raw, 6 decimals)`, token: R.usdc, to: R.treasury, memo: o.ref_code, note: 'ft_transfer of exactly this amount (the memo helps but is not needed); the treasury must be registered on the USDC contract.' };
  return { send: `${o.deposit_amount} of ${o.origin_asset}`, to: o.deposit_address, ...(o.deposit_memo ? { memo: o.deposit_memo } : {}), note: `NEAR Intents (1Click) swaps it into exactly ${(Number(o.usdc_raw) / 1e6).toFixed(6)} USDC for the treasury; a failed swap refunds to ${o.refund_to}.` };
}
/** A 1Click quote that delivers exactly the order's USDC to the treasury (EXACT_OUTPUT). */
async function oneClickQuote(R, { origin_asset, refund_to, usdc_raw, deadline }) {
  const body = { dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: 100, originAsset: origin_asset, depositType: 'ORIGIN_CHAIN', destinationAsset: `nep141:${R.usdc}`, amount: usdc_raw,
    refundTo: refund_to, refundType: 'ORIGIN_CHAIN', recipient: R.treasury, recipientType: 'DESTINATION_CHAIN', deadline, quoteWaitingTimeMs: 3000 };
  const r = await fetch('https://1click.chaindefuser.com/v0/quote', { method: 'POST', headers: { 'content-type': 'application/json', ...(R.oneclick_jwt ? { authorization: `Bearer ${R.oneclick_jwt}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.quote?.depositAddress) throw new Error(`NEAR Intents could not quote this: ${String(j.message || j.error || r.status).slice(0, 200)}`);
  return j.quote;
}

/** An order's state, with the 1Click swap's state for an intents order. */
export async function orderStatus(agent, id) {
  const o = await col('academy_orders').findOne({ _id: String(id), agent });
  if (!o) throw new Error('no such order for this agent');
  let swap = null;
  if (o.pay_with === 'intents' && o.status === 'open' && o.deposit_address) {
    try { const r = await fetch(`https://1click.chaindefuser.com/v0/status?depositAddress=${o.deposit_address}`, { signal: AbortSignal.timeout(15000) }); if (r.ok) swap = (await r.json()).status || null; } catch {}
  }
  return { order: o._id, product: o.product, usd: o.usd, status: o.status, ...(swap ? { swap } : {}), ...(o.paid ? { paid: o.paid } : {}), how_to_pay: o.status === 'open' ? howToPay(rules(), o) : undefined, expires: new Date(o.expires_ts).toISOString() };
}

/** The payments into the treasury in a raw indexer transaction: NEAR transfers (receipts) and USDC ft_transfers (events). Pure. */
export function paymentsIn(t, treasury, usdc) {
  const out = [], hash = t.transaction.hash;
  (t.receipts || []).forEach((r, i) => {
    const rc = r.receipt;
    if (rc?.receiver_id === treasury && rc.predecessor_id && rc.predecessor_id !== 'system') {
      for (const a of rc.receipt?.Action?.actions || []) if (a.Transfer && BigInt(a.Transfer.deposit || 0) > 0n) out.push({ id: `${hash}:${i}:n`, hash, currency: 'near', raw: String(a.Transfer.deposit), from: rc.predecessor_id });
    }
    const o = r.execution_outcome?.outcome;
    if (!o || o.status?.Failure || o.executor_id !== usdc) return;
    o.logs.forEach((l, k) => {
      if (!l.startsWith('EVENT_JSON:')) return;
      let ev; try { ev = JSON.parse(l.slice(11)); } catch { return; }
      if (ev.standard !== 'nep141' || ev.event !== 'ft_transfer') return;
      (ev.data || []).forEach((d, m) => { if (d.new_owner_id === treasury) out.push({ id: `${hash}:${i}:${k}:${m}`, hash, currency: 'usdc', raw: String(d.amount), from: d.old_owner_id, memo: d.memo || null }); });
    });
  });
  return out;
}

/** Look for new payments into the treasury and credit the orders they pay. Runs every minute in the worker. */
export async function scanPayments({ log = info } = {}) {
  const R = rules();
  if (!R.enabled || !R.treasury) return { skipped: true };
  const { newTxHashes } = await import('../near/indexer.js');
  const { txIndexer } = await import('../near/rpc.js');
  const cursor = await metaGet('academy_pay_cursor', null);
  const { hashes, head } = await newTxHashes(R.treasury, cursor?.height || 0);
  if (!cursor) { await metaSet('academy_pay_cursor', { height: head }); log(`academy: watching ${R.treasury} for payments from block ${head}`); return { started: head }; }
  let credited = 0, unmatched = 0;
  for (let i = 0; i < hashes.length; i += 20) {
    const j = await txIndexer('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) });
    for (const t of j.transactions || []) {
      for (const p of paymentsIn(t, R.treasury, R.usdc)) {
        if (await col('academy_ledger').findOne({ _id: `sale:${p.id}` })) continue;
        const orders = await col('academy_orders').find({ status: 'open' }).toArray();
        const o = matchOrder(orders, p);
        const { nearUsdPrice } = await import('../near/quotes.js');
        const usd = p.currency === 'usdc' ? Number(p.raw) / 1e6 : (Number(BigInt(p.raw) / 10n ** 18n) / 1e6) * ((await nearUsdPrice()) || 0);
        if (o) {
          const up = await col('academy_orders').updateOne({ _id: o._id, status: 'open' }, { $set: { status: 'paid', paid: { tx: p.hash, currency: p.currency, raw: p.raw, from: p.from, ts: Date.now() } } });
          if (!up.modifiedCount) continue;
          const a = await col('academy_agents').findOne({ _id: o.agent }, { projection: { ent: 1 } });
          await col('academy_agents').updateOne({ _id: o.agent }, { $set: { ent: grant(a?.ent, o.product, R.pass_days) } }, { upsert: true });
          await ledgerRow({ _id: `sale:${p.id}`, kind: 'sale', agent: o.agent, order: o._id, product: o.product, currency: p.currency, raw: p.raw, usd: r4(usd), from: p.from, tx: p.hash, distributed: false });
          credited++; log(`academy: ${o.agent} paid ${o.product} ($${o.usd}) in ${p.currency}, tx ${p.hash}`);
        } else {
          // money with no order (a tip, a wrong amount): still revenue, split like a sale; shown as such on the ledger
          await ledgerRow({ _id: `sale:${p.id}`, kind: 'sale', agent: null, note: 'a payment that matches no open order', currency: p.currency, raw: p.raw, usd: r4(usd), from: p.from, tx: p.hash, distributed: false });
          unmatched++;
        }
      }
    }
  }
  await metaSet('academy_pay_cursor', { height: Math.max(head, cursor.height) });
  await col('academy_orders').updateMany({ status: 'open', expires_ts: { $lt: Date.now() - 6 * 3600e3 } }, { $set: { status: 'expired' } }); // a late payment within 6 h still counts
  return { credited, unmatched, txs: hashes.length };
}

/** Count NEAR AI tokens per UTC day (called by the AI client after every call). */
export async function countTokens(usage) {
  if (!usage) return;
  await col('meta').updateOne({ _id: `ai_tokens:${day()}` }, { $inc: { 'value.prompt': usage.prompt_tokens || 0, 'value.completion': usage.completion_tokens || 0, 'value.calls': 1 }, $set: { ts: Date.now() } }, { upsert: true });
}
/** Extra AI calls today, paid by the reserve (0 when the business is off). Read by the AI budget. */
export async function extraAiCalls() {
  if (!rules().enabled) return 0;
  const m = await metaGet('academy_ai_extra', null);
  return m?.day === day() ? m.calls : 0;
}

/**
 * The transaction check of a payout, without the one finding a person already accepted by choosing the currency: "the USDC contract is a
 * high-risk contract" (its issuer can freeze and upgrade it). Every other finding stays, the recipient's above all. When nothing else is
 * left, the verdict is ok; otherwise it is unchanged. Pure.
 */
export function withoutOwnTokenRisk(check, usdc) {
  const own = (f) => f.code === 'risky_contract' && String(f.title || '').startsWith(`${usdc} `);
  const findings = (check?.findings || []).filter((f) => !own(f));
  if (findings.length === (check?.findings || []).length) return check;
  return { ...check, findings, verdict: findings.some((f) => f.severity !== 'info') ? check.verdict : 'ok' };
}
// an answer that only lacked data (a cold price cache, a lookup past its time) is asked again, up to twice
const transient = (reasons = []) => reasons.length && reasons.every((r) => /no price|price is not known|could not look up everything/i.test(r));

/** Check a payout with the Agent Guard: allow, or the reasons it was stopped. */
export async function guardPayout(R, p, spentUsdToday) {
  const { localApi } = await import('../agent/api.js');
  const { transactionsOf, policyViolations, decide } = await import('../agent/policy.js');
  if (![R.reserve_account, ...R.contributors].includes(p.to)) return { decision: 'block', reasons: [`${p.to} is not a payee in the rules`] };
  const body = { transaction: payoutTx(R, p) }, policy = payoutPolicy(R), api = await localApi();
  let d;
  for (let i = 0; i < 3; i++) {
    const check = withoutOwnTokenRisk(await api.checkTx(body), R.usdc);
    d = decide(check, policyViolations(transactionsOf(body), policy, { spentUsdToday, value: check.value || null }), policy);
    if (d.decision === 'allow' || !transient(d.reasons)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return d;
}
/** Propose the payout on the treasury DAO and approve it, as the agent (function-call key). */
async function daoTransfer(R, p, description) {
  const { callAsAgent } = await import('../near/sign.js');
  const { view } = await import('../near/rpc.js');
  const pol = await view(R.treasury, 'get_policy', {});
  if (BigInt(pol?.proposal_bond || 0) > 0n) throw new Error(`the DAO's proposal bond is ${pol.proposal_bond} yocto: the agent's function-call key cannot attach a deposit, so the bond must be 0`);
  const kind = transferKind(R, p), who = { signerId: R.agent_account, secret: R.agent_key, receiverId: R.treasury };
  const add = await callAsAgent({ ...who, calls: [{ method: 'add_proposal', args: { proposal: { description, kind } }, gas: '50000000000000' }] });
  if (!Number.isInteger(add.value)) throw new Error(`add_proposal returned no proposal id (${add.hash})`);
  const act = await callAsAgent({ ...who, calls: [{ method: 'act_proposal', args: { id: add.value, action: 'VoteApprove', proposal: kind }, gas: '200000000000000' }] });
  return { proposal: add.value, txs: [add.hash, act.hash] };
}

/**
 * The daily close (after payout_hour_utc, once a day): book yesterday's AI cost, split the revenue not yet paid out and pay it (each payout
 * guarded, then through the DAO), and set today's extra AI calls from the reserve. `dry`: compute and report, change nothing.
 */
export async function dailyClose({ force = false, dry = false, log = info } = {}) {
  const R = rules(), why = notReady(R, { paused: await paused() });
  if (why) return { skipped: why };
  const today = day(), yesterday = day(Date.now() - DAY);
  if (!force && (new Date().getUTCHours() < R.payout_hour_utc || (await metaGet(`academy_close:${today}`, null)))) return { skipped: 'not due' };
  if (!R.agent_account || !R.agent_key) return { skipped: 'no agent account or key: payouts need ACADEMY_AGENT_ACCOUNT and ACADEMY_AGENT_KEY' };
  const report = { day: today, cost: null, payouts: [], held: [], kept: [] };
  // 1. yesterday's AI cost
  const tok = await metaGet(`ai_tokens:${yesterday}`, null);
  if (tok) { report.cost = { day: yesterday, usd: costUsd(tok, R.inference), ...tok }; if (!dry) await ledgerRow({ _id: `cost:${yesterday}`, kind: 'cost', usd: report.cost.usd, note: `NEAR AI: ${tok.calls || 0} calls, ${tok.prompt || 0} input and ${tok.completion || 0} output tokens on ${yesterday}`, cost_day: yesterday }); }
  // 2. the revenue not yet paid out, per currency
  const sales = await col('academy_ledger').find({ kind: 'sale', distributed: false }).toArray();
  const { nearUsdPrice } = await import('../near/quotes.js');
  const nearUsd = (await nearUsdPrice()) || 0;
  const usdOf = (currency, raw) => (currency === 'usdc' ? Number(raw) / 1e6 : (Number(BigInt(raw) / 10n ** 18n) / 1e6) * nearUsd);
  let spent = (await col('academy_ledger').find({ kind: 'payout', day: today }).toArray()).reduce((s, x) => s + (x.usd || 0), 0);
  // one payout: guarded, then through the DAO. A payout the guard stops or that fails is a "held" row, tried again at every close until paid
  const payOne = async (row, heldId) => {
    const p = { to: row.to, currency: row.currency, raw: row.raw };
    const g = await guardPayout(R, p, spent);
    const hold = async (note) => {
      report.held.push({ ...row, note });
      if (!dry) await col('academy_ledger').updateOne({ _id: heldId }, { $set: { note, tried_day: today }, $setOnInsert: { ts: Date.now(), day: today, kind: 'held', ...row, settled: false } }, { upsert: true });
    };
    if (g.decision !== 'allow') return hold(`Agent Guard: ${g.decision}: ${(g.reasons || []).join('; ').slice(0, 300)}`);
    if (dry) { report.payouts.push({ ...row, guard: 'allow', dry: true }); return; }
    try {
      const t = await daoTransfer(R, p, `Safe Near Academy ${today}: ${row.role} share of ${row.currency.toUpperCase()} revenue`);
      spent += row.usd; report.payouts.push({ ...row, ...t });
      await ledgerRow({ _id: `payout:${t.txs[1]}`, kind: 'payout', ...row, proposal: t.proposal, tx: t.txs[1], txs: t.txs, guard: 'allow', ...(heldId.startsWith('held:') ? { was_held: heldId } : {}) });
      await col('academy_ledger').updateOne({ _id: heldId, kind: 'held' }, { $set: { settled: true, settled_day: today } });
    } catch (e) { warn(`academy payout to ${row.to} failed: ${e.message}`); await hold(`payout failed: ${e.message.slice(0, 300)}`); }
  };
  // first what earlier closes could not pay
  for (const h of await col('academy_ledger').find({ kind: 'held', settled: false }).toArray()) {
    await payOne({ role: h.role, to: h.to, currency: h.currency, raw: h.raw, usd: r4(usdOf(h.currency, h.raw)) }, h._id);
  }
  for (const currency of ['usdc', 'near']) {
    const mine = sales.filter((s) => s.currency === currency);
    if (!mine.length) continue;
    const total = mine.reduce((s, x) => s + BigInt(x.raw), 0n);
    for (const sh of splitShares(total, R.split, { reserveAccount: R.reserve_account, contributors: R.contributors })) {
      const usd = r4(usdOf(currency, sh.raw)), row = { role: sh.role, to: sh.to, currency, raw: sh.raw, usd };
      if (sh.role === 'treasury' || usd < R.limits.min_usd_to_pay_out) { report.kept.push(row); if (!dry) await ledgerRow({ _id: `kept:${today}:${currency}:${sh.role}:${sh.to || '-'}`, kind: 'kept', ...row, note: sh.role === 'treasury' ? 'the treasury\'s share stays in the DAO' : `under $${R.limits.min_usd_to_pay_out}: stays in the DAO` }); continue; }
      await payOne(row, `held:${today}:${currency}:${sh.to}`);
    }
    // the sales are split once: what was not paid now is a held row, retried at the next close
    if (!dry) await col('academy_ledger').updateMany({ _id: { $in: mine.map((s) => s._id) } }, { $set: { distributed: true, closed_day: today } });
  }
  // 3. today's extra AI calls, from what the reserve received minus what the AI cost
  const totals = await ledgerTotals();
  const reserveLeft = Math.max(0, totals.reserve_usd - totals.cost_usd);
  report.extra_ai_calls = extraCalls(reserveLeft, R.inference);
  if (!dry) { await metaSet('academy_ai_extra', { day: today, calls: report.extra_ai_calls, reserve_left_usd: r2(reserveLeft) }); await metaSet(`academy_close:${today}`, { ts: Date.now() }); }
  log(`academy close ${today}: ${report.payouts.length} payouts, ${report.held.length} held, ${report.extra_ai_calls} extra AI calls${dry ? ' (dry)' : ''}`);
  return report;
}

/** The ledger's totals: revenue, costs, payouts by role, and what the reserve has left. */
export async function ledgerTotals() {
  const rows = await col('academy_ledger').aggregate([{ $group: { _id: { kind: '$kind', role: '$role' }, usd: { $sum: '$usd' }, n: { $sum: 1 } } }]).toArray();
  const s = (kind, role) => rows.filter((r) => r._id.kind === kind && (role === undefined || r._id.role === role)).reduce((a, r) => a + r.usd, 0);
  const n = (kind) => rows.filter((r) => r._id.kind === kind).reduce((a, r) => a + r.n, 0);
  return { revenue_usd: r2(s('sale')), sales: n('sale'), cost_usd: r2(s('cost')), paid_out_usd: r2(s('payout')), reserve_usd: r2(s('payout', 'reserve')), contributors_usd: r2(s('payout', 'contributor')), held: await col('academy_ledger').countDocuments({ kind: 'held', settled: false }), certificates: n('certificate') };
}
/** The public ledger: rows newest first, the totals, and the rules (without secrets). */
export async function publicLedger({ limit = 100, kind = null } = {}) {
  const R = rules();
  const rows = await col('academy_ledger').find(kind ? { kind: String(kind) } : {}).sort({ ts: -1 }).limit(Math.min(500, Math.max(1, Number(limit) || 100))).toArray();
  return {
    business: { enabled: R.enabled, paused: !!R.paused || (await paused()), treasury: R.treasury || null, agent: R.agent_account || null, reserve: R.reserve_account || null, contributors: R.contributors,
      prices_usd: R.prices_usd, split: R.split, limits: R.limits, free: R.free, pass_days: R.pass_days, inference: R.inference },
    totals: await ledgerTotals(), ai_extra_today: await metaGet('academy_ai_extra', null),
    rows: rows.map(({ distributed, ...x }) => ({ ...x, id: x._id, _id: undefined, time: new Date(x.ts).toISOString() })),
  };
}

/** Certify an agent's finished exam on a track: uses one certificate, writes a public ledger row anyone can check by its id. */
export async function certify(agent, track, examResult) {
  const R = rules();
  if (!R.enabled) throw new Error('certificates are sold by the Academy\'s business, which is off');
  if (!examResult.done) throw new Error(`finish the exam first: ${examResult.answered} of ${examResult.tasks} answered`);
  const a = await col('academy_agents').findOneAndUpdate({ _id: agent, 'ent.certificates': { $gte: 1 } }, { $inc: { 'ent.certificates': -1 } });
  const doc = a && typeof a === 'object' && 'ok' in a ? a.value : a; // driver versions differ
  if (!doc) throw new Error(`no certificate left: buy one with academy_buy (product exam_certificate, $${R.prices_usd.exam_certificate})`);
  const id = `cert:${createHash('sha1').update(`${agent}|${track}|${Date.now()}`).digest('hex').slice(0, 16)}`;
  await ledgerRow({ _id: id, kind: 'certificate', agent, track, score: examResult.score, tasks: examResult.tasks, by_level: examResult.by_level, usd: 0 });
  return { certificate: id, agent, track, score: examResult.score, tasks: examResult.tasks, verify: `GET /api/v1/academy/ledger?kind=certificate (id ${id})` };
}
