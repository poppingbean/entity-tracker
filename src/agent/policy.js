// Agent Guard policy: what an AI agent may sign, decided before it signs. The owner of the agent sets the policy (spending limits, who it may
// pay or call, which actions it may never take); Safe Near's transaction check says whether the transaction itself is dangerous. Both
// together give one answer: allow, ask a human, or block. Pure functions: no network, no state (the caller keeps today's spending).
import { decodeRequest, toNear } from '../firewall/decode.js';

/** Actions an agent should never take on its own: each hands over the account or ends it. */
export const DANGEROUS_ACTIONS = { add_full_access_key: 'adds a FULL ACCESS key (whoever holds it controls the account)', delete_account: 'deletes the account',
  deploy_contract: 'replaces the code on the account', delete_key: 'removes an access key', stake: 'stakes NEAR with a validator' };

const NAME_RX = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const validAccount = (id) => typeof id === 'string' && id.length >= 2 && id.length <= 64 && NAME_RX.test(id);
const METHOD_RX = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const PUBLIC_KEY_RX = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * Anything in the input that looks like a secret (a private key or a seed phrase): the guard never needs one, and an agent that sends one
 * is leaking it. Returns a short description of what was found, or null.
 */
export function findSecret(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (/(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{80,}/.test(s)) return 'a private key';
  if (/"(private_?key|secret_?key|seed_?phrase|mnemonic)"\s*:/i.test(s)) return 'a private key or seed phrase field';
  // a seed phrase is a whole value of 12-24 short lowercase words (a sentence in a memo is not)
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(value);
  // BIP39 has none of these everyday words, so a value that uses them is prose
  const PROSE = new Set(['the', 'and', 'with', 'this', 'that', 'you', 'your', 'for', 'from', 'into', 'are', 'was', 'please', 'thanks', 'then', 'not', 'but']);
  const phrase = (x) => { const w = x.trim().split(/\s+/); return [12, 15, 18, 21, 24].includes(w.length) && w.every((y) => /^[a-z]{3,8}$/.test(y)) && !w.some((y) => PROSE.has(y)); };
  if (strings.some(phrase)) return 'what looks like a seed phrase';
  return null;
}

/** The policy with its defaults. Unknown fields are ignored; numbers must be positive. */
export function normalizePolicy(p = {}) {
  const num = (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null);
  const list = (x) => (Array.isArray(x) ? x.map((v) => String(v).trim().toLowerCase()).filter(Boolean).slice(0, 200) : []);
  return {
    max_near_per_tx: num(p.max_near_per_tx), max_near_per_request: num(p.max_near_per_request), max_near_per_day: num(p.max_near_per_day),
    max_usd_per_tx: num(p.max_usd_per_tx), max_usd_per_request: num(p.max_usd_per_request), max_usd_per_day: num(p.max_usd_per_day),
    allowed_receivers: list(p.allowed_receivers), allowed_methods: list(p.allowed_methods),
    forbidden_actions: p.forbidden_actions ? list(p.forbidden_actions) : Object.keys(DANGEROUS_ACTIONS),
    block_on: Array.isArray(p.block_on) ? list(p.block_on) : ['block'], ask_on: Array.isArray(p.ask_on) ? list(p.ask_on) : ['warn'],
  };
}

/** "*.ref-finance.near" matches the account and its sub-accounts; anything else must match exactly. */
const matches = (id, pattern) => (pattern.startsWith('*.') ? id === pattern.slice(2) || id.endsWith(pattern.slice(1)) : id === pattern);

/** The transactions in any shape the firewall accepts (wallet-selector, near-api-js / RPC JSON, Borsh base64, a meta transaction). */
export const transactionsOf = (body) => decodeRequest(body);

/**
 * What the policy says about these transactions: { violations: [{ code, detail, tx, action }], asks: [...], near_total, usd_total }.
 * Spending counts everything that leaves the account, not only attached NEAR: NEAR attached or staked, wNEAR sent with ft_transfer (counted
 * as NEAR), and any token or NEAR Intents balance sent out (`value.moves` from the transaction check, valued in USD today). A token with no
 * price cannot be checked against a USD limit: it is an `ask` (a person decides), never a silent pass. `spentToday` / `spentUsdToday` are what
 * this agent already spent today (the agent's runtime keeps them; the guard holds no state).
 */
export function policyViolations(txs, policy, { spentToday = 0, spentUsdToday = 0, value = null } = {}) {
  const P = normalizePolicy(policy), out = [], asks = [];
  const nearUsd = Number(value?.near_usd) > 0 ? Number(value.near_usd) : null;
  const moves = Array.isArray(value?.moves) ? value.moves : [];
  const usdLimited = P.max_usd_per_tx != null || P.max_usd_per_request != null || P.max_usd_per_day != null;
  let total = 0, totalUsd = 0, usdKnown = true;
  txs.forEach((t, ti) => {
    const receiver = String(t.receiver || '').toLowerCase();
    // the agent's own account is not a receiver to allow: what it does there (keys, code, deletion) is up to forbidden_actions
    const self = receiver === String(t.signer || '').toLowerCase();
    if (!self && P.allowed_receivers.length && !P.allowed_receivers.some((p) => matches(receiver, p))) out.push({ code: 'receiver_not_allowed', detail: `${receiver} is not on the allowed list`, tx: ti });
    let txNear = 0, txUsd = 0;
    for (const a of t.actions) {
      const kind = a.kind === 'add_key' && a.permission === 'full' ? 'add_full_access_key' : a.kind;
      if (P.forbidden_actions.includes(kind)) out.push({ code: 'forbidden_action', detail: `this ${DANGEROUS_ACTIONS[kind] || kind.replace(/_/g, ' ')}`, tx: ti, action: a.index });
      if (a.kind === 'function_call' && P.allowed_methods.length && !P.allowed_methods.includes(String(a.method).toLowerCase())) out.push({ code: 'method_not_allowed', detail: `${a.method} is not an allowed method`, tx: ti, action: a.index });
      txNear += (a.deposit != null ? toNear(a.deposit) : 0) || 0;
      if (a.kind === 'stake') txNear += toNear(a.stake) || 0;
    }
    if (nearUsd) txUsd += txNear * nearUsd; else if (txNear > 0) usdKnown = false;
    // tokens and NEAR Intents balances sent out by this transaction; a token sent to the agent's own account is not spending
    for (const m of moves.filter((x) => x.tx === ti && String(x.to || '').toLowerCase() !== String(t.signer || '').toLowerCase())) {
      if (m.token === 'wrap.near' && /^\d+$/.test(String(m.raw))) txNear += toNear(m.raw) || 0; // wNEAR is NEAR for the NEAR limits
      if (m.usd != null) txUsd += m.usd;
      else { usdKnown = false; if (usdLimited) asks.push({ code: 'unpriced_token', detail: `sends ${m.amount ?? m.raw} ${m.symbol || m.token}, which has no price: a USD limit cannot be checked`, tx: ti, action: m.action }); }
    }
    if (P.max_near_per_tx != null && txNear > P.max_near_per_tx) out.push({ code: 'over_tx_limit', detail: `sends ${round(txNear)} NEAR, over the limit of ${P.max_near_per_tx} NEAR per transaction`, tx: ti });
    if (P.max_usd_per_tx != null && txUsd > P.max_usd_per_tx) out.push({ code: 'over_tx_usd_limit', detail: `sends about $${round2(txUsd)}, over the limit of $${P.max_usd_per_tx} per transaction`, tx: ti });
    total += txNear; totalUsd += txUsd;
  });
  if (usdLimited && !nearUsd && total > 0) asks.push({ code: 'no_near_price', detail: 'the NEAR price is not known right now: a USD limit cannot be checked' });
  if (P.max_near_per_request != null && total > P.max_near_per_request) out.push({ code: 'over_request_limit', detail: `sends ${round(total)} NEAR in all, over the limit of ${P.max_near_per_request} NEAR per request` });
  if (P.max_near_per_day != null && spentToday + total > P.max_near_per_day) out.push({ code: 'over_daily_limit', detail: `${round(spentToday)} NEAR spent today + ${round(total)} NEAR would pass the daily limit of ${P.max_near_per_day} NEAR` });
  if (P.max_usd_per_request != null && totalUsd > P.max_usd_per_request) out.push({ code: 'over_request_usd_limit', detail: `sends about $${round2(totalUsd)} in all, over the limit of $${P.max_usd_per_request} per request` });
  if (P.max_usd_per_day != null && spentUsdToday + totalUsd > P.max_usd_per_day) out.push({ code: 'over_daily_usd_limit', detail: `$${round2(spentUsdToday)} spent today + about $${round2(totalUsd)} would pass the daily limit of $${P.max_usd_per_day}` });
  return { violations: out, asks, near_total: round(total), usd_total: usdKnown ? round2(totalUsd) : null };
}
const round2 = (x) => Math.round(x * 100) / 100;
const round = (x) => Math.round(x * 1e4) / 1e4;

/**
 * One answer for the agent: allow, ask_human, or block, from the transaction check (`firewall`: its verdict and findings) and the policy.
 * A policy violation blocks; the check's verdict blocks or asks a human as the policy says (by default block on "block", ask on "warn").
 */
export function decide(firewall, policyResult, policy) {
  const P = normalizePolicy(policy), verdict = firewall?.verdict || 'ok';
  // a check that could not look everything up (lookups past their time budget) is not a clean pass: a person decides
  const incomplete = firewall?.context?.complete === false;
  const asks = [...(policyResult.asks || []).map((v) => `policy: ${v.detail}`), ...(incomplete ? ['the check could not look up everything in time: not a clean pass'] : [])];
  const reasons = [...policyResult.violations.map((v) => `policy: ${v.detail}`), ...asks, ...(firewall?.findings || []).filter((f) => f.severity !== 'info').map((f) => `${f.severity}: ${f.title}`)]; // details stay in the findings
  const decision = policyResult.violations.length || P.block_on.includes(verdict) ? 'block' : P.ask_on.includes(verdict) || asks.length ? 'ask_human' : 'allow';
  const say = { allow: 'Allowed: nothing in the check or the policy stops this transaction.', ask_human: 'Ask a human first: the check found something a person should confirm.', block: 'Blocked: do not sign this transaction.' };
  return { decision, message: say[decision], firewall_verdict: verdict, near_total: policyResult.near_total, usd_total: policyResult.usd_total ?? null, complete: !incomplete, reasons };
}

/**
 * The key an agent should hold instead of the owner's full access: a function-call key limited to one contract and its methods, with a NEAR
 * allowance that only pays gas (a function-call key can never attach a deposit, so it cannot send NEAR or tokens that need one). Returns the
 * transaction the OWNER signs once, in wallet-selector shape, and what it does and does not allow.
 */
export function scopedKeyPlan({ owner, contract, methods = [], public_key, allowance_near = 0.25 }) {
  if (!validAccount(owner)) throw new Error('owner: the NEAR account the agent acts for');
  if (!validAccount(contract)) throw new Error('contract: the one contract the agent may call');
  if (!PUBLIC_KEY_RX.test(String(public_key || ''))) throw new Error('public_key: the agent\'s new PUBLIC key, ed25519:<base58> (never send a private key)');
  const ms = [...new Set((methods || []).map(String))];
  const bad = ms.find((m) => !METHOD_RX.test(m));
  if (bad) throw new Error(`methods: "${bad}" is not a method name`);
  const allow = Number(allowance_near);
  if (!Number.isFinite(allow) || allow <= 0 || allow > 10) throw new Error('allowance_near: between 0 and 10 NEAR (it only pays gas)');
  const yocto = (BigInt(Math.round(allow * 1e6)) * 10n ** 18n).toString();
  return {
    transaction: { signerId: owner, receiverId: owner, actions: [{ type: 'AddKey', params: { publicKey: public_key, accessKey: { nonce: 0, permission: { receiverId: contract, methodNames: ms, allowance: yocto } } } }] },
    allows: [`calling ${ms.length ? ms.join(', ') : 'any method that takes no deposit'} on ${contract}`, `spending up to ${allow} NEAR on gas, then the key stops working until topped up`],
    never_allows: ['sending NEAR or attaching a deposit', `calling any other contract than ${contract}`, 'adding or removing keys, deploying code, deleting the account'],
    revoke: { signerId: owner, receiverId: owner, actions: [{ type: 'DeleteKey', params: { publicKey: public_key } }] },
    note: `The owner signs this once with their own wallet; the agent keeps only the private half of ${public_key}. To revoke it, the owner signs the revoke transaction.`,
  };
}
