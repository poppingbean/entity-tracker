// What each exported method can actually DO, read from the code rather than its name: walk the call graph from the export and collect
// the NEAR host functions it can reach (add a full-access key, deploy code, send NEAR, delete the account, call other contracts) and
// whether it ever reads who the caller is. Names lie; host calls don't. Calls through function tables (call_indirect) can't be followed
// statically: such methods are marked `dynamic`, and an absent capability is then never taken as proof.
import wabtInit from 'wabt';

let wabtP = null;
const wabt = () => (wabtP ||= wabtInit());

// NEAR host functions that matter, and what reaching them means
export const HOST_CAPS = {
  promise_batch_action_add_key_with_full_access: 'add_full_access_key',
  promise_batch_action_add_key_with_function_call: 'add_function_call_key',
  promise_batch_action_delete_key: 'delete_key',
  promise_batch_action_deploy_contract: 'deploy_code',
  promise_batch_action_deploy_global_contract: 'deploy_code',
  promise_batch_action_deploy_global_contract_by_account_id: 'deploy_code',
  promise_batch_action_use_global_contract: 'deploy_code',
  promise_batch_action_use_global_contract_by_account_id: 'deploy_code',
  promise_batch_action_delete_account: 'delete_account',
  promise_batch_action_transfer: 'send_near',
  promise_batch_action_stake: 'stake',
  promise_batch_action_function_call: 'call_contracts',
  promise_batch_action_function_call_weight: 'call_contracts',
  promise_create: 'call_contracts',
  predecessor_account_id: 'reads_caller',
  signer_account_id: 'reads_caller',
};
export const DANGEROUS = new Set(['add_full_access_key', 'add_function_call_key', 'delete_key', 'deploy_code', 'delete_account', 'send_near']);

/** Parse WAT into functions: name -> { export, calls: Set, indirect }. Exported for tests. */
export function parseWat(text) {
  const fns = new Map();
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('  (func ')) {
      const name = (line.match(/^\s+\(func (\$[^\s()]+)/) || [])[1];
      cur = { export: (line.match(/\(export "([^"]+)"\)/) || [])[1] || null, calls: new Set(), indirect: false };
      if (name) fns.set(name, cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('  (') && !line.startsWith('  (func ')) { cur = null; continue; } // left the function bodies (tables, data, exports)
    const c = line.match(/^\s+call (\$[^\s()]+)/);
    if (c) cur.calls.add(c[1]);
    else if (/^\s+call_indirect/.test(line)) cur.indirect = true;
  }
  return fns;
}

/** For each wanted export: { caps: [...], dynamic } (caps include 'reads_caller' when the method can read who called it). */
export function capabilitiesFromWat(text, wanted = null) {
  const fns = parseWat(text);
  // near-sdk runs every promise through one generic function that calls ALL action host functions (a match over the Action enum).
  // Walking into it would make every promise-creating method look able to add keys and deploy code: it is recorded as
  // `generic_promise` and not entered, so what remains are the actions a method calls on its own path.
  // (older SDKs wrap each host call in a tiny helper, so look one level down too)
  const direct = (f) => [...f.calls].filter((c) => c.startsWith('$env.') && DANGEROUS.has(HOST_CAPS[c.slice(5)])).map((c) => HOST_CAPS[c.slice(5)]);
  const wrapper = (g) => g && g.calls.size <= 2 && [...g.calls].every((c) => c.startsWith('$env.')); // a tiny helper around a host call
  const reach2 = (f) => new Set([...direct(f), ...[...f.calls].flatMap((c) => (wrapper(fns.get(c)) ? direct(fns.get(c)) : []))]);
  const dispatchers = new Set([...fns].filter(([, f]) => reach2(f).size >= 3).map(([n]) => n));
  const byExport = new Map([...fns].filter(([, f]) => f.export).map(([n, f]) => [f.export, n]));
  const out = {};
  for (const [exp, start] of byExport) {
    if (wanted && !wanted.includes(exp)) continue;
    const seen = new Set([start]), stack = dispatchers.has(start) ? [] : [start], caps = new Set();
    let dynamic = false;
    while (stack.length && seen.size < 6000) {
      const f = fns.get(stack.pop());
      if (!f) continue;
      if (f.indirect) dynamic = true;
      for (const c of f.calls) {
        if (c.startsWith('$env.')) { const cap = HOST_CAPS[c.slice(5)]; if (cap) caps.add(cap); continue; }
        if (dispatchers.has(c)) { caps.add('generic_promise'); continue; }
        if (!seen.has(c)) { seen.add(c); stack.push(c); }
      }
    }
    out[exp] = { caps: [...caps].sort(), dynamic };
  }
  return out;
}

/** Capabilities of a contract's write methods from its WASM bytes. null when the code can't be decompiled. */
export async function codeCapabilities(code, methods) {
  try {
    const w = await wabt();
    const m = w.readWasm(new Uint8Array(code), { readDebugNames: true });
    m.generateNames(); m.applyNames();
    const text = m.toText({ foldExprs: false, inlineExport: true });
    m.destroy();
    return capabilitiesFromWat(text, methods);
  } catch { return null; }
}
