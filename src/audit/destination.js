// Where can a contract's withdrawals go? A method named sweep / rescue / exit_to_owner "moves users' funds" by NAME; whether that is dangerous
// depends on whether the caller can choose the destination. Two kinds of evidence, with very different weight:
//
//   1. From the code (guardsFromWat): an export reaches a function that hashes something (sha256 / keccak256) and loads an "owner mismatch"
//      panic message. That is a HINT only. The code is written by whoever deployed it: a drainer can add a decoy check whose result it ignores,
//      and an owner-only sweep that pays any address can have an unrelated hash in its guard. So a hint is reported, and never lowers a rating.
//   2. From the chain (corroborateOwnerChecks): the method's real payouts. A payout counts as bound when its receiver was passed in the call
//      and sha256 of it (alone, or joined with another argument of the call, e.g. a salt) equals 32 bytes the contract was initialised with,
//      and the receiver is not the deployer, a controller or the caller. That cannot be faked by a decoy: it holds only if the money really
//      went to the address committed at creation. Only this may lower a rating, by one step at most (findings.js).
// Pure (unit-tested).
import crypto from 'node:crypto';

// "the receiver is not the owner" style messages: the destination is compared with something stored
export const OWNER_DENIAL = /(?:not|wrong|invalid|unknown)\s+(?:the\s+)?owner|(?:receiver|recipient|destination|beneficiary|payout)\s+(?:is\s+)?not\s+(?:the\s+)?(?:owner|allowed|whitelisted)|owner\s+(?:hash\s+)?(?:mismatch|does not match)/gi;
// "only X may call this" style messages: the caller is compared with something stored
export const CALLER_DENIAL = /only\s+(?:the\s+)?(?:controller|owner|admin|operator|guardian|manager|relayer|dao|council|executor|keeper)|not\s+(?:authori[sz]ed|permitted)|unauthori[sz]ed|permission denied|caller\s+(?:is\s+)?not|must be called by/gi;
const HASH_CALLS = new Set(['$env.sha256', '$env.keccak256']);

/** Decode the data segments of a WAT module: [{ off, text }] (latin1, so every byte is one char). */
export function dataStrings(wat) {
  const out = [];
  for (const m of wat.matchAll(/\(data (?:\$\S+ )?\(i32\.const (\d+)\) "((?:[^"\\]|\\.)*)"\)/g)) {
    const raw = m[2], bytes = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== '\\') { bytes.push(raw.charCodeAt(i)); continue; }
      const h = raw.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(h)) { bytes.push(parseInt(h, 16)); i += 2; }
      else { bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, "'": 39 }[raw[i + 1]] ?? 63); i += 1; }
    }
    out.push({ off: Number(m[1]), text: String.fromCharCode(...bytes) });
  }
  return out;
}

/** Functions with the calls they make and the constants they load: Map(name -> { export, calls, consts }). */
function parseFns(wat) {
  const fns = new Map();
  let cur = null;
  for (const line of wat.split('\n')) {
    if (line.startsWith('  (func ')) {
      const name = (line.match(/^\s+\(func (\$[^\s()]+)/) || [])[1];
      cur = { export: (line.match(/\(export "([^"]+)"\)/) || [])[1] || null, calls: new Set(), consts: new Set() };
      if (name) fns.set(name, cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('  (')) { cur = null; continue; } // left the function bodies
    const c = line.match(/^\s+call (\$[^\s()]+)/);
    if (c) { cur.calls.add(c[1]); continue; }
    const k = line.match(/^\s+i32\.const (-?\d+)/);
    if (k) cur.consts.add(Number(k[1]));
  }
  return fns;
}

/** Addresses where a message matching `re` starts, across the data segments. */
function messageStarts(segs, re) {
  const at = new Set();
  for (const s of segs) for (const m of s.text.matchAll(new RegExp(re.source, 'gi'))) at.add(s.off + m.index);
  return at;
}

/**
 * HINTS from the code (see the top): which exports reach an owner-hash check / a caller check. `wanted` limits the exports looked at.
 * -> { owner_check: [method], caller_check: [method] }
 */
export function guardsFromWat(wat, wanted = null) {
  const fns = parseFns(wat), segs = dataStrings(wat);
  const withMessage = (starts) => new Set([...fns].filter(([, f]) => [...f.consts].some((c) => starts.has(c))).map(([n]) => n));
  const hashes = (f) => [...f.calls].some((c) => HASH_CALLS.has(c)) || [...f.calls].some((c) => { const g = fns.get(c); return g && g.calls.size <= 2 && [...g.calls].every((x) => HASH_CALLS.has(x)); });
  const ownerGuards = new Set([...withMessage(messageStarts(segs, OWNER_DENIAL))].filter((n) => hashes(fns.get(n))));
  const callerGuards = withMessage(messageStarts(segs, CALLER_DENIAL));
  const owner_check = [], caller_check = [];
  for (const [name, f] of fns) {
    if (!f.export || (wanted && !wanted.includes(f.export))) continue;
    const seen = new Set([name]), stack = [name];
    let ob = false, cc = false;
    while (stack.length && seen.size < 6000 && !(ob && cc)) {
      const cur = stack.pop();
      if (ownerGuards.has(cur)) ob = true;
      if (callerGuards.has(cur)) cc = true;
      for (const c of fns.get(cur)?.calls || []) if (!c.startsWith('$env.') && !seen.has(c)) { seen.add(c); stack.push(c); }
    }
    if (ob) owner_check.push(f.export);
    if (cc) caller_check.push(f.export);
  }
  return { owner_check: owner_check.sort(), caller_check: caller_check.sort() };
}

/** The "moves users' funds" methods that carry an owner-check hint. Never changes a power: the hint is only shown. */
export const ownerCheckHints = (powers, hints) => {
  const h = new Set(hints?.owner_check || []);
  return [...new Set((powers || []).filter((p) => p.power === 'move_user_funds').flatMap((p) => p.methods.filter((m) => h.has(m))))].sort();
};

// ---------------------------------------------------------------- on-chain corroboration
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ACCOUNT = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

/** Every 32-byte value an init call's arguments could hold: each 32-byte window of the raw bytes, and hex / base64 / byte-array strings in JSON. */
export function commitmentsOf(argBufs) {
  const out = new Set();
  for (const b of argBufs) {
    for (let i = 0; i + 32 <= b.length; i++) out.add(b.subarray(i, i + 32).toString('hex'));
    let j = null; try { j = JSON.parse(b.toString('utf8')); } catch {}
    const walk = (v) => {
      if (typeof v === 'string') {
        if (/^[0-9a-fA-F]{64}$/.test(v)) out.add(v.toLowerCase());
        else if (/^[A-Za-z0-9+/]{43}=$/.test(v)) out.add(Buffer.from(v, 'base64').toString('hex'));
      } else if (Array.isArray(v)) {
        if (v.length === 32 && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) out.add(Buffer.from(v).toString('hex'));
        else v.forEach(walk);
      } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(j);
  }
  return out;
}

/** The strings a call passed: JSON string values, and borsh strings (u32 little-endian length + printable bytes). */
export function argStrings(b) {
  const out = new Set();
  let j = null; try { j = JSON.parse(b.toString('utf8')); } catch {}
  const walk = (v) => { if (typeof v === 'string') out.add(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  if (j !== null) walk(j);
  for (let i = 0; i + 4 <= b.length; i++) {
    const n = b.readUInt32LE(i);
    if (n < 2 || n > 128 || i + 4 + n > b.length) continue;
    const s = b.subarray(i + 4, i + 4 + n);
    if (s.every((c) => c >= 0x20 && c < 0x7f)) out.add(s.toString('latin1'));
  }
  return out;
}

/** Where a transaction moved the account's money: native NEAR transfers out of it and token transfers from it. [receiver] */
export function payoutsOf(t, account) {
  const to = new Set();
  for (const r of t.receipts || []) {
    const rc = r.receipt;
    if (rc?.predecessor_id === account && rc.receiver_id !== account) for (const a of rc.receipt?.Action?.actions || []) if (a.Transfer && BigInt(a.Transfer.deposit || '0') > 0n) to.add(rc.receiver_id);
    for (const l of r.execution_outcome?.outcome?.logs || []) {
      if (l.startsWith('EVENT_JSON:')) {
        try { const e = JSON.parse(l.slice(11)); if (/^(ft|mt|nft)_transfer$/.test(e.event)) for (const d of e.data || []) if (d.old_owner_id === account && d.new_owner_id && d.new_owner_id !== account) to.add(d.new_owner_id); } catch {}
      } else { const m = l.match(/^Transfer \d+ from (\S+) to (\S+)$/); if (m && m[1] === account && m[2] !== account) to.add(m[2]); }
    }
  }
  return [...to];
}

/**
 * Does the chain confirm that a method pays only the address committed at creation?
 *   init    = [Buffer] the arguments of the account's init call(s)
 *   calls   = [{ method, args: Buffer, payouts: [receiver] }] successful calls of the methods to check
 *   exclude = accounts a payout must NOT go to for it to protect users (deployer, controllers, the callers)
 * A method is corroborated when it has at least one paying call and EVERY payout of EVERY call is a receiver the call passed whose sha256
 * (alone, or with another passed string before or after it) is one of the init commitments, and none is in `exclude`.
 * -> { corroborated: [method], seen: { method: { calls, paying, matched } } }
 */
export function corroborateOwnerChecks({ init = [], calls = [], exclude = [] } = {}) {
  const commits = commitmentsOf(init), ex = new Set(exclude), seen = {};
  for (const c of calls) {
    const s = (seen[c.method] ||= { calls: 0, paying: 0, matched: 0, bad: false });
    s.calls++;
    if (!c.payouts?.length) continue;
    s.paying++;
    const strs = argStrings(c.args || Buffer.alloc(0));
    const ok = c.payouts.every((r) => {
      if (ex.has(r) || !ACCOUNT.test(r) || !strs.has(r)) return false;
      if (commits.has(sha(r))) return true;
      for (const x of strs) if (x !== r && (commits.has(sha(x + r)) || commits.has(sha(r + x)))) return true;
      return false;
    });
    if (ok) s.matched++; else s.bad = true;
  }
  const corroborated = Object.entries(seen).filter(([, s]) => s.paying > 0 && !s.bad).map(([m]) => m).sort();
  return { corroborated, seen: Object.fromEntries(Object.entries(seen).map(([m, s]) => [m, { calls: s.calls, paying: s.paying, matched: s.matched }])) };
}
