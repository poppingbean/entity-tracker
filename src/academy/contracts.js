// Academy track "contracts": read a NEAR contract the way an auditor (or an attacker) does. The answers come from facts in the deployed code
// and on chain, not from an AI: the automated audit decompiles each method (wabt) and walks its call graph to the NEAR host functions it
// reaches (send NEAR, deploy code, add / delete keys, delete the account, read the caller, call another contract). Each task names a real
// account: reading its code is the skill (RPC `view_code`, or any decompiler). Levels:
//   1  the contract's type and the NEAR standards it implements (types the rules set from the code, never an AI's guess); whether its code
//      is a launchpad's template, a copy other accounts run too, or its own
//   2  which methods can do something powerful (send NEAR, deploy code, add or delete keys, delete the account, stake); which call other
//      contracts; who controls the contract (its keys and the owner in its state)
//   3  which of the powerful methods never check who is calling (an open door: anyone can call them)
//   4  which methods give someone power over users (move their funds, freeze, mint, upgrade, take fees, control accounts): the audit's rules
//   5  upgrades: the account replaced its code; which methods were added or removed, and which powers it gained
import { col } from '../db.js';
import { taskId, splitOf, balance } from './tasks.js';

export const POWER_CAPS = { send_near: 'sends NEAR', deploy_code: 'deploys code', add_full_access_key: 'adds a full-access key', add_function_call_key: 'adds a function-call key', delete_key: 'deletes a key', delete_account: 'deletes the account', stake: 'stakes' };
const USER_POWERS = new Set(['move_user_funds', 'freeze', 'mint', 'upgrade', 'set_fees', 'account_control']);
const TYPES = ['token', 'nft', 'multi_token', 'amm', 'farm', 'factory', 'bridge', 'nft_marketplace', 'router', 'orderbook', 'account', 'lending', 'staking', 'dao', 'multisig', 'oracle', 'launchpad', 'lockup', 'liquid_staking', 'treasury'];
export const CONTROL = {
  locked: 'nobody: no full-access key and no owner in its state',
  locked_contract: 'only other contracts that are themselves locked (a launchpad or a pool: the platform\'s code decides)',
  dao: 'a DAO (Sputnik or similar)',
  wallet: 'one ordinary account named as owner or admin in its state',
  contract: 'another contract that can still be changed',
  full_access_key: 'whoever holds a full-access key on the account',
};
const HOW = 'RPC query { request_type: "view_code", account_id } returns the WASM (base64); decompile it (e.g. wasm2wat) and follow each exported method';
const r = (xs) => [...new Set(xs)].sort();

/** Methods with a powerful capability, from the code audit's per-method capabilities. Pure. */
export function powerfulMethods(code) {
  return Object.entries(code.capabilities || {}).filter(([, v]) => (v.caps || []).some((c) => POWER_CAPS[c])).map(([m]) => m).sort();
}
/** Of the powerful methods, the ones whose code never reads who is calling (no caller check anywhere in its call graph). Pure. */
export function openMethods(code) {
  return powerfulMethods(code).filter((m) => !(code.capabilities[m].caps || []).includes('reads_caller')).sort();
}
/** Methods that give someone power over users (the audit's power rules, medium severity or worse). Pure. */
export function userPowerMethods(code) {
  return r((code.powers || []).filter((p) => USER_POWERS.has(p.power) && ['critical', 'high', 'medium'].includes(p.severity)).flatMap((p) => p.methods || []));
}
/** Exported methods that call another contract (a cross-contract promise). Pure. */
export function callingMethods(code) {
  const ex = new Set(code.exports || []);
  return Object.entries(code.capabilities || {}).filter(([m, v]) => ex.has(m) && (v.caps || []).includes('call_contracts')).map(([m]) => m).sort();
}
/** Who controls a contract, from the audit's control summary ("owner: dao", "locked (no keys …)", "1 full-access key" …). Pure. */
export function controlClass(control) {
  const s = String(control?.summary || '');
  if (/full-access key/.test(s)) return 'full_access_key';
  if (/^locked/.test(s)) return 'locked';
  const m = /^owner: (\w+)/.exec(s);
  if (!m) return null;
  return { dao: 'dao', wallet: 'wallet', contract: 'contract', locked: 'locked_contract' }[m[1]] || null;
}
/** Whether a code is a launchpad's template (`launchpad`: the launchpad whose tokens run it, if any), a copy run by other accounts, or its own (null: too close to call). Pure. */
export function originClass(launchpad, familyN) {
  if (launchpad) return launchpad;
  return familyN >= 3 ? 'copy' : familyN === 1 ? 'own' : null;
}

/** The tasks of one contract code, run by `account` (with its audit: control, family size; and the launchpad templates). Pure. */
export function contractTasks(code, account, { audit = null, launchpad = null, launchpads = [] } = {}) {
  const out = [], exports = (code.exports || []).slice().sort();
  // one split per contract, not per task: a level-3 task lists the level-2 answer, so a contract's tasks are all training or all test
  const split = splitOf(`contracts:code:${code._id}`);
  const base = (level, kind, extra) => ({ _id: taskId('contracts', kind, `${code._id}`), track: 'contracts', level, kind, split, refs: { account, code: code._id }, ...extra });
  const input = { account, exported_methods: exports, how_to_read_the_code: HOW };
  if (code.role && code.role !== 'unknown' && code.role_source === 'rules') {
    out.push(base(1, 'type', {
      question: 'What kind of contract is this, and which NEAR standards (NEP numbers) does it implement?',
      input, answer_format: { type: 'class+set', example: { class: 'token', set: ['nep141', 'nep145'] } }, options: { types: TYPES },
      gold: { class: code.role, set: (code.standards || []).map(String) }, rationale: `Its exported methods make it ${/^[aeiou]/.test(code.role) ? 'an' : 'a'} ${code.role}${code.label && code.label !== code.role ? ` (${code.label})` : ''}; standards: ${(code.standards || []).join(', ') || 'none'}.`, label_source: 'code: exported methods and their signatures (rules)',
    }));
  }
  const origin = originClass(launchpad, audit?.auto?.family_n);
  if (origin) {
    const lps = [...new Set([...launchpads, ...(launchpad ? [launchpad] : [])])].sort();
    out.push(base(1, 'origin', {
      question: `Is this contract's code the template a launchpad deploys for its tokens (say which: ${lps.join(', ')}), a copy that other accounts run too, or its own code? RPC view_account returns the code hash: compare it with other accounts.`,
      input: { account, how_to_read_the_code: 'RPC query { request_type: "view_account", account_id } returns code_hash' }, answer_format: { type: 'class', example: { class: 'copy' } },
      options: { ...Object.fromEntries(lps.map((l) => [l, `the token template of the ${l} launchpad`])), copy: 'the same code runs on at least 3 accounts, and it is not a launchpad template', own: 'no other account runs this code' },
      gold: { class: origin }, rationale: origin === 'copy' ? `${audit?.auto?.family_n} accounts run exactly this code, and it is not a launchpad's template.` : origin === 'own' ? 'No other audited account runs this code.' : `The code hash is the template the ${origin} launchpad deploys for its tokens.`,
      label_source: 'code hash: the accounts that run the same code, and the launchpads whose tokens run it',
    }));
  }
  const strong = powerfulMethods(code);
  if (exports.length >= 3) {
    out.push(base(2, 'powers', {
      question: `Which exported methods can, directly or through the functions they call, do any of: ${Object.values(POWER_CAPS).join(', ')}? List the method names (an empty list if none).`,
      input, answer_format: { type: 'set', example: { set: ['withdraw', 'upgrade'] } },
      gold: { set: strong }, rationale: strong.length ? `From the code: ${strong.map((m) => `${m} ${(code.capabilities[m].caps || []).filter((c) => POWER_CAPS[c]).map((c) => POWER_CAPS[c]).join(' / ')}`).join('; ')}.` : 'No exported method reaches a host function that sends NEAR, deploys code, changes keys, deletes the account or stakes.',
      label_source: 'code: each method\'s call graph to NEAR host functions (wasm)',
    }));
    const calls = callingMethods(code);
    out.push(base(2, 'calls', {
      question: 'Which exported methods call another contract (create a cross-contract call, directly or through the functions they call)? List the method names (an empty list if none).',
      input, answer_format: { type: 'set', example: { set: ['ft_transfer_call', 'swap'] } },
      gold: { set: calls }, rationale: calls.length ? `${calls.join(', ')} ${calls.length > 1 ? 'create' : 'creates'} a call to another contract. Where the callback lands, and what state changed before it, is where re-entrancy and lost-funds bugs live.` : 'No exported method calls another contract.',
      label_source: 'code: each method\'s call graph to the promise host functions (wasm)',
    }));
  }
  const ctl = controlClass(audit?.auto?.control);
  if (ctl) {
    const c = audit.auto.control;
    out.push(base(2, 'control', {
      question: 'Who can change or take over this contract? Check its access keys (RPC view_access_key_list) and any owner or admin stored in its state (view_state, or its view methods).',
      input: { account, exported_methods: exports }, answer_format: { type: 'class', example: { class: 'dao' } }, options: CONTROL,
      gold: { class: ctl }, rationale: `${c.summary}: ${c.full_keys} full-access key${c.full_keys === 1 ? '' : 's'}, ${c.keys_total} key${c.keys_total === 1 ? '' : 's'} in all${(c.controllers || []).length ? `; named in its state: ${c.controllers.map((x) => `${x.account} (${x.kind}, ${x.via})`).join(', ')}` : ''}.`,
      label_source: 'chain: access keys and the owner fields in the contract state',
    }));
  }
  if (strong.length) {
    const open = openMethods(code);
    out.push(base(3, 'open_doors', {
      question: `These methods can do something powerful: ${strong.join(', ')}. Which of them never check who is calling (anyone could call them)? List the method names (an empty list if all check).`,
      input: { ...input, powerful_methods: strong }, answer_format: { type: 'set', example: { set: ['sweep'] } },
      gold: { set: open }, rationale: open.length ? `${open.join(', ')} ${open.length > 1 ? 'reach' : 'reaches'} a powerful action with no read of the caller (predecessor / signer) anywhere in the call graph: anyone can call ${open.length > 1 ? 'them' : 'it'}. Whether that loses money depends on where the value goes (a fixed owner, or an address the caller chooses).` : 'Every one of them reads who is calling before acting.',
      label_source: 'code: whether the call graph reads the caller (wasm)',
    }));
  }
  const up = userPowerMethods(code);
  if (exports.length >= 3 && (up.length || code.role === 'token')) {
    out.push(base(4, 'user_powers', {
      question: 'Which methods give someone power over the users of this contract: moving their funds, freezing or blacklisting, minting, upgrading the code, setting fees, or controlling accounts? List the method names (an empty list if none).',
      input, answer_format: { type: 'set', example: { set: ['set_blacklisted', 'mint', 'upgrade'] } },
      gold: { set: up }, rationale: up.length ? `${(code.powers || []).filter((p) => USER_POWERS.has(p.power) && ['critical', 'high', 'medium'].includes(p.severity)).map((p) => `${p.label} (${p.severity}): ${(p.methods || []).join(', ')}`).join('; ')}.` : 'No method gives anyone power over users\' funds or the token.',
      label_source: 'audit rules: powers read from the code (names, guards and effects)',
    }));
  }
  return out;
}

/** An upgrade task: an account that replaced its code (both codes audited). `height`: the block of the new deploy, when known. Pure. */
export function upgradeTask(account, change, from, to, { height = null, powerNames = [] } = {}) {
  const fx = new Set(from.exports || []), tx = new Set(to.exports || []);
  const gold = { added_methods: r([...tx].filter((m) => !fx.has(m))), removed_methods: r([...fx].filter((m) => !tx.has(m))), added_powers: r(change.added_powers || []) };
  const same = !gold.added_methods.length && !gold.removed_methods.length && !gold.added_powers.length;
  return {
    _id: taskId('contracts', 'upgrade', `${account}|${change.from}|${change.to}`), track: 'contracts', level: 5, kind: 'upgrade',
    split: splitOf(`contracts:code:${change.to}`), refs: { account, from: change.from, to: change.to },
    question: 'This account replaced its contract code. Compare the code before and after: which exported methods were added, which were removed, and which powers over users or funds did it gain? Empty lists where nothing changed.',
    input: { account, ...(height ? { new_code_deployed_at_block: height } : {}), upgraded_at: new Date(change.ts).toISOString(),
      how_to_read_the_code: `The new code: RPC view_code now. The old code: view_code with block_id ${height ? height - 1 : '(a block before the upgrade)'} on an archival RPC node. Decompile both and compare.` },
    answer_format: { type: 'sets', parts: ['added_methods', 'removed_methods', 'added_powers'], example: { added_methods: ['set_fee'], removed_methods: [], added_powers: ['set_fees'] } },
    options: { added_powers: powerNames },
    gold, rationale: same ? 'Nothing that matters changed: the same exported methods and no new power.' : [
      gold.added_methods.length && `Added: ${gold.added_methods.join(', ')}.`, gold.removed_methods.length && `Removed: ${gold.removed_methods.join(', ')}.`,
      gold.added_powers.length ? `New powers: ${gold.added_powers.join(', ')}. A quiet upgrade that adds a power is how a safe contract turns into a trap.` : 'No new power.',
      (change.removed_powers || []).length && `Powers removed: ${change.removed_powers.join(', ')}.`].filter(Boolean).join(' '),
    label_source: 'code: the exported methods and power rules of both audited codes',
  };
}

/** The key `balance` groups a contract task by: a class, or "none" for an empty answer (a non-empty answer is its own group). Pure. */
export function answerKey(t) {
  const f = t.answer_format.type;
  if (f === 'set') return t.gold.set.length ? t._id : 'none';
  if (f === 'sets') return Object.values(t.gold).some((x) => x.length) ? t._id : 'none';
  if (f === 'class') return t.gold.class;
  return t._id;
}

/** Every contract task: one set per distinct contract code, on one account that runs it, plus upgrades. Returns task documents (not stored). */
export async function buildContractTasks({ log = () => {} } = {}) {
  const codes = await col('code_audits').find({}, { projection: { role: 1, role_source: 1, label: 1, standards: 1, exports: 1, capabilities: 1, powers: 1 } }).toArray();
  const byId = new Map(codes.map((c) => [c._id, c]));
  const accts = new Map((await col('audits').aggregate([{ $match: { 'auto.code_key': { $in: codes.map((c) => c._id) } } }, { $sort: { _id: 1 } }, { $group: { _id: '$auto.code_key', account: { $first: '$_id' } } }]).toArray()).map((x) => [x._id, x.account]));
  const audits = new Map((await col('audits').find({ _id: { $in: [...accts.values()] } }, { projection: { 'auto.control': 1, 'auto.family_n': 1 } }).toArray()).map((a) => [a._id, a]));
  // a code is a launchpad's template when that launchpad's tokens run it (2 tokens or more)
  const runs = await col('audits').find({ 'auto.code_key': { $in: codes.map((c) => c._id) } }, { projection: { 'auto.code_key': 1 } }).toArray();
  const lpTok = new Map((await col('tokens').find({ _id: { $in: runs.map((x) => x._id) }, launchpad: { $type: 'string' } }, { projection: { launchpad: 1 } }).toArray()).map((t) => [t._id, t.launchpad]));
  const lpCount = new Map();
  for (const x of runs) { const lp = lpTok.get(x._id); if (lp) { const k = `${x.auto.code_key}|${lp}`; lpCount.set(k, (lpCount.get(k) || 0) + 1); } }
  const lpOf = new Map();
  for (const [k, n] of lpCount) { const [code, lp] = k.split('|'); if (n >= 2 && n > (lpOf.get(code)?.n || 0)) lpOf.set(code, { lp, n }); }
  const launchpads = [...new Set([...lpTok.values()])].sort();
  const out = [];
  for (const code of codes) { const account = accts.get(code._id); if (account) out.push(...contractTasks(code, account, { audit: audits.get(account), launchpad: lpOf.get(code._id)?.lp || null, launchpads })); }
  // upgrades: an account whose audit recorded a code change, with both codes audited
  const powerNames = r(codes.flatMap((c) => (c.powers || []).map((p) => p.power)));
  const changed = await col('audits').find({ 'auto.change.from': { $exists: true } }, { projection: { 'auto.change': 1 } }).toArray();
  for (const a of changed) {
    const ch = a.auto.change, from = byId.get(ch.from), to = byId.get(ch.to);
    if (!from || !to || ch.from === ch.to) continue;
    const dep = await col('contract_deploys').find({ account: a._id, ts: { $lte: ch.ts + 60e3 } }, { projection: { height: 1 } }).sort({ ts: -1 }).limit(1).toArray();
    out.push(upgradeTask(a._id, ch, from, to, { height: dep[0]?.height ?? null, powerNames }));
  }
  // most contracts have no powerful method, and most are locked: without balancing, one constant answer would pass a level
  const kept = balance(out, answerKey);
  const by = kept.reduce((m, t) => ((m[t.kind] = (m[t.kind] || 0) + 1), m), {});
  log(`contract tasks: ${kept.length} from ${codes.length} codes and ${changed.length} upgrades (${out.length - kept.length} dropped to keep levels balanced) ${JSON.stringify(by)}`);
  return kept;
}
