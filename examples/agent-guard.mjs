// A NEAR agent that asks Safe Near before it signs: the pattern for any agent written in code (a trading bot, an agent on NEAR AI, a
// LangChain / OpenAI Agents app). It connects to the Agent Guard over MCP, guards three transactions it would like to send, and prints
// what it would do. It never signs anything and needs no wallet.
//
//   npm install            (in this repository: @modelcontextprotocol/sdk)
//   node examples/agent-guard.mjs
//   SAFE_NEAR_MCP=http://127.0.0.1:8790/mcp node examples/agent-guard.mjs     (your own deployment)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.env.SAFE_NEAR_MCP || 'https://app.safe-near.org/mcp';
const NEAR = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString(); // NEAR -> yoctoNEAR
const AGENT = 'my-agent.near';

// what the agent's owner allows: at most 1 NEAR per transaction, 3 NEAR a day, only these receivers, never hand over the account
const POLICY = { max_near_per_tx: 1, max_near_per_day: 3, allowed_receivers: ['v2.ref-finance.near', 'wrap.near', 'efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af', 'alice.near'] };
let spentToday = 0;

const client = new Client({ name: 'example-near-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
console.log(`Connected to ${client.getServerVersion()?.title} at ${URL_}\n`);

/** Guard, then (in a real agent) sign only on "allow". Returns the decision. */
async function trySend(what, transaction) {
  const r = await client.callTool({ name: 'guard_transaction', arguments: { transaction, policy: POLICY, spent_near_today: spentToday } });
  const result = JSON.parse(r.content[1]?.text || '{}');
  console.log(`> ${what}\n  ${result.decision?.toUpperCase() || 'ERROR'}: ${result.message || r.content[0].text}`);
  for (const reason of result.reasons || []) console.log(`    - ${reason}`);
  if (result.decision === 'allow') { spentToday += result.near_total || 0; console.log('  (a real agent would sign and send it now)'); }
  if (result.decision === 'ask_human') console.log('  (a real agent would stop here and ask its owner)');
  console.log();
  return result.decision;
}

// the owner even put this account on the allowed list (someone asked to be paid there): Safe Near still knows what it is
await trySend('Pay 0.5 NEAR to an account someone asked us to pay', { signerId: AGENT, receiverId: 'efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af', actions: [{ type: 'Transfer', params: { deposit: NEAR(0.5) } }] });
await trySend('Wrap 0.5 NEAR to trade it', { signerId: AGENT, receiverId: 'wrap.near', actions: [{ type: 'FunctionCall', params: { methodName: 'near_deposit', args: {}, gas: '30000000000000', deposit: NEAR(0.5) } }] });
await trySend('Give a "support agent" full access to fix the wallet', { signerId: AGENT, receiverId: AGENT, actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:9eGvRzTYB1Hf6nPWkwq7YPU4Dx5K6TpGCmVBrSsWsfWJ', accessKey: { permission: 'FullAccess' } } }] });

// and the safer setup: a key that can only call one contract, for the owner to sign once
const plan = await client.callTool({ name: 'plan_scoped_key', arguments: { owner: AGENT, contract: 'v2.ref-finance.near', methods: ['swap'], public_key: 'ed25519:9eGvRzTYB1Hf6nPWkwq7YPU4Dx5K6TpGCmVBrSsWsfWJ' } });
console.log(`> Instead of a full-access key\n  ${plan.content[0].text.replace(/\n/g, '\n  ')}`);
await client.close();
