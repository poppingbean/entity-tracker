// Academy track "contracts": read a NEAR contract the way an auditor (or an attacker) does. The answers come from facts in the deployed code,
// not from an AI: the automated audit decompiles each method (wabt) and walks its call graph to the NEAR host functions it reaches (send
// NEAR, deploy code, add / delete keys, delete the account, read the caller). Each task names a real account: reading its code is the skill
// (RPC `view_code`, or any decompiler). Levels:
//   1  the contract's type and the NEAR standards it implements (types the rules set from the code, never an AI's guess)
//   2  which methods can do something powerful (send NEAR, deploy code, add or delete keys, delete the account, stake)
//   3  which of those never check who is calling (an open door: anyone can call them)
//   4  which methods give someone power over users (move their funds, freeze, mint, upgrade, take fees, control accounts): the audit's rules
import { col } from '../db.js';
import { taskId, splitOf, balance } from './tasks.js';

export const POWER_CAPS = { send_near: 'sends NEAR', deploy_code: 'deploys code', add_full_access_key: 'adds a full-access key', add_function_call_key: 'adds a function-call key', delete_key: 'deletes a key', delete_account: 'deletes the account', stake: 'stakes' };
const USER_POWERS = new Set(['move_user_funds', 'freeze', 'mint', 'upgrade', 'set_fees', 'account_control']);
const TYPES = ['token', 'nft', 'multi_token', 'amm', 'farm', 'factory', 'bridge', 'nft_marketplace', 'router', 'orderbook', 'account', 'lending', 'staking', 'dao', 'multisig', 'oracle', 'launchpad', 'lockup', 'liquid_staking', 'treasury'];

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
  return [...new Set((code.powers || []).filter((p) => USER_POWERS.has(p.power) && ['critical', 'high', 'medium'].includes(p.severity)).flatMap((p) => p.methods || []))].sort();
}

/** The tasks of one contract code, run by `account`. Pure. */
export function contractTasks(code, account) {
  const out = [], exports = (code.exports || []).slice().sort();
  const base = (level, kind, extra) => {
    const id = taskId('contracts', kind, `${code._id}`);
    // one split per contract, not per task: a level-3 task lists the level-2 answer, so a contract's tasks are all training or all test
    return { _id: id, track: 'contracts', level, kind, split: splitOf(`contracts:code:${code._id}`), refs: { account, code: code._id }, ...extra };
  };
  const input = { account, exported_methods: exports, how_to_read_the_code: 'RPC query { request_type: "view_code", account_id } returns the WASM (base64); decompile it (e.g. wasm2wat) and follow each exported method' };
  if (code.role && code.role !== 'unknown' && code.role_source === 'rules') {
    out.push(base(1, 'type', {
      question: 'What kind of contract is this, and which NEAR standards (NEP numbers) does it implement?',
      input, answer_format: { type: 'class+set', example: { class: 'token', set: ['nep141', 'nep145'] } }, options: { types: TYPES },
      gold: { class: code.role, set: (code.standards || []).map(String) }, rationale: `Its exported methods make it ${/^[aeiou]/.test(code.role) ? 'an' : 'a'} ${code.role}${code.label && code.label !== code.role ? ` (${code.label})` : ''}; standards: ${(code.standards || []).join(', ') || 'none'}.`, label_source: 'code: exported methods and their signatures (rules)',
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
  }
  if (strong.length) {
    const open = openMethods(code);
    out.push(base(3, 'open_doors', {
      question: `These methods can do something powerful: ${strong.join(', ')}. Which of them never check who is calling (anyone could call them)? List the method names (an empty list if all check).`,
      input: { ...input, powerful_methods: strong }, answer_format: { type: 'set', example: { set: ['sweep'] } },
      gold: { set: open }, rationale: open.length ? `${open.join(', ')} ${open.length > 1 ? 'reach' : 'reaches'} a powerful action with no read of the caller (predecessor / signer) anywhere in the call graph: anyone can call ${open.length > 1 ? 'them' : 'it'}. Whether that loses money depends on where the value goes (a fixed owner, or an address the caller chooses).` : `Every one of them reads who is calling before acting.`,
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

/** Every contract task: one set per distinct contract code, on one account that runs it. Returns task documents (not stored). */
export async function buildContractTasks({ log = () => {} } = {}) {
  const codes = await col('code_audits').find({}, { projection: { role: 1, role_source: 1, label: 1, standards: 1, exports: 1, capabilities: 1, powers: 1 } }).toArray();
  const accts = new Map((await col('audits').aggregate([{ $match: { 'auto.code_key': { $in: codes.map((c) => c._id) } } }, { $sort: { _id: 1 } }, { $group: { _id: '$auto.code_key', account: { $first: '$_id' } } }]).toArray()).map((x) => [x._id, x.account]));
  const out = [];
  for (const code of codes) { const account = accts.get(code._id); if (account) out.push(...contractTasks(code, account)); }
  // most contracts have no powerful method: without this, answering "none" every time would pass level 2. A non-empty answer is its own group.
  const kept = balance(out, (t) => (t.answer_format.type === 'set' ? (t.gold.set.length ? t._id : 'none') : t._id));
  log(`contract tasks: ${kept.length} from ${codes.length} codes (${out.length - kept.length} "none" answers dropped to keep levels balanced)`);
  return kept;
}
