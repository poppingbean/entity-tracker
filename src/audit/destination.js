// Where do a contract's withdrawals go? A method named sweep / rescue / exit_to_owner / withdraw_lost "moves users' funds" by NAME, but
// that is only dangerous when whoever calls it can choose the destination. Some contracts commit to the destination up front (they store
// a hash of the owner's payout address and check the receiver against it before paying), so the same method name can only pay the owner.
// This reads that out of the code instead of guessing from the name. Pure (unit-tested), on the WAT text of the deployed WASM.
//
//   owner_bound    exports that reach a function which (1) hashes something (sha256 / keccak256) and (2) holds an "owner mismatch" panic
//                  message, i.e. the receiver is compared with a stored commitment before money moves
//   caller_checked exports that reach a function holding an "only the controller / not authorised" panic message
//
// What this proves and what it does not: the code checks a committed owner before paying, on the path of that method. It does not say who
// the owner is (check the chain for that), and a method with neither tag is simply "not shown to be bound", never "shown to be open".
// Strings are matched at the exact address a function loads (a Rust panic loads the &str start), so a message inside another string, or a
// function that merely contains the word "owner", does not count.

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
 * Which exports are bound to a committed owner / check the caller. `wanted` limits the exports looked at (default: all).
 * -> { owner_bound: [method], caller_checked: [method] }
 */
export function guardsFromWat(wat, wanted = null) {
  const fns = parseFns(wat), segs = dataStrings(wat);
  const withMessage = (starts) => new Set([...fns].filter(([, f]) => [...f.consts].some((c) => starts.has(c))).map(([n]) => n));
  const hashes = (f) => [...f.calls].some((c) => HASH_CALLS.has(c)) || [...f.calls].some((c) => { const g = fns.get(c); return g && g.calls.size <= 2 && [...g.calls].every((x) => HASH_CALLS.has(x)); });
  const ownerGuards = new Set([...withMessage(messageStarts(segs, OWNER_DENIAL))].filter((n) => hashes(fns.get(n))));
  const callerGuards = withMessage(messageStarts(segs, CALLER_DENIAL));
  const owner_bound = [], caller_checked = [];
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
    if (ob) owner_bound.push(f.export);
    if (cc) caller_checked.push(f.export);
  }
  return { owner_bound: owner_bound.sort(), caller_checked: caller_checked.sort() };
}

/**
 * Take the owner-bound methods out of the "moves users' funds" power: a method that can only pay the committed owner is not that power.
 * Methods that are NOT bound stay (and keep the power's severity). -> { powers, bound: [method] }
 */
export function applyOwnerBound(powers, ownerBound = []) {
  const ob = new Set(ownerBound), bound = [];
  const out = [];
  for (const p of powers || []) {
    if (p.power !== 'move_user_funds' || !p.methods.some((m) => ob.has(m))) { out.push(p); continue; }
    bound.push(...p.methods.filter((m) => ob.has(m)));
    const keep = p.methods.filter((m) => !ob.has(m));
    if (keep.length) out.push({ ...p, methods: keep, ai_methods: p.ai_methods?.filter((m) => !ob.has(m)), bound_methods: p.methods.filter((m) => ob.has(m)) });
  }
  return { powers: out, bound: [...new Set(bound)].sort() };
}
