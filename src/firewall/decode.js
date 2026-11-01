// Transaction firewall, step 1: read a transaction the way a wallet holds it just before signing, and turn every action into one plain
// model. Pure (no I/O), unit-tested. Accepted:
//   - wallet-selector JSON      { signerId, receiverId, actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit } }, ...] }
//   - near-api-js / RPC JSON    { signer_id, receiver_id, actions: [{ FunctionCall: { method_name, args, gas, deposit } }, 'CreateAccount', ...] }
//   - borsh, base64             a Transaction, a SignedTransaction, or a SignedDelegateAction (NEP-366 meta transaction, as sent to a relayer)
// A Delegate action (a meta transaction inside a transaction) is unpacked: its inner actions run as its sender, so they are checked as such.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const YOCTO = 10n ** 24n;
/** yoctoNEAR (string / bigint) -> NEAR as a number (6 decimals kept). */
export const toNear = (y) => { try { const v = BigInt(y ?? 0); return Number(v / 10n ** 18n) / 1e6; } catch { return null; } };

// ------------------------------------------------------------------ borsh reader
class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new Error('truncated'); }
  u8() { this.need(1); return this.b[this.o++]; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  u128() { const lo = this.u64(), hi = this.u64(); return (hi << 64n) | lo; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  vecBytes() { const n = this.u32(); if (n > 4e6) throw new Error('too long'); return this.bytes(n); }
  str() { const s = this.vecBytes().toString('utf8'); return s; }
  account() { const s = this.str(); if (!/^[a-z0-9._-]{2,64}$/.test(s)) throw new Error('not an account id'); return s; }
  vec(f) { const n = this.u32(); if (n > 1000) throw new Error('too many'); const out = []; for (let i = 0; i < n; i++) out.push(f()); return out; }
  option(f) { return this.u8() ? f() : null; }
  publicKey() { const t = this.u8(); if (t === 0) return 'ed25519:' + base58(this.bytes(32)); if (t === 1) return 'secp256k1:' + base58(this.bytes(64)); throw new Error('bad key type'); }
  signature() { const t = this.u8(); if (t === 0) this.bytes(64); else if (t === 1) this.bytes(65); else throw new Error('bad signature type'); }
  done() { return this.o === this.b.length; }
}

function borshAction(r) {
  const k = r.u8();
  switch (k) {
    case 0: return { kind: 'create_account' };
    case 1: { const code = r.vecBytes(); return { kind: 'deploy_contract', code_len: code.length }; }
    case 2: { const method = r.str(), args = r.vecBytes(), gas = r.u64(), deposit = r.u128(); return fnCall(method, args, gas, deposit); }
    case 3: return { kind: 'transfer', deposit: r.u128().toString() };
    case 4: { const stake = r.u128(); return { kind: 'stake', stake: stake.toString(), public_key: r.publicKey() }; }
    case 5: {
      const public_key = r.publicKey(); r.u64(); // nonce
      const p = r.u8();
      if (p === 1) return { kind: 'add_key', public_key, permission: 'full' };
      if (p !== 0) throw new Error('bad permission');
      const allowance = r.option(() => r.u128()), receiver = r.account(), methods = r.vec(() => r.str());
      return { kind: 'add_key', public_key, permission: { receiver, methods, allowance: allowance == null ? null : allowance.toString() } };
    }
    case 6: return { kind: 'delete_key', public_key: r.publicKey() };
    case 7: return { kind: 'delete_account', beneficiary: r.account() };
    case 8: { const d = borshDelegate(r); r.signature(); return d; }
    case 9: { const code = r.vecBytes(); r.u8(); return { kind: 'deploy_global_contract', code_len: code.length }; }
    case 10: { const t = r.u8(); return { kind: 'use_global_contract', contract: t === 0 ? 'hash:' + base58(r.bytes(32)) : t === 1 ? r.account() : (() => { throw new Error('bad global id'); })() }; }
    default: throw new Error(`unsupported action ${k}`);
  }
}
function borshDelegate(r) {
  const sender = r.account(), receiver = r.account(), actions = r.vec(() => borshAction(r)); r.u64(); r.u64(); r.publicKey();
  return { kind: 'delegate', sender, receiver, actions };
}
function borshTx(r) {
  const signer = r.account(); r.publicKey(); r.u64(); const receiver = r.account(); r.bytes(32);
  return { signer, receiver, actions: r.vec(() => borshAction(r)) };
}
/** A base64 borsh payload: Transaction, SignedTransaction or SignedDelegateAction (whichever layout reads every byte). */
export function decodeBorsh(b64) {
  const buf = Buffer.from(String(b64 || '').trim(), 'base64');
  if (buf.length < 40) throw new Error('payload too short');
  const tries = [
    ['transaction', (r) => borshTx(r)],
    ['signed_transaction', (r) => { const t = borshTx(r); r.signature(); return t; }],
    ['signed_delegate', (r) => { const d = borshDelegate(r); r.signature(); return { signer: d.sender, receiver: d.receiver, actions: d.actions, meta: true }; }],
  ];
  for (const [format, f] of tries) {
    try { const r = new Reader(buf); const t = f(r); if (r.done()) return { ...t, format }; } catch { /* not this layout */ }
  }
  throw new Error('not a NEAR Transaction, SignedTransaction or SignedDelegateAction');
}

// ------------------------------------------------------------------ JSON shapes
/** Function-call args: parsed JSON when they are JSON (most are), else their size. */
function parseArgs(args) {
  if (args == null) return { args: null, args_len: 0 };
  if (typeof args === 'object' && !(args instanceof Uint8Array) && !Array.isArray(args)) return { args, args_len: JSON.stringify(args).length };
  let buf = null;
  if (args instanceof Uint8Array) buf = Buffer.from(args);
  else if (Array.isArray(args)) buf = Buffer.from(args);
  else if (typeof args === 'string') {
    try { return { args: JSON.parse(args), args_len: args.length }; } catch {} // a JSON string
    buf = Buffer.from(args, 'base64');                                   // RPC format: base64
  }
  const s = buf ? buf.toString('utf8') : '';
  try { return { args: JSON.parse(s), args_len: buf.length }; } catch { return { args: null, args_len: buf?.length ?? 0, args_binary: true }; }
}
function fnCall(method, args, gas, deposit) {
  return { kind: 'function_call', method: String(method || ''), ...parseArgs(args), gas: String(gas ?? '0'), deposit: String(deposit ?? '0') };
}
const big = (x) => (x == null || x === '' ? '0' : String(x));

/** One action in wallet-selector ({ type, params }) or RPC ({ FunctionCall: {...} } / 'CreateAccount') shape. */
function jsonAction(a) {
  if (typeof a === 'string') { if (a === 'CreateAccount') return { kind: 'create_account' }; throw new Error(`unsupported action ${a}`); }
  if (a && a.type) { // wallet-selector
    const p = a.params || {};
    switch (a.type) {
      case 'CreateAccount': return { kind: 'create_account' };
      case 'DeployContract': return { kind: 'deploy_contract', code_len: p.code?.length ?? null };
      case 'FunctionCall': return fnCall(p.methodName, p.args, p.gas, p.deposit);
      case 'Transfer': return { kind: 'transfer', deposit: big(p.deposit) };
      case 'Stake': return { kind: 'stake', stake: big(p.stake), public_key: p.publicKey };
      case 'AddKey': {
        const perm = p.accessKey?.permission;
        if (perm === 'FullAccess' || perm?.FullAccess !== undefined) return { kind: 'add_key', public_key: p.publicKey, permission: 'full' };
        return { kind: 'add_key', public_key: p.publicKey, permission: { receiver: perm?.receiverId, methods: perm?.methodNames || [], allowance: perm?.allowance != null ? big(perm.allowance) : null } };
      }
      case 'DeleteKey': return { kind: 'delete_key', public_key: p.publicKey };
      case 'DeleteAccount': return { kind: 'delete_account', beneficiary: p.beneficiaryId };
      default: throw new Error(`unsupported action ${a.type}`);
    }
  }
  const [name, v] = Object.entries(a || {})[0] || [];
  switch (name) {
    case 'CreateAccount': return { kind: 'create_account' };
    case 'DeployContract': return { kind: 'deploy_contract', code_len: v?.code?.length ?? null };
    case 'FunctionCall': return fnCall(v.method_name ?? v.methodName, v.args, v.gas, v.deposit);
    case 'Transfer': return { kind: 'transfer', deposit: big(v?.deposit) };
    case 'Stake': return { kind: 'stake', stake: big(v?.stake), public_key: v?.public_key };
    case 'AddKey': {
      const perm = v?.access_key?.permission;
      if (perm === 'FullAccess' || perm?.FullAccess !== undefined) return { kind: 'add_key', public_key: v.public_key, permission: 'full' };
      const fc = perm?.FunctionCall || perm;
      return { kind: 'add_key', public_key: v.public_key, permission: { receiver: fc?.receiver_id, methods: fc?.method_names || [], allowance: fc?.allowance != null ? big(fc.allowance) : null } };
    }
    case 'DeleteKey': return { kind: 'delete_key', public_key: v?.public_key };
    case 'DeleteAccount': return { kind: 'delete_account', beneficiary: v?.beneficiary_id };
    case 'Delegate': {
      const d = v?.delegate_action || v;
      return { kind: 'delegate', sender: d.sender_id, receiver: d.receiver_id, actions: (d.actions || []).map((x) => jsonAction(x.NonDelegateAction ?? x)) };
    }
    default: throw new Error(`unsupported action ${name}`);
  }
}

/** One transaction from JSON (either shape). `signer` fills in a missing signer (wallet-selector lets the wallet decide it). */
export function decodeJson(tx, signer = null) {
  const s = tx.signerId ?? tx.signer_id ?? signer ?? null, r = tx.receiverId ?? tx.receiver_id;
  if (!r) throw new Error('receiverId is required');
  if (!Array.isArray(tx.actions) || !tx.actions.length) throw new Error('actions are required');
  if (tx.actions.length > 100) throw new Error('too many actions');
  return { signer: s, receiver: r, actions: tx.actions.map(jsonAction), format: tx.type || tx.actions[0]?.type ? 'wallet_selector' : 'rpc_json' };
}

/**
 * The request body -> transactions. A delegate action is flattened: its inner actions become their own transaction from the delegate's
 * sender to its receiver (that is what runs on chain), marked `meta`.
 */
export function decodeRequest(body) {
  const signer = body.signer_id ?? body.signerId ?? null;
  let txs;
  if (body.transaction_base64 || body.signed_transaction_base64 || body.delegate_base64 || body.base64) txs = [decodeBorsh(body.transaction_base64 || body.signed_transaction_base64 || body.delegate_base64 || body.base64)];
  else if (Array.isArray(body.transactions)) txs = body.transactions.map((t) => decodeJson(t, signer));
  else if (body.transaction) txs = [decodeJson(body.transaction, signer)];
  else if (body.receiverId || body.receiver_id) txs = [decodeJson(body, signer)];
  else throw new Error('send transaction, transactions, or transaction_base64 / signed_transaction_base64 / delegate_base64');
  if (txs.length > 20) throw new Error('at most 20 transactions per check');
  const out = [];
  for (const t of txs) {
    const own = t.actions.filter((a) => a.kind !== 'delegate');
    if (own.length || !t.actions.length) out.push({ ...t, actions: own });
    for (const d of t.actions.filter((a) => a.kind === 'delegate')) out.push({ signer: d.sender, receiver: d.receiver, actions: d.actions, meta: true, relayer: t.signer, format: t.format });
  }
  return out.map((t) => ({ ...t, actions: t.actions.map((a, i) => ({ index: i, ...a, ...(a.deposit != null ? { deposit_near: toNear(a.deposit) } : {}) })) }));
}
export { YOCTO };
