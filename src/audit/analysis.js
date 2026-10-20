// Code-level and behaviour-level checks for NEAR contracts (ported from the TrustFlow backend's nearContractAnalysis).
// Access keys alone say nothing about what the contract code does: a keyless ("locked") token can still carry an owner backdoor.
// Example: doge.neardogecoin.near exports a fake `storage_unstake(account_id, amount)` that the owner calls on buyers to zero their
// balance, so every later sell panics with "doesn't have enough balance".
import { txIndexer } from '../near/rpc.js';
import { bilingualDetail, makeCheck, sellBehaviourFactors } from './factors.js';

// NEP-141 (FT core), NEP-148 (metadata), NEP-145 (storage), NEP-330 (source metadata), plus the usual init / migration entry points.
// storage_minimum_balance is from the early NEP-145 draft (still exported by wrap.near): legitimate, not a fake storage method.
const NEP145 = new Set(['storage_deposit', 'storage_withdraw', 'storage_unregister', 'storage_balance_of', 'storage_balance_bounds', 'storage_minimum_balance']);
const IS_GETTER = /^(get_|is_|view_)|_(status|of|list|info)$|^guardians$/;
export const STANDARD = new Set(['ft_transfer', 'ft_transfer_call', 'ft_total_supply', 'ft_balance_of', 'ft_resolve_transfer', 'ft_metadata', ...NEP145, 'contract_source_metadata', 'new', 'new_default_meta', 'migrate']);
// Widely used, harmless exports outside the core standards: never warned (ABI, receiver hook, burning one's OWN tokens, wNEAR-style
// wrapping, two-step ownership transfer, version / owner getters, metadata getters).
const SAFE_METHODS = new Set([
  '__contract_abi', 'ft_on_transfer', 'burn', 'ft_burn', 'near_deposit', 'near_withdraw', 'version', 'owner', 'owner_id', 'get_owner', 'get_owner_id',
  'propose_new_owner', 'propose_owner_transfer', 'accept_ownership', 'accept_owner_transfer', 'cancel_owner_transfer', 'transfer_ownership', 'renounce_ownership',
  'name', 'symbol', 'decimals', 'icon', 'spec', 'reference',
]);
const IS_CALLBACK = /^on_|_callback$|^resolve_/; // near-sdk cross-contract callbacks are #[private] by convention
const PRIVILEGED_NAME = /blacklist|blocklist|ban_|freeze|unfreeze|pause|seize|confiscate|destroy|set_fee|set_tax|whitelist|withdraw_token|force_transfer|set_balance|burn_from|admin|tradable|set_trading|enable_trading|disable_trading|^mint|_mint$|^issue$|^upgrade$/i;
const OWNER_GUARD = /only the owner|only owner|caller is not the owner|unauthorized|not allowed|only admin/i;
// Receivers a holder sells into (DEX pools / aggregators / intents).
const DEX_RECEIVER = /(^|\.)ref-finance\.near$|ref-labs\.near$|^aggregatedex\.near$|^intents\.near$|veax\.near$|^dex|\.dex\./;

export function wasmExports(buf) {
  try { return WebAssembly.Module.exports(new WebAssembly.Module(buf)).filter((e) => e.kind === 'function').map((e) => e.name); }
  catch { return null; }
}

export function staticAnalysis(code, isToken) {
  const exports = wasmExports(code);
  if (!exports) return null;
  const strings = code.toString('latin1').match(/[ -~]{6,}/g) || [];
  const fakeStorage = exports.filter((m) => m.startsWith('storage_') && !NEP145.has(m));
  const privilegedNames = isToken ? exports.filter((m) => PRIVILEGED_NAME.test(m) && !IS_GETTER.test(m)) : [];
  // Only genuinely unknown methods count as non-standard: known-safe exports and read-only getters pass; privileged ones have their own check.
  const nonStandard = exports.filter((m) => !STANDARD.has(m) && !fakeStorage.includes(m) && !SAFE_METHODS.has(m) && !privilegedNames.includes(m) && !IS_GETTER.test(m) && !IS_CALLBACK.test(m));
  return { exports, fakeStorage, nonStandard, privilegedNames, ownerGuard: strings.some((s) => OWNER_GUARD.test(s)), isToken };
}

const firstCall = (tx) => {
  for (const a of tx.actions || []) {
    if (a.FunctionCall) return a.FunctionCall;
    const inner = a.Delegate?.delegate_action?.actions?.find((x) => x.FunctionCall);
    if (inner) return inner.FunctionCall;
  }
  return null;
};
const parseArgs = (fc) => { try { return JSON.parse(Buffer.from(fc.args, 'base64').toString()); } catch { return {}; } };

// Account ids stored in the contract's own STATE struct (owner, admins ...).
const ACCOUNT_IN_STATE = /[0-9a-f]{64}|(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*\.(?:near|tg)/g;
export function stateAccounts(stateValues, contract) {
  const found = new Set();
  for (const { value } of stateValues) for (const m of value.toString('latin1').match(ACCOUNT_IN_STATE) || []) if (m !== contract) found.add(m);
  return [...found].slice(0, 3);
}

const fetchTx = async (hashes) => {
  const out = [];
  for (let i = 0; i < hashes.length; i += 20) out.push(...((await txIndexer('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) })).transactions || []));
  return out;
};

// Calls a privileged account (from STATE) made to the token's non-standard methods with someone else's account_id: e.g. an owner wiping
// buyers' balances. Owners transact far less than the token itself, so their own history is scanned.
async function privilegedCallsFromState(contract, stateValues) {
  const out = {};
  for (const acct of stateAccounts(stateValues, contract)) {
    const j = await txIndexer('/v0/account', { account_id: acct });
    const hashes = (j.account_txs || []).filter((x) => x.is_signer && x.is_success).slice(0, 100).map((x) => x.transaction_hash);
    for (const t of await fetchTx(hashes)) {
      const fc = firstCall(t.transaction);
      if (!fc || t.transaction.receiver_id !== contract || STANDARD.has(fc.method_name)) continue;
      const target = parseArgs(fc).account_id;
      if (target && target !== acct) out[`${acct}:${fc.method_name}`] = (out[`${acct}:${fc.method_name}`] || 0) + 1;
    }
  }
  return out;
}

/** Recent on-chain behaviour of the token: do holders' sells go through, and is anyone calling non-standard methods against other people's accounts? */
export async function behaviourAnalysis(contract, stateValues = []) {
  const pages = [];
  let resume = null;
  for (let p = 0; p < 3; p++) {
    const j = await txIndexer('/v0/account', { account_id: contract, ...(resume ? { resume_token: resume } : {}) });
    pages.push(...(j.account_txs || []));
    if (!j.resume_token) break;
    resume = j.resume_token;
  }
  if (!pages.length) return null;
  const failed = pages.filter((x) => !x.is_success).slice(0, 60).map((x) => x.transaction_hash);
  const recent = pages.filter((x) => x.is_success).slice(0, 80).map((x) => x.transaction_hash);
  const txs = await fetchTx([...new Set([...failed, ...recent])]);

  let sellOk = 0, sellFail = 0, buys = 0;
  const failReasons = {}, sellers = {}, privileged = {};
  for (const t of txs) {
    const tx = t.transaction, fc = firstCall(tx);
    const tokenFailure = (t.receipts || []).map((r) => r.execution_outcome?.outcome).find((o) => o?.executor_id === contract && o.status?.Failure);
    if (fc && tx.receiver_id === contract) {
      const args = parseArgs(fc);
      if (fc.method_name === 'ft_transfer_call' && DEX_RECEIVER.test(args.receiver_id || '')) {
        const sc = sellers[tx.signer_id] || (sellers[tx.signer_id] = { ok: 0, fail: 0 });
        if (tokenFailure) {
          sc.fail++; sellFail++;
          const msg = (JSON.stringify(tokenFailure.status.Failure).match(/panicked: ([^"\\]+)/) || [])[1] || 'execution error';
          failReasons[msg] = (failReasons[msg] || 0) + 1;
        } else { sc.ok++; sellOk++; }
      } else if (!STANDARD.has(fc.method_name) && args.account_id && args.account_id !== tx.signer_id && !tokenFailure) {
        const k = `${tx.signer_id}:${fc.method_name}`; privileged[k] = (privileged[k] || 0) + 1;
      }
    }
    // A buy: the token pays a holder out of a DEX in this transaction.
    for (const r of t.receipts || []) {
      const o = r.execution_outcome?.outcome;
      if (o?.executor_id !== contract) continue;
      for (const l of o.logs || []) if (l.includes('"ft_transfer"') && /"old_owner_id":"[^"]*(ref-finance|ref-labs|aggregatedex)/.test(l)) { buys++; break; }
    }
  }
  try { for (const [k, v] of Object.entries(await privilegedCallsFromState(contract, stateValues))) privileged[k] = Math.max(privileged[k] || 0, v); } catch { /* best effort */ }
  const top = Object.entries(privileged).sort((a, b) => b[1] - a[1])[0] || null;
  const st = Object.values(sellers);
  return {
    sampled: txs.length, sellOk, sellFail, buys,
    blockedSellers: st.filter((s) => s.fail > 0 && s.ok === 0).length, successfulSellers: st.filter((s) => s.ok > 0).length,
    topFailReason: Object.entries(failReasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    privilegedCalls: Object.values(privileged).reduce((a, b) => a + b, 0),
    topPrivileged: top ? { who: top[0].split(':')[0], method: top[0].split(':')[1], count: top[1] } : null,
  };
}

/** Code and behaviour factors, in the same checklist shape as nearFactors(). Behaviour factors only when the history could be fetched. */
export function codeFactors(stat, beh) {
  const factors = [], check = makeCheck(factors);
  if (stat) {
    check('fakeStorageMethod', 'Contract exports a fake storage method that is not part of NEP-145 (common honeypot backdoor)', 'Hợp đồng có hàm storage giả không thuộc chuẩn NEP-145 (backdoor honeypot phổ biến)', 'critical', 30, stat.fakeStorage.length > 0, stat.fakeStorage.join(', ') || null);
    check('privilegedMethods', 'Contract exposes privileged methods (blacklist/freeze/pause/fee/seize/mint/upgrade...)', 'Hợp đồng có hàm đặc quyền (blacklist/đóng băng/tạm dừng/phí/thu hồi/mint/nâng cấp...)', 'ownership', 20, stat.privilegedNames.length > 0, stat.privilegedNames.join(', ') || null);
    check('ownerGuardedCode', 'Code contains owner-only guards on non-standard methods', 'Mã có kiểm tra chỉ-chủ-sở-hữu trên các hàm ngoài chuẩn', 'ownership', 12, stat.ownerGuard && (stat.nonStandard.length > 0 || stat.fakeStorage.length > 0));
    if (stat.isToken) check('nonStandardMethods', 'Token exports methods outside the NEAR token standards', 'Token có các hàm ngoài chuẩn token của NEAR', 'ownership', 8, stat.nonStandard.length > 0, stat.nonStandard.slice(0, 8).join(', ') || null);
  }
  if (beh) {
    factors.push(...sellBehaviourFactors(beh));
    const tp = beh.topPrivileged;
    check('privilegedCallsOnHolders', "A privileged account calls non-standard methods on other holders' accounts", 'Một tài khoản đặc quyền gọi hàm ngoài chuẩn lên tài khoản của người nắm giữ khác', 'critical', 50, beh.privilegedCalls >= 2, tp ? { en: `${tp.method} x${tp.count} by ${tp.who.slice(0, 20)}`, vi: `${tp.method} x${tp.count} bởi ${tp.who.slice(0, 20)}` } : null);
  }
  return factors;
}
