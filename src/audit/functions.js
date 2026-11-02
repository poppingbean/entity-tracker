// Function review: what each method of a contract does, in plain words, for any contract (including those whose type nobody recognises).
//   rules    from the code itself (each method's reachable host calls, effectsFromWat): read-only or not, writes or deletes state, takes a
//            NEAR deposit, sends NEAR, calls other contracts, is a callback, reads who called it, uses randomness, adds keys or deploys code
//   NEAR AI  the purpose of each method and who can likely call it, from the method names, those effects, the contract's strings and
//            what the rest of the audit found. Its risk is capped by what the code can do: a method that cannot move money or change keys
//            or code is at most low risk, whatever the AI says
// Once per code (cached on the code audit).
import { config } from '../config.js';
import { chatJSON, aiEnabled } from '../ai/nearai.js';
import { UNTRUSTED_RULE, evidenceMessage } from '../ai/untrusted.js';
import { aiBudget } from './ai.js';

const STD_VIEW = /^(get_|is_|view_|ft_metadata|ft_total_supply|ft_balance_of|nft_token|nft_tokens|nft_metadata|nft_supply|nft_total_supply|storage_balance_of|storage_balance_bounds|contract_source_metadata|version|get|count|list|of|view|lookup|find|resolve_name)$|^(get|list|count|of|view)_/;
const SAY = { writes_state: 'changes stored data', deletes_state: 'deletes stored data', reads_deposit: 'accepts a NEAR deposit', send_near: 'sends NEAR out', call_contracts: 'calls other contracts',
  generic_promise: 'starts calls to other contracts', callback: 'handles the result of an earlier call', reads_caller: 'checks who called it', randomness: 'uses randomness',
  add_full_access_key: 'can add a full-access key', add_function_call_key: 'can add an app key', delete_key: 'can delete keys', deploy_code: 'can replace contract code',
  delete_account: 'can delete the account', stake: 'stakes NEAR', verifies_signature: 'verifies a signature', logs: 'emits events' };
const MONEY = new Set(['send_near', 'call_contracts', 'generic_promise']);
const CONTROL = new Set(['add_full_access_key', 'add_function_call_key', 'delete_key', 'deploy_code', 'delete_account']);
const RISK = ['none', 'low', 'medium', 'high'];

/** The rules' view of each method: kind, what it does, a risk from its effects. Pure (exported for tests). */
export function describeFunctions(exports, effects) {
  return (exports || []).map((m) => {
    const e = new Set(effects?.[m]?.effects || []);
    const writes = e.has('writes_state') || e.has('deletes_state') || [...MONEY, ...CONTROL].some((x) => e.has(x));
    // a view by its name, and unable to move money or change keys or code (shared SDK code often reaches a state write it never makes)
    const kind = /^(new|init|migrate)$|^new_/.test(m) ? 'setup' : e.has('callback') && /^(on_|resolve|.*_callback)|_callback$|^ft_resolve|^nft_resolve/.test(m) ? 'callback'
      : !writes || (STD_VIEW.test(m) && ![...MONEY, ...CONTROL, 'reads_deposit'].some((x) => e.has(x))) ? 'view' : 'call';
    const does = [...e].map((x) => SAY[x]).filter(Boolean);
    const risk = [...CONTROL].some((x) => e.has(x)) ? 'high' : kind !== 'view' && e.has('send_near') ? 'medium' : kind !== 'view' && (e.has('call_contracts') || e.has('generic_promise') || e.has('reads_deposit')) ? 'low' : 'none';
    return { method: m, kind, effects: [...e], does: kind === 'view' ? (does.filter((d) => !/emits/.test(d)).length ? does : ['reads data, changes nothing']) : does.length ? does : ['runs logic without lasting effects'], size: effects?.[m]?.size ?? null, risk };
  });
}

const SYSTEM = `You are a NEAR smart-contract reviewer explaining a contract's functions to an ordinary user. For each exported method you get
its name and what its compiled code can do (effects: changes stored data, accepts a deposit, sends NEAR, calls other contracts, checks
who called it, …), plus the contract's strings and what an automated audit already found. Explain each method's likely purpose in one plain
sentence, who can likely call it (anyone, the owner/admin, only the contract itself as a callback, nobody after setup), and its risk to
users. Base every claim on the method name, its effects and the strings; say "likely" when you infer. Also say in 2-3 sentences what the
contract as a whole seems to be for.
Answer with ONE JSON object: {"contract":"2-3 sentences","functions":[{"method":"exact name","purpose":"one sentence","who":"anyone|owner|callback|setup|unclear","risk":"none|low|medium|high","note":"optional: what a user should know"}]}`;

/** NEAR AI's reading of every method (null when the AI is off or the budget is spent). Unknown methods are dropped; risks are capped by the code. */
export async function aiFunctionReview(code, functions, strings = []) {
  if (!aiEnabled() || !(await aiBudget())) return null;
  const evidence = { audit: { type: code.label || code.role, standards: code.standards, powers: (code.powers || []).map((p) => ({ power: p.power, methods: p.methods })) },
    functions: functions.slice(0, 120).map((f) => ({ method: f.method, kind: f.kind, effects: f.effects, size: f.size })), strings: strings.slice(0, 40), source: code.source || null };
  const { user, findings } = evidenceMessage('Contract functions to explain:', evidence);
  const { json, model } = await chatJSON({ system: SYSTEM + UNTRUSTED_RULE, user, model: config.ai.model, maxTokens: 4000, timeoutMs: config.ai.analysisTimeoutMs, attempts: 2 }).catch(() => ({}));
  if (!Array.isArray(json?.functions)) return null;
  const rules = new Map(functions.map((f) => [f.method, f]));
  const items = json.functions.filter((x) => rules.has(x?.method)).map((x) => {
    const r = rules.get(x.method), e = new Set(r.effects);
    // the AI may raise a risk only as far as the code allows: no money or control effect, at most low
    const cap = [...CONTROL].some((c) => e.has(c)) ? 'high' : [...MONEY].some((c) => e.has(c)) || e.has('reads_deposit') ? 'medium' : 'low';
    const ai = RISK.includes(x.risk) ? x.risk : 'low';
    return { method: x.method, purpose: String(x.purpose || '').slice(0, 240), who: ['anyone', 'owner', 'callback', 'setup', 'unclear'].includes(x.who) ? x.who : 'unclear', risk: RISK[Math.min(RISK.indexOf(ai), RISK.indexOf(cap))], note: String(x.note || '').slice(0, 240) };
  });
  return { contract: String(json.contract || '').slice(0, 600), functions: items, model, ts: Date.now(), injection: findings?.length ? findings : undefined };
}

/** Rules and AI merged, for the page and the API. */
export function mergeFunctions(rules, ai) {
  const a = new Map((ai?.functions || []).map((f) => [f.method, f]));
  return rules.map((r) => { const x = a.get(r.method); return { ...r, purpose: x?.purpose || null, who: x?.who || (r.kind === 'callback' ? 'callback' : r.kind === 'setup' ? 'setup' : null), risk: x ? (RISK.indexOf(x.risk) > RISK.indexOf(r.risk) ? x.risk : r.risk) : r.risk, note: x?.note || null }; });
}
