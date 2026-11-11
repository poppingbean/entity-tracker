// Safe Near Agent Guard as an MCP server: the tools an AI agent calls before it signs anything on NEAR. The same server runs remotely
// (POST /mcp on a Safe Near deployment, see web/server.js) and locally over stdio (agent/mcp-stdio.js). Every tool is read-only: Safe Near
// never holds a key and never signs; it refuses any input that carries a private key or a seed phrase.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { transactionsOf, policyViolations, decide, scopedKeyPlan, findSecret, DANGEROUS_ACTIONS } from './policy.js';

export const AGENT_GUARD_VERSION = '1.2.0';
const INSTRUCTIONS = `Safe Near checks NEAR Protocol transactions, accounts and contracts for an AI agent.
Before signing or sending ANY NEAR transaction, call guard_transaction with the transaction and the owner's policy, and follow its decision:
"allow" = go ahead, "ask_human" = stop and ask the person you work for, "block" = do not sign, tell the person why.
If guard_transaction fails or cannot be reached, do NOT sign: treat it as "ask_human".
Spending limits count everything the transaction sends out: NEAR, wNEAR, any token (ft_transfer) and NEAR Intents balances. Set USD limits to cap tokens.
Before paying or trusting an unknown account, token or link, call check_account. Before calling an unknown contract, call check_contract. To know what an account is (an exchange, a solver, a person), call what_is. For hacks on NEAR, call recent_hacks or get_incident.
To act for someone without holding their full-access key, call plan_scoped_key and ask them to sign the key it returns, once.
Never send a private key or a seed phrase to these tools: they never need one, and they refuse it.`;

const tx = z.record(z.string(), z.any());
const TX_FIELDS = {
  transaction: tx.optional().describe('One transaction: { signerId, receiverId, actions: [{ type, params }] } (wallet-selector) or { signer_id, receiver_id, actions } (near-api-js / RPC)'),
  transactions: z.array(tx).max(20).optional().describe('Several transactions signed together (up to 20)'),
  signer_id: z.string().optional().describe('The account that will sign, when the transaction does not say'),
  transaction_base64: z.string().optional().describe('An unsigned Transaction, Borsh bytes in base64'),
  signed_transaction_base64: z.string().optional().describe('A SignedTransaction, Borsh bytes in base64'),
  delegate_base64: z.string().optional().describe('A SignedDelegateAction (NEP-366 meta transaction), Borsh bytes in base64'),
};
const POLICY = z.object({
  max_near_per_tx: z.number().nonnegative().optional().describe('The most NEAR one transaction may send or attach'),
  max_near_per_request: z.number().nonnegative().optional().describe('The most NEAR all the transactions of this request may send together'),
  max_near_per_day: z.number().nonnegative().optional().describe('The most NEAR per day (with spent_near_today)'),
  allowed_receivers: z.array(z.string()).optional().describe('Accounts the agent may send to or call; "*.ref-finance.near" includes sub-accounts. Empty = any'),
  allowed_methods: z.array(z.string()).optional().describe('Contract methods the agent may call. Empty = any'),
  forbidden_actions: z.array(z.string()).optional().describe(`Actions never allowed. Default: ${Object.keys(DANGEROUS_ACTIONS).join(', ')}`),
  max_usd_per_tx: z.number().nonnegative().optional().describe('The most USD one transaction may send out, counting NEAR, wNEAR, tokens and NEAR Intents balances at today\'s prices'),
  max_usd_per_request: z.number().nonnegative().optional().describe('The most USD all the transactions of this request may send out together'),
  max_usd_per_day: z.number().nonnegative().optional().describe('The most USD per day (with spent_usd_today)'),
  block_on: z.array(z.enum(['block', 'warn', 'caution'])).optional().describe('Safe Near verdicts that block. Default: ["block"]'),
  ask_on: z.array(z.enum(['block', 'warn', 'caution'])).optional().describe('Safe Near verdicts that need a human. Default: ["warn"]'),
}).optional();
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const txBody = (a) => Object.fromEntries(['transaction', 'transactions', 'signer_id', 'transaction_base64', 'signed_transaction_base64', 'delegate_base64'].filter((k) => a[k] != null).map((k) => [k, a[k]]));
const reply = (text, data) => ({ content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
/** Every tool first refuses secrets, then turns any error into a readable tool error (never a crash). */
const guarded = (fn, { signing = false } = {}) => async (args) => {
  const secret = findSecret(args);
  if (secret) return fail(`Refused: the input contains ${secret}. Safe Near never needs a private key or a seed phrase. Treat it as leaked: move the funds to a new key.`);
  // a guard that could not run is not an "allow": the agent is told plainly not to sign
  try { return await fn(args); } catch (e) { return fail(`Safe Near could not check this: ${e.message}${signing ? '\nDo NOT sign this transaction: treat it as ASK_HUMAN until it can be checked.' : ''}`); }
};
const lines = (xs) => xs.map((x) => `- ${x}`).join('\n');

/** The MCP server with the Agent Guard tools, on top of `api` (localApi() or httpApi(): checkTx, inspect, contract, account). */
export function createAgentGuard(api) {
  const server = new McpServer({ name: 'safe-near', title: 'Safe Near Agent Guard', version: AGENT_GUARD_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool('guard_transaction', {
    title: 'Guard a transaction before signing',
    description: 'The one call to make before signing a NEAR transaction: Safe Near\'s transaction check plus the owner\'s policy (spending limits in NEAR and USD counting every token and NEAR Intents balance sent out, allowed receivers and methods, forbidden actions). Answers allow, ask_human or block, with the reasons. A check that could not finish answers ask_human, never allow.',
    inputSchema: { ...TX_FIELDS, policy: POLICY, spent_near_today: z.number().nonnegative().optional().describe('NEAR this agent already spent today (for max_near_per_day)'),
      spent_usd_today: z.number().nonnegative().optional().describe('USD this agent already spent today (for max_usd_per_day)') },
    annotations: READ_ONLY,
  }, guarded(async (a) => {
    const body = txBody(a);
    const txs = transactionsOf(body); // throws a readable error on a malformed transaction
    // the check first: it values the tokens the transactions send out, which the policy's limits count
    const check = await api.checkTx(body);
    const pol = policyViolations(txs, a.policy || {}, { spentToday: a.spent_near_today || 0, spentUsdToday: a.spent_usd_today || 0, value: check.value || null });
    const d = decide(check, pol, a.policy || {});
    const actions = (check.transactions || []).flatMap((t) => (t.actions || []).map((x) => x.text)).filter(Boolean);
    return reply(`${d.decision.toUpperCase()}: ${d.message}${d.reasons.length ? `\nWhy:\n${lines(d.reasons)}` : ''}\nWhat it does:\n${lines(actions.length ? actions : ['(no readable actions)'])}\nSafe Near verdict: ${check.verdict}${check.summary ? ` (${check.summary})` : ''}`,
      { ...d, summary: check.summary || null, findings: check.findings || [], actions, sends: (check.value?.moves || []).map((m) => ({ token: m.token, symbol: m.symbol, amount: m.amount, usd: m.usd, to: m.to })) });
  }, { signing: true }));

  server.registerTool('check_transaction', {
    title: 'Check a transaction',
    description: 'Safe Near\'s transaction check alone (no policy): verdict ok / caution / warn / block, what every action does in plain words, and the findings (flagged receivers, full-access keys, look-alike accounts, risky contracts, approvals).',
    inputSchema: { ...TX_FIELDS, explain: z.boolean().optional().describe('Add a plain-language explanation by NEAR AI (3-10 s slower)') },
    annotations: READ_ONLY,
  }, guarded(async (a) => {
    const check = await api.checkTx({ ...txBody(a), ...(a.explain ? { explain: true } : {}) });
    const actions = (check.transactions || []).flatMap((t) => (t.actions || []).map((x) => x.text)).filter(Boolean);
    return reply(`Verdict: ${check.verdict}${check.summary ? `: ${check.summary}` : ''}\nWhat it does:\n${lines(actions)}${(check.findings || []).length ? `\nFindings:\n${lines(check.findings.map((f) => `${f.severity}: ${f.title}`))}` : ''}`, check);
  }));

  server.registerTool('check_account', {
    title: 'Is it safe?',
    description: 'Is it safe to pay, trust or interact with this? Takes anything: a NEAR account, a token (or its name), an NFT collection, a contract, a transaction hash, an explorer or marketplace link, or a website. Answers safe / caution / danger with the reasons and any hack it is linked to.',
    inputSchema: { query: z.string().min(2).max(300).describe('An account, token, contract, transaction hash, link or website') },
    annotations: READ_ONLY,
  }, guarded(async ({ query }) => {
    const r = await api.inspect(query);
    const pts = (r.points || []).slice(0, 8).map((p) => (typeof p === 'string' ? p : p.text || p.title || JSON.stringify(p)));
    return reply(`${String(r.verdict || 'unknown').toUpperCase()}: ${r.headline || ''}${pts.length ? `\n${lines(pts)}` : ''}`, r);
  }));

  server.registerTool('check_contract', {
    title: 'Audit a contract',
    description: 'Safe Near\'s automated audit of a NEAR contract: what kind of contract it is, the powers its code gives someone over users (mint, freeze, upgrade, move funds), who holds them, the findings and a level (low / medium / high / critical).',
    inputSchema: { account: z.string().min(2).max(64).describe('The contract account, e.g. v2.ref-finance.near') },
    annotations: READ_ONLY,
  }, guarded(async ({ account }) => {
    const r = await api.contract(account.trim().toLowerCase());
    if (r.status && r.status !== 'ok') return reply(`No audit yet for ${account} (${r.status}). Treat it as unknown: ask a human before calling it.`, r);
    const f = (r.findings || []).filter((x) => x.severity !== 'info').slice(0, 6).map((x) => `${x.severity}: ${x.title}`);
    return reply(`${String(r.level || 'unknown').toUpperCase()}: ${r.type?.label || r.type?.role || 'contract'}${r.control?.summary ? ` · control: ${r.control.summary}` : ''}${r.summary?.headline ? `\n${r.summary.headline}` : ''}${f.length ? `\nFindings:\n${lines(f)}` : ''}`, r);
  }));

  server.registerTool('what_is', {
    title: 'What is this account?',
    description: 'What Safe Near calls a NEAR account (a person, an exchange hot or cold wallet, a NEAR Intents solver, a relayer, a router, a launchpad, a contract …), why, what weaker evidence it overruled, and its known links: who operates it, where it sweeps, who it funded, which hacks it played a role in. Use it before treating a payer or a receiver as "an exchange" or "a person".',
    inputSchema: { account: z.string().min(2).max(64).describe('A NEAR account, e.g. solver-priv-liq.near or a 64-hex implicit account') },
    annotations: READ_ONLY,
  }, guarded(async ({ account }) => {
    const r = await api.whatIs(account.trim().toLowerCase());
    const extra = [r.operator && `operated by ${r.operator.replace(/^org:/, '')}`, r.pass_through && 'passes money through (an endpoint, not an owner)', r.flagged && `flagged ${r.flagged.severity}: ${r.flagged.reason || ''}`,
      ...(r.cases || []).map((c) => `${c.role || 'involved'} in ${c.case} (${c.status || 'case'})`), ...(r.overruled || []).map((o) => `overruled: ${o.is} (${o.source}: ${o.evidence || ''})`)].filter(Boolean);
    return reply(`${r.account} is ${r.is}${r.label ? ` (${r.label})` : ''}. Why: ${r.why}${extra.length ? `\n${lines(extra)}` : ''}`, r);
  }));

  server.registerTool('recent_hacks', {
    title: 'Recent hacks on NEAR',
    description: 'The latest confirmed hacks on NEAR that Safe Near traced: what kind, who was hit, how much was taken, how much the attacker still holds, and the case id for get_incident.',
    inputSchema: { limit: z.number().int().min(1).max(20).optional().describe('How many (default 8)') },
    annotations: READ_ONLY,
  }, guarded(async ({ limit = 8 }) => {
    const rows = ((await api.incidents()).incidents || []).slice(0, limit);
    const usd = (x) => (x ? `$${Math.round(x).toLocaleString('en-US')}` : '?');
    const text = rows.length ? rows.map((r) => `- ${r._id}: ${r.kind || 'hack'}${r.target?.account ? ` of ${r.target.account}` : ''}, ${usd(r.stolen_usd)} taken${r.held_usd ? `, ${usd(r.held_usd)} still held` : ''}${r.started_ts ? ` (${new Date(r.started_ts).toISOString().slice(0, 10)})` : ''}${r.ai?.headline ? `: ${r.ai.headline}` : ''}`).join('\n') : 'No confirmed hacks.';
    return reply(`Recent confirmed hacks on NEAR:\n${text}`, { incidents: rows });
  }));

  server.registerTool('get_incident', {
    title: 'Is it part of a hack?',
    description: 'The confirmed hack a NEAR account, transaction hash, explorer link or case id (inc:…) belongs to, and its role in it (the attacker, a payout wallet, the target …): what was taken, from whom, where the money went, what is still held. Unconfirmed suspicions are never shown as hacks.',
    inputSchema: { query: z.string().min(2).max(300).describe('An account, a transaction hash, a NearBlocks link or a case id (inc:…)') },
    annotations: READ_ONLY,
  }, guarded(async ({ query }) => {
    const r = await api.incident(query.trim());
    if (!r?.incident) return reply(r?.checked ? `Safe Near has looked at ${query}: no hack is confirmed. That is not a guarantee.` : `No hack is linked to ${query} in Safe Near.`, r || {});
    const i = r.incident, usd = (x) => (x ? `$${Math.round(x).toLocaleString('en-US')}` : '?');
    const exits = Object.entries(i.trail?.exit_usd || {}).map(([k, v]) => `${k}: ${usd(v)}`);
    return reply(`${query} is ${r.role ? `${String(r.role).replace(/_/g, ' ')} in` : 'linked to'} a confirmed hack (${i._id}): ${i.kind || 'hack'}${i.target?.account ? ` of ${i.target.account}` : ''}, ${usd(i.stolen_usd)} taken${i.held_usd ? `, ${usd(i.held_usd)} still held` : ''}.${i.ai?.headline ? `\n${i.ai.headline}` : ''}${exits.length ? `\nWhere the money went:\n${lines(exits)}` : ''}\nAttacker: ${i.attacker?.account || '?'}`, r);
  }));

  server.registerTool('plan_scoped_key', {
    title: 'Plan a limited key for the agent',
    description: 'Instead of the owner\'s full-access key: the AddKey transaction for a function-call key limited to one contract and its methods, with a NEAR allowance that only pays gas (it can never send NEAR). The OWNER signs it once; the agent keeps only that key. Also returns the transaction to revoke it.',
    inputSchema: {
      owner: z.string().describe('The account the agent acts for'), contract: z.string().describe('The one contract the agent may call'),
      methods: z.array(z.string()).max(50).optional().describe('The methods it may call (empty = any method that takes no deposit)'),
      public_key: z.string().describe('The agent\'s new PUBLIC key, ed25519:<base58>. Never the private key'),
      allowance_near: z.number().positive().max(10).optional().describe('NEAR the key may spend on gas (default 0.25)'),
    },
    annotations: { ...READ_ONLY, openWorldHint: false },
  }, guarded(async (a) => {
    const plan = scopedKeyPlan(a);
    const audit = await api.contract(a.contract.trim().toLowerCase()).catch(() => null);
    const risk = audit?.level && ['high', 'critical'].includes(audit.level) ? `\nCareful: Safe Near rates ${a.contract} ${audit.level.toUpperCase()}${audit.findings?.[0] ? ` (${audit.findings[0].title})` : ''}. Check it before giving an agent access.` : '';
    return reply(`A key for the agent that can only call ${a.contract}.\nIt allows:\n${lines(plan.allows)}\nIt never allows:\n${lines(plan.never_allows)}\n${plan.note}${risk}`, { ...plan, contract_level: audit?.level || null });
  }));

  return server;
}
