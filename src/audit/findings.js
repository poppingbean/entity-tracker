// From what the automated audit read (code powers, who controls the contract, checks for its type, recent behaviour, the deployer) to
// findings and one risk level. Pure (unit-tested). A power is judged by who holds it: a DAO or multisig, or nobody, makes it less
// dangerous than a single wallet; an owner the tracker knows as a rugger makes it worse.
import { SEV } from './powers.js';
import { DANGEROUS } from './wasm.js';

const shift = (sev, by) => SEV[Math.max(0, Math.min(SEV.length - 1, SEV.indexOf(sev) + by))];
const HOLDS_FUNDS = new Set(['amm', 'liquid_staking', 'staking_pool', 'lending', 'bridge', 'router', 'orderbook', 'farm', 'nft_marketplace', 'factory', 'account']);

/**
 * code    = { role, label, powers: [{ power, label, methods, severity, normal_for_role }], fake_storage, confirmed_malicious: [...], source }
 * control = { full_keys, controllers: [{ account, kind: dao|multisig|contract|wallet|missing, flags: [...] }], summary }
 * checks  = [{ severity, key, title, detail }] (from the type checks and behaviour)
 * deploy  = { deployer, deployer_flags: [...] } (optional)
 * -> { level, findings: [{ severity, key, title, detail }] }, worst first.
 */
export function auditFindings({ code, control = {}, checks = [], deploy = null, corroborated = [] }) {
  const f = [];
  const add = (severity, key, title, detail) => f.push({ severity, key, title, detail });
  for (const m of code.confirmed_malicious || []) add('critical', m.key, m.title || 'Backdoor in the code', m.detail || '');
  if (code.fake_storage?.length) add('critical', 'fake_storage', 'Fake storage method: a known honeypot backdoor', `${code.fake_storage.join(', ')} is not part of NEP-145; contracts like this use it to wipe holders' balances.`);

  const ctl = control.controllers || [], kinds = new Set(ctl.map((c) => c.kind));
  const isGov = (c) => c.kind === 'dao' || c.kind === 'multisig' || c.kind === 'locked';
  // the OWNER decides upgrades and admin changes; guardians and operators usually only pause. A governed owner governs the contract.
  const owners = ctl.filter((c) => /owner/i.test(c.via || ''));
  const governed = owners.length ? owners.every(isGov) : ctl.length > 0 && ctl.every(isGov);
  const flaggedOwner = ctl.find((c) => c.flags?.length);
  // who holds the powers: governance lowers them one step, a flagged owner raises them one step. "No owner found" changes nothing: the
  // code may still check an owner that no view exposes
  const by = flaggedOwner ? -1 : governed ? 1 : 0; // SEV runs critical -> info: +1 is milder
  const KIND = { dao: 'a DAO', multisig: 'a multisig', locked: 'a locked contract', contract: 'a contract with a full-access key', wallet: 'a single wallet', missing: 'an account that does not exist' };
  const who = flaggedOwner ? `held by ${flaggedOwner.account}, ${flaggedOwner.flags[0]}` : governed ? `owned by ${[...new Set((owners.length ? owners : ctl).map((c) => c.kind))].map((k) => KIND[k]).join(' / ')}${owners.length ? ` (${owners[0].account})` : ''}` : ctl.length ? `held by ${ctl.map((c) => `${c.account} (${KIND[c.kind] || c.kind}${c.via ? `, ${c.via}` : ''})`).slice(0, 3).join(', ')}` : control.full_keys ? 'held by whoever has the full-access key' : 'no owner exposed by a view (the code may still check one)';
  for (const p of code.powers || []) {
    if (p.power === 'move_user_funds' && code.fake_storage?.length && p.methods.every((m) => code.fake_storage.includes(m))) continue; // already reported
    // where the money can go (destination.js): a code hint is only shown; the chain confirming EVERY method lowers it one step, no more
    const funds = p.power === 'move_user_funds', hinted = funds ? p.methods.filter((m) => code.owner_check?.includes(m)) : [];
    const confirmedSome = funds ? p.methods.filter((m) => corroborated.includes(m)) : [];
    const confirmedAll = funds && p.methods.length > 0 && confirmedSome.length === p.methods.length;
    const sev = shift(shift(p.severity, by), confirmedAll ? 1 : 0);
    if (sev === 'info') continue;
    const where = [
      hinted.length ? ` The code of ${hinted.join(', ')} appears to check the receiver against a stored owner hash (a pattern in the code, not proof: it does not lower the risk on its own).` : '',
      confirmedSome.length ? ` On the chain, every payout of ${confirmedSome.join(', ')} went to the address committed when the contract was set up${confirmedAll ? '' : '; the other methods are not confirmed'}.` : '',
    ].join('');
    add(sev, `power_${p.power}`, `${p.label}${p.normal_for_role ? ' (normal for this kind of contract)' : ''}`, `${p.methods.join(', ')}; ${who}.${where}`);
  }
  if (control.full_keys > 0) {
    const sev = HOLDS_FUNDS.has(code.role) ? 'high' : code.role === 'token' || code.role === 'nft' ? 'high' : 'medium';
    add(sev, 'full_access_key', `${control.full_keys} full-access key${control.full_keys > 1 ? 's' : ''} on the contract`, 'Whoever holds it can replace the code or move everything the contract holds, whatever the code says.');
  }
  if (flaggedOwner) add('high', 'flagged_owner', `Controlled by a flagged account: ${flaggedOwner.account}`, flaggedOwner.flags.join('; '));
  if (deploy?.deployer_flags?.length) add('high', 'flagged_deployer', `Deployed by a flagged account: ${deploy.deployer_flags.map((x) => x.split(':')[0]).filter((x, i, a) => a.indexOf(x) === i).join(', ')}`, deploy.deployer_flags.join('; '));
  // what the code can actually do: a harmless-sounding method that reaches a dangerous host action, a power method that never reads the caller
  const named = new Set((code.powers || []).flatMap((p) => p.methods));
  const CAP = { deploy_code: 'deploys code', add_full_access_key: 'adds a full-access key', add_function_call_key: 'adds an access key', delete_key: 'removes an access key', delete_account: 'deletes the account', send_near: 'sends NEAR' };
  for (const [m, v] of Object.entries(code.capabilities || {})) {
    const danger = v.caps.filter((c) => DANGEROUS.has(c));
    if (danger.length && !named.has(m) && !/^(new|migrate|init)$/.test(m) && !(danger.length === 1 && danger[0] === 'send_near')) // sending NEAR alone is what withdrawals do
      add('high', 'hidden_power', `${m} ${danger.map((c) => CAP[c]).join(', ')}`, `Its name doesn't say so, but the code behind ${m} calls the NEAR host functions that ${danger.map((c) => CAP[c]).join(' and ')}.`);
    if (named.has(m) && !v.dynamic && !v.caps.includes('reads_caller')) {
      const p = (code.powers || []).find((x) => x.methods.includes(m));
      if (p && ['critical', 'high', 'medium'].includes(p.severity)) add('critical', 'unguarded_power', `${m} never checks who calls it`, `${p.label}, and the code behind ${m} never reads the caller's account: anyone may be able to call it.`);
    }
  }
  for (const c of checks) f.push(c);
  if (code.role === 'unknown') add('low', 'unknown_type', 'Type not recognised', code.why || 'Its methods match no known kind of contract: the checks for its type could not run.');
  if (!code.source?.link) add('info', 'no_source', 'No published source', 'The contract does not publish where its source code is (NEP-330).');
  else add('info', 'source_claimed', 'Source link published (not verified against the deployed code)', code.source.link);

  const seen = new Set(), uniq = f.filter((x) => (seen.has(x.key + x.title) ? false : seen.add(x.key + x.title)));
  uniq.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
  const worst = uniq.find((x) => x.severity !== 'info')?.severity || 'low';
  return { level: worst === 'info' ? 'low' : worst, findings: uniq };
}

/** One short line about who controls a contract, for lists and the firewall. */
export function controlSummary(control) {
  const ctl = control.controllers || [];
  if (control.full_keys) return `${control.full_keys} full-access key${control.full_keys > 1 ? 's' : ''}${ctl.length ? ` + ${ctl[0].kind} owner` : ''}`;
  if (!ctl.length) return 'locked (no keys, no owner found)';
  const kinds = [...new Set(ctl.map((c) => c.kind))];
  return `owner: ${kinds.join(' / ')}${ctl.some((c) => c.flags?.length) ? ' (flagged)' : ''}`;
}
