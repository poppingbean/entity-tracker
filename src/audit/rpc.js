// Read-only NEAR contract queries for the audit (ported from the TrustFlow backend's nearRpcClient). Goes through the tracker's
// RPC helper, so it uses the same endpoints, retries and FastNEAR key as everything else.
import { rpc } from '../near/rpc.js';

// code_hash NEAR returns for an account with nothing deployed on it: base58 of 32 zero bytes.
export const EMPTY_CODE_HASH = '11111111111111111111111111111111';

const MISSING = /does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i;
async function query(params) {
  try { return await rpc('query', { finality: 'final', ...params }); }
  catch (e) { if (MISSING.test(e.message)) return null; throw e; } // an unknown account is an answer, not a transport error
}

export const viewAccount = (accountId) => query({ request_type: 'view_account', account_id: accountId });

export async function viewAccessKeyList(accountId) {
  return (await query({ request_type: 'view_access_key_list', account_id: accountId }))?.keys || [];
}

/** Deployed WASM bytes, or null when the account has no code of its own (e.g. a global-contract account). */
export async function viewCode(accountId) {
  const r = await query({ request_type: 'view_code', account_id: accountId });
  return r?.code_base64 ? Buffer.from(r.code_base64, 'base64') : null;
}

/** Read-only contract call; the parsed JSON result, or null on any contract error (method missing, panic): callers treat that as "unknown". */
export async function viewFunction(accountId, methodName, args = {}) {
  try {
    const r = await query({ request_type: 'call_function', account_id: accountId, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return r?.result ? JSON.parse(Buffer.from(r.result).toString()) : null;
  } catch { return null; }
}

/** Raw contract storage under a key prefix (near-sdk keeps the contract struct under "STATE"); [] when unavailable (state too large ...). */
export async function viewStatePrefix(accountId, prefix) {
  try {
    const r = await query({ request_type: 'view_state', account_id: accountId, prefix_base64: Buffer.from(prefix).toString('base64') });
    return (r?.values || []).map((v) => ({ key: Buffer.from(v.key, 'base64').toString('latin1'), value: Buffer.from(v.value, 'base64') }));
  } catch { return []; }
}
