// Signing and sending a NEAR transaction with a FUNCTION-CALL key, with no extra library: Node's own ed25519 and a minimal Borsh writer.
// Used only by the Academy's business agent (src/academy/business.js), whose key can call nothing but a DAO's proposal methods. A function-
// call key cannot attach a deposit, send NEAR or add keys: this module only builds FunctionCall actions with no deposit.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { rpc } from './rpc.js';
import { base58 } from '../firewall/decode.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(s) {
  let n = 0n;
  for (const c of String(s)) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of String(s)) { if (c === '1') out.unshift(0); else break; }
  return Uint8Array.from(out);
}

/** A key pair from "ed25519:<base58 secret>" (64 bytes: seed + public key, as near-cli stores it; or the 32-byte seed). */
export function keyPair(secret) {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(secret || '').trim());
  if (!m) throw new Error('the agent key must be "ed25519:<base58>"');
  const raw = base58Decode(m[1]);
  if (raw.length !== 64 && raw.length !== 32) throw new Error('the agent key has the wrong length');
  const seed = raw.slice(0, 32);
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const pub = Buffer.from(createPublicKey(priv).export({ format: 'der', type: 'spki' })).subarray(-32);
  if (raw.length === 64 && !Buffer.from(raw.slice(32)).equals(pub)) throw new Error('the agent key\'s public half does not match its secret');
  return { publicKey: `ed25519:${base58(pub)}`, pub, sign: (msg) => edSign(null, msg, priv) };
}

// ------------------------------------------------------------------ Borsh, only what a transaction of function calls needs
class W {
  constructor() { this.parts = []; }
  u8(n) { this.parts.push(Buffer.from([n])); return this; }
  u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.parts.push(b); return this; }
  u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); this.parts.push(b); return this; }
  u128(n) { const v = BigInt(n), b = Buffer.alloc(16); b.writeBigUInt64LE(v & 0xffffffffffffffffn); b.writeBigUInt64LE(v >> 64n, 8); this.parts.push(b); return this; }
  bytes(b) { this.parts.push(Buffer.from(b)); return this; }
  vec(b) { this.u32(b.length); return this.bytes(b); }
  str(s) { return this.vec(Buffer.from(String(s), 'utf8')); }
  done() { return Buffer.concat(this.parts); }
}
/**
 * The Borsh bytes of a Transaction whose actions are function calls with no deposit. `calls`: [{ method, args (object), gas (string) }]. Pure.
 */
export function encodeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, calls }) {
  const w = new W().str(signerId).u8(0).bytes(publicKey).u64(nonce).str(receiverId).bytes(blockHash).u32(calls.length);
  for (const c of calls) w.u8(2).str(c.method).vec(Buffer.from(JSON.stringify(c.args ?? {}))).u64(c.gas || '100000000000000').u128(0);
  return w.done();
}
/** A SignedTransaction: the transaction bytes, then the ed25519 signature of their sha256. Pure (given the key). */
export function signTransaction(txBytes, kp) {
  const hash = createHash('sha256').update(txBytes).digest();
  const sig = kp.sign(hash);
  return { signed: Buffer.concat([txBytes, Buffer.from([0]), sig]), hash: base58(hash) };
}

/**
 * Sign and send function calls from `signerId` to `receiverId` with the function-call key `secret`; waits until final. Returns the
 * transaction hash and, when the last call returned a value, that value (JSON). Throws on a failure, with the chain's reason.
 */
export async function callAsAgent({ signerId, secret, receiverId, calls }) {
  const kp = keyPair(secret);
  const ak = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: signerId, public_key: kp.publicKey });
  const perm = ak.permission;
  if (perm === 'FullAccess') throw new Error(`${signerId}'s key ${kp.publicKey} is a FULL-ACCESS key: the agent must hold a function-call key only`);
  if (perm?.FunctionCall?.receiver_id !== receiverId) throw new Error(`the agent's key may call ${perm?.FunctionCall?.receiver_id}, not ${receiverId}`);
  const tx = encodeTransaction({ signerId, publicKey: kp.pub, nonce: BigInt(ak.nonce) + 1n, receiverId, blockHash: base58Decode(ak.block_hash), calls });
  const { signed, hash } = signTransaction(tx, kp);
  const r = await rpc('send_tx', { signed_tx_base64: signed.toString('base64'), wait_until: 'FINAL' });
  const st = r?.status || r?.transaction_outcome?.outcome?.status;
  if (st?.Failure) throw new Error(`${hash} failed: ${JSON.stringify(st.Failure).slice(0, 300)}`);
  // a receipt that failed later (the DAO's transfer, a callback) shows in receipts_outcome
  const failed = (r?.receipts_outcome || []).find((x) => x.outcome?.status?.Failure);
  if (failed) throw new Error(`${hash}: a receipt failed: ${JSON.stringify(failed.outcome.status.Failure).slice(0, 300)}`);
  let value = null;
  if (st?.SuccessValue) { try { value = JSON.parse(Buffer.from(st.SuccessValue, 'base64').toString()); } catch {} }
  return { hash, value };
}
