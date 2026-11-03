// Safe Near Agent Guard as an MCP server: the tools an AI agent calls before it signs anything on NEAR. The same server runs remotely
// (POST /mcp on a Safe Near deployment, see web/server.js) and locally over stdio (agent/mcp-stdio.js). Every tool is read-only: Safe Near
// never holds a key and never signs; it refuses any input that carries a private key or a seed phrase.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { transactionsOf, policyViolations, decide, scopedKeyPlan, findSecret, DANGEROUS_ACTIONS } from './policy.js';

export const AGENT_GUARD_VERSION = '1.0.0';
const INSTRUCTIONS = `Safe Near checks NEAR Protocol transactions, accounts and contracts for an AI agent.
Before signing or sending ANY NEAR transaction, call guard_transaction with the transaction and the owner's policy, and follow its decision:
"allow" = go ahead, "ask_human" = stop and ask the person you work for, "block" = do not sign, tell the person why.
Before paying or trusting an unknown account, token or link, call check_account. Before calling an unknown contract, call check_contract.
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
  block_on: z.array(z.enum(['block', 'warn', 'caution'])).optional().describe('Safe Near verdicts that block. Default: ["block"]'),
  ask_on: z.array(z.enum(['block', 'warn', 'caution'])).optional().describe('Safe Near verdicts that need a human. Default: ["warn"]'),
}).optional();
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const txBody = (a) => Object.fromEntries(['transaction', 'transactions', 'signer_id', 'transaction_base64', 'signed_transaction_base64', 'delegate_base64'].filter((k) => a[k] != null).map((k) => [k, a[k]]));
const reply = (text, data) => ({ content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
/** Every tool first refuses secrets, then turns any error into a readable tool error (never a crash). */
const guarded = (fn) => async (args) => {
  const secret = findSecret(args);
  if (secret) return fail(`Refused: the input contains ${secret}. Safe Near never needs a private key or a seed phrase. Treat it as leaked: move the funds to a new key.`);
  try { return await fn(args); } catch (e) { return fail(`Safe Near could not check this: ${e.message}`); }
};
const lines = (xs) => xs.map((x) => `- ${x}`).join('\n');

/** The MCP server with the Agent Guard tools, on top of `api` (localApi() or httpApi(): checkTx, inspect, contract, account). */
export function createAgentGuard(api) {
  const server = new McpServer({ name: 'safe-near', title: 'Safe Near Agent Guard', version: AGENT_GUARD_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool('guard_transaction', {
    title: 'Guard a transaction before signing',
    description: 'The one call to make before signing a NEAR transaction: Safe Near\'s transaction check plus the owner\'s policy (spending limits, allowed receivers and methods, forbidden actions). Answers allow, ask_human or block, with the reasons.',
    inputSchema: { ...TX_FIELDS, policy: POLICY, spent_near_today: z.number().nonnegative().optional().describe('NEAR this agent already spent today (for max_near_per_day)') },
    annotations: READ_ONLY,
  }, guarded(async (a) => {
    const body = txBody(a);
    const txs = transactionsOf(body); // throws a readable error on a malformed transaction
    const pol = policyViolations(txs, a.policy || {}, { spentToday: a.spent_near_today || 0 });
    const check = await api.checkTx(body);
    const d = decide(check, pol, a.policy || {});
    const actions = (check.transactions || []).flatMap((t) => (t.actions || []).map((x) => x.text)).filter(Boolean);
    return reply(`${d.decision.toUpperCase()}: ${d.message}${d.reasons.length ? `\nWhy:\n${lines(d.reasons)}` : ''}\nWhat it does:\n${lines(actions.length ? actions : ['(no readable actions)'])}\nSafe Near verdict: ${check.verdict}${check.summary ? ` (${check.summary})` : ''}`,
      { ...d, summary: check.summary || null, findings: check.findings || [], actions });
  }));

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
