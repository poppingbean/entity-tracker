// Automated contract audit for any kind of contract (not only tokens). Code is audited once per code hash or global contract
// (`code_audits`: type, standards, powers, what each method can reach in the code, backdoors, the claimed source, AI labels and the deep
// review); each account then gets its own layer (`audits.auto`): who controls it, the checks for its type, recent behaviour, the deployer,
// what changed since its last code, the findings with one risk level, and a plain-language summary. The existing token audit (keys, code,
// sells, tax) still runs and its results are kept, so the scanner and the firewall keep working as before.
import { col } from '../db.js';
import { config } from '../config.js';
import { warn } from '../log.js';
import { viewAccount, viewCode, viewFunction, EMPTY_CODE_HASH } from './rpc.js';
import { wasmExports, staticAnalysis, STANDARD } from './analysis.js';
import { auditNearContract, summarizeAudit, validNearAddress } from './service.js';
import { classifyContract, ROLE_LABEL } from './classify.js';
import { powerInventory, unknownWrites, powerSeverity, POWERS, SEV } from './powers.js';
import { controlOf, reputationOf } from './control.js';
import { typeChecks, recentBehaviour } from './checks.js';
import { auditFindings, controlSummary } from './findings.js';
import { codeCapabilities, codeEffects, DANGEROUS } from './wasm.js';
import { describeFunctions, aiFunctionReview, mergeFunctions } from './functions.js';
import { reviewSource } from './source.js';
import { aiCodeReview, aiDeepReview, aiExplainChange, aiWriteUp } from './ai.js';

export const AUTO_AUDIT_V = 5; // bump when the audit logic changes: older code audits are redone
const STANDARD_METHODS = new Set([...STANDARD, 'nft_transfer', 'nft_transfer_call', 'nft_token', 'nft_approve', 'nft_revoke', 'nft_revoke_all', 'nft_is_approved', 'nft_resolve_transfer',
  'nft_payout', 'nft_transfer_payout', 'mt_transfer', 'mt_transfer_call', 'mt_batch_transfer', 'mt_batch_transfer_call', 'deposit', 'deposit_and_stake', 'stake', 'unstake', 'unstake_all',
  'withdraw', 'withdraw_all', 'stake_all', 'swap', 'add_liquidity', 'remove_liquidity', 'execute', 'add_proposal', 'act_proposal', 'confirm', 'add_request', 'delegate', 'undelegate', 'vote', 'ping']);
const IS_VIEW = /^(get_|is_|view_|list_|query_)|_(of|info|list|status|count|config|state|balance|metadata)$/;
// readable strings from the code that say what it checks (panic / assert / log messages), for the AI
const TELLING = /owner|admin|only|not allowed|unauthori|forbidden|paused|blacklist|fee|tax|must|cannot|can't|invalid|guardian|operator|whitelist|limit|mint|burn|upgrade|frozen|locked/i;
const stringsOf = (code) => [...new Set((code.toString('latin1').match(/[ -~]{12,160}/g) || []).filter((s) => TELLING.test(s) && /[a-z]{3,} [a-z]{2,}/i.test(s)))].slice(0, 60);

/** The code an account runs: its own code hash, or the global contract it points at. null when it has no code. */
export function codeKeyOf(acc) {
  if (!acc) return null;
  if (acc.global_contract_account_id) return `global:${acc.global_contract_account_id}`;
  if (acc.global_contract_hash) return `global:${acc.global_contract_hash}`;
  return acc.code_hash && acc.code_hash !== EMPTY_CODE_HASH ? `code:${acc.code_hash}` : null;
}

/** The code audit for this account's code: read once per code and cached (rules, then the AI code review and the claimed source). */
export async function auditCode(account, acc = null, { force = false, ai = true } = {}) {
  acc ||= await viewAccount(account);
  const key = codeKeyOf(acc);
  if (!key) return null;
  if (!force) { const c = await col('code_audits').findOne({ _id: key }); if (c && c.v === AUTO_AUDIT_V) return c; }
  const code = await viewCode(account).catch(() => null);
  const exports = code ? wasmExports(code) : null;
  let cls = classifyContract(exports);
  const stat = code ? staticAnalysis(code, cls.standards.includes('nep141')) : null;
  const writes = (exports || []).filter((m) => !IS_VIEW.test(m));
  const capsAll = code ? await codeCapabilities(code, writes) : null;
  const capabilities = capsAll ? Object.fromEntries(Object.entries(capsAll).filter(([, v]) => v.caps.length)) : null;
  const strings = code ? stringsOf(code) : [];
  const src = exports?.includes('contract_source_metadata') ? await viewFunction(account, 'contract_source_metadata') : null;
  let powers = powerInventory(exports, cls.role, { fakeStorage: stat?.fakeStorage || [] });
  let unknown = unknownWrites(exports, powers, STANDARD_METHODS).slice(0, 40);
  const prev = await col('code_audits').findOne({ _id: key }, { projection: { ai: 1, ai_deep: 1, ai_functions: 1, first_seen_ts: 1, source_review: 1 } });
  const effects = code ? await codeEffects(code) : null;
  const doc = {
    _id: key, v: AUTO_AUDIT_V, first_account: account, kb: code ? Math.round(code.length / 1024) : null, exports_n: exports?.length ?? null, exports: exports?.slice(0, 400) || null,
    role: cls.role, label: cls.label, standards: cls.standards, confidence: cls.confidence, candidates: cls.candidates || [], why: cls.why || null, role_source: 'rules',
    powers, capabilities, fake_storage: stat?.fakeStorage || [], owner_guard: !!stat?.ownerGuard, unknown_writes: unknown, strings: strings.slice(0, 40),
    source: src ? { version: src.version || null, link: src.link || null, standards: (src.standards || []).map((s) => s.standard) } : null,
    audited_ts: Date.now(),
  };
  // the AI code review (stages 1 + 2): only when the rules couldn't place the contract or some write methods are unknown; once per code
  let aiReview = prev?.ai || null;
  const hiddenDanger = Object.entries(capabilities || {}).some(([m, v]) => v.caps.some((c) => DANGEROUS.has(c)) && !powers.some((p) => p.methods.includes(m)));
  if (ai && !aiReview && exports && (cls.role === 'unknown' || cls.confidence === 'low' || unknown.length || hiddenDanger)) aiReview = await aiCodeReview(doc, strings).catch((e) => { warn(`audit AI code review ${key}: ${e.message}`); return null; });
  if (aiReview) {
    doc.ai = aiReview;
    if ((doc.role === 'unknown' || doc.confidence === 'low') && aiReview.role && aiReview.role !== 'unknown' && aiReview.role_confidence >= 0.6) {
      doc.role = aiReview.role; doc.label = ROLE_LABEL(aiReview.role); doc.confidence = 'low'; doc.role_source = 'ai';
      doc.powers = powers = powerInventory(exports, doc.role, { fakeStorage: stat?.fakeStorage || [] });
    }
    // the AI's power labels for methods the tables don't know (only real exports, only known powers)
    // an AI label needs confidence, is capped at medium (high and critical need evidence the rules can check), and "account control"
    // needs the code to actually reach a key action
    const keyActions = (m) => (capabilities?.[m]?.caps || []).some((c) => /key|generic_promise/.test(c));
    for (const p of aiReview.powers.filter((x) => x.power !== 'none' && x.confidence >= 0.6 && !powers.some((q) => q.methods.includes(x.method)))) {
      const power = p.power === 'account_control' && !keyActions(p.method) ? 'set_admins' : p.power;
      const sev = powerSeverity(doc.role, power);
      const same = powers.find((q) => q.power === power);
      if (same) { same.methods = [...same.methods, p.method].slice(0, 12); same.ai_methods = [...(same.ai_methods || []), p.method]; continue; } // joins the rules' entry for that power
      powers.push({ power, label: POWERS[power].label, methods: [p.method], severity: SEV.indexOf(sev) < SEV.indexOf('medium') ? 'medium' : sev, source: 'ai', reason: p.reason });
    }
    powers.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
    doc.powers = powers;
    doc.unknown_writes = unknown = unknown.filter((m) => !aiReview.powers.some((p) => p.method === m));
  }
  // the claimed source (stage 4, deterministic part): does it define the deployed methods?
  if (doc.source?.link) {
    const sr = prev?.source_review?.link === doc.source.link ? prev.source_review : await reviewSource(doc.source.link, writes, powers.flatMap((p) => p.methods)).catch(() => null);
    if (sr) doc.source_review = { link: sr.link, ref: sr.ref || null, files_read: sr.files_read || 0, missing: sr.missing || [], error: sr.error || null, excerpts: (sr.excerpts || []).slice(0, 8) };
  }
  if (prev?.ai_deep) doc.ai_deep = prev.ai_deep;
  // the function review: what each method does (rules from the code), and NEAR AI's reading of each one for contracts the rules
  // could not place (or when someone asks for a fresh audit); once per code
  if (exports?.length) {
    const rules = describeFunctions(exports.slice(0, 200), effects);
    let aiFn = !force && prev?.ai_functions ? prev.ai_functions : null;
    if (ai && !aiFn && exports.length <= 200 && (force || doc.role === 'unknown' || doc.confidence === 'low')) aiFn = await aiFunctionReview(doc, rules, strings).catch((e) => { warn(`audit AI function review ${key}: ${e.message}`); return null; });
    if (aiFn) doc.ai_functions = aiFn;
    doc.functions = mergeFunctions(rules, aiFn);
  }
  await col('code_audits').replaceOne({ _id: key }, { ...doc, first_seen_ts: prev?.first_seen_ts || Date.now() }, { upsert: true });
  return doc;
}

/** A role from the code audit of another account (for controllers): cached, no AI, no recursion into control. */
const roleOf = async (id) => (await auditCode(id, null, { ai: false }).catch(() => null))?.role || null;
const HOLDS_VALUE = new Set(['amm', 'liquid_staking', 'staking_pool', 'lending', 'bridge', 'router', 'orderbook', 'farm', 'nft_marketplace', 'token', 'nft', 'account', 'factory']);

/**
 * Audit any contract account. `deploy` = { by, signer } when the deploy watcher found it; `ai: false` skips the AI stages.
 * Stores everything in `audits.auto` and returns the audit document.
 */
export async function autoAudit(account, { deploy = null, force = false, ai = true } = {}) {
  if (!validNearAddress(account)) throw new Error('invalid NEAR account id');
  const acc = await viewAccount(account);
  if (!acc) return { _id: account, notFound: true };
  const code = await auditCode(account, acc, { force, ai });
  if (!code) { await col('audits').updateOne({ _id: account }, { $set: { auto: { v: AUTO_AUDIT_V, ts: Date.now(), no_code: true } } }, { upsert: true }); return { _id: account, auto: { no_code: true } }; }
  const before = await col('audits').findOne({ _id: account }, { projection: { auto: 1 } });
  // the existing audit: keys, code checks, token sells and tax (kept as is for the scanner and the firewall)
  const legacy = await auditNearContract(account, { force }).catch(() => null);
  const leg = legacy ? summarizeAudit(legacy) : null;
  const control = await controlOf(account, code.exports, { roleOf });
  const owners = control.controllers.map((c) => c.account);
  const [tc, beh] = await Promise.all([typeChecks(account, code.role, code.exports || [], { owners }), recentBehaviour(account, code.powers)]);
  let dep = null;
  if (deploy?.by || deploy?.signer) {
    const ids = [...new Set([deploy.by, deploy.signer].filter((x) => x && validNearAddress(x)))];
    const rep = await reputationOf(ids);
    dep = { deployer: deploy.by, signer: deploy.signer, kind: deploy.kind || null, deployer_flags: ids.flatMap((id) => (rep.get(id) || []).map((t) => `${id}: ${t}`)) };
  } else if (before?.auto?.deploy) dep = before.auto.deploy;
  const extra = [...tc.findings, ...beh.findings];
  const sr = code.source_review;
  if (sr?.missing?.length) extra.push({ severity: 'medium', key: 'source_mismatch', title: `${sr.missing.length} deployed method${sr.missing.length > 1 ? 's are' : ' is'} not in the claimed source`, detail: `${sr.missing.slice(0, 10).join(', ')} run on chain but don't appear in ${sr.link}: the published code is not exactly what is deployed.` });
  else if (sr?.error) extra.push({ severity: 'low', key: 'source_unreachable', title: 'The claimed source could not be read', detail: `${sr.link}: ${sr.error}` });
  const malicious = (leg?.confirmed_malicious || []).filter((m) => m.key !== 'fakeStorageMethod').map((m) => ({ key: m.key, title: 'Backdoor confirmed by the contract audit', detail: m.detail }));
  let { level, findings } = auditFindings({ code: { ...code, confirmed_malicious: malicious }, control, checks: extra, deploy: dep });
  const family = await col('audits').countDocuments({ 'auto.code_key': code._id, _id: { $ne: account } });
  const auto = {
    v: AUTO_AUDIT_V, ts: Date.now(), code_key: code._id, family_n: family + 1, role: code.role, label: ROLE_LABEL(code.role), role_source: code.role_source, standards: code.standards, confidence: code.confidence,
    powers: code.powers, control: { ...control, summary: controlSummary(control) }, facts: { ...tc.facts, behaviour: beh.facts }, deploy: dep, level, findings,
    source: code.source, source_review: sr ? { link: sr.link, ref: sr.ref, files_read: sr.files_read, missing: sr.missing, error: sr.error } : null, ai_code: code.ai ? { role: code.ai.role, role_reason: code.ai.role_reason, model: code.ai.model } : null, functions: code.functions || null, ai_contract: code.ai_functions?.contract || null,
  };
  // what changed since the account's previous code (stage 5)
  if (before?.auto?.code_key && before.auto.code_key !== code._id) {
    const pp = new Set((before.auto.powers || []).map((p) => p.power)), np = new Set(code.powers.map((p) => p.power));
    const change = { from: before.auto.code_key, to: code._id, ts: Date.now(), added_powers: [...np].filter((p) => !pp.has(p)), removed_powers: [...pp].filter((p) => !np.has(p)), role_before: before.auto.role, role_after: code.role };
    if (ai) change.ai = await aiExplainChange({ ...change, powers_before: before.auto.powers, powers_after: code.powers }).catch(() => null);
    auto.change = change;
    if (change.added_powers.length) findings.unshift({ severity: change.added_powers.some((p) => ['move_user_funds', 'account_control', 'mint'].includes(p)) ? 'high' : 'medium', key: 'power_added', title: `The new code adds powers: ${change.added_powers.join(', ')}`, detail: change.ai?.explanation || 'The contract was redeployed with new powers over its users.' });
  }
  // the deep review (stages 3 + 4 + 6), once per code, for contracts that hold value or look risky
  const risky = ['critical', 'high'].includes(level) || findings.some((f) => ['hidden_power', 'unguarded_power', 'source_mismatch'].includes(f.key));
  if (ai && !code.ai_deep && (risky || (HOLDS_VALUE.has(code.role) && (code.unknown_writes?.length || code.source_review?.excerpts?.length)))) {
    const deep = await aiDeepReview(code, auto, code.strings || [], code.source_review).catch((e) => { warn(`audit AI deep review ${account}: ${e.message}`); return null; });
    if (deep) { code.ai_deep = deep; await col('code_audits').updateOne({ _id: code._id }, { $set: { ai_deep: deep } }); }
  }
  if (code.ai_deep) { auto.ai_deep = { summary: code.ai_deep.summary, model: code.ai_deep.model, dropped: code.ai_deep.dropped }; findings.push(...code.ai_deep.findings); }
  // the level again with the AI findings (they can only add risk) and the change, worst first
  findings.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
  auto.findings = findings;
  auto.level = level = worstLevel(level, ...findings.filter((f) => f.severity !== 'info').map((f) => f.severity)) || level;
  // the plain-language summary (stage 7)
  if (ai && config.autoAudit.writeUp) auto.summary = await aiWriteUp(account, auto).catch(() => null);
  await col('audits').updateOne({ _id: account }, { $set: { auto } }, { upsert: true });
  return { ...(legacy || { _id: account }), auto };
}

/** The worse of several levels (critical worst). */
export const worstLevel = (...ls) => ls.filter((l) => SEV.includes(l)).sort((a, b) => SEV.indexOf(a) - SEV.indexOf(b))[0] || null;
