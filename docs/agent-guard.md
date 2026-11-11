# Safe Near Agent Guard

**Give an AI agent money on NEAR without giving it the keys to everything.** Before an agent signs a transaction, it asks Safe Near. The answer combines two checks:

- **Safe Near's transaction check** (the same one wallets use, [tx-firewall.md](tx-firewall.md)): is the receiver a hacker's account, a drainer, a look-alike of a known contract? Does the transaction hand over a full-access key, delete the account, or call a contract the automated audit rates High?
- **The owner's policy:** spending limits, which accounts and methods the agent may use, and which actions it may never take.

The answer is one of three decisions: **allow**, **ask_human** or **block**, with the reasons.

It runs as an **MCP server** (Model Context Protocol), so any agent that speaks MCP can use it: Claude, Codex, Cursor, or an agent written in code. It is read-only: Safe Near never holds a key and never signs. It refuses any input that contains a private key or a seed phrase.

- Remote (nothing to install): `https://app.safe-near.org/mcp` (Streamable HTTP, stateless)
- Local (stdio): `node src/agent/mcp-stdio.js` in this repository. It asks the public API of the hosted deployment, so it needs no database. `SAFE_NEAR_URL` points it at another deployment.

## The tools

Eight tools (Agent Guard 1.2.0). A client that connected before may need to reconnect to see new tools.

| Tool | What the agent asks | Answer |
|---|---|---|
| `guard_transaction` | "May I sign this?" Pass the transaction, the owner's `policy`, and optionally `spent_near_today` / `spent_usd_today` | `allow` / `ask_human` / `block`, the reasons, what each action does in plain words, and what it sends out (`sends`: token, amount, USD). A check that could not finish answers `ask_human`, never `allow`; a guard that fails says *do not sign* |
| `check_transaction` | The transaction check alone, without a policy | `ok` / `caution` / `warn` / `block`, the findings, and the actions in plain words |
| `check_account` | "Is it safe to pay or trust this?" Takes an account, token, NFT, contract, tx hash, link or website | `safe` / `caution` / `danger`, and any hack it is linked to |
| `check_contract` | "What can this contract's owner do to me?" | The automated audit: type, powers, who holds them, findings, and a level (low to critical) |
| `what_is` | "Is this payer really an exchange? A person?" | What Safe Near calls the account (person, exchange hot / cold wallet, NEAR Intents solver, relayer, router, launchpad, contract …), why, what weaker evidence it overruled, and its known links (operator, sweeps, cases) |
| `recent_hacks` | "What has been hacked on NEAR lately?" | The latest confirmed cases: kind, who was hit, how much was taken and is still held, the case id |
| `get_incident` | "Is this account / transaction part of a hack?" | The confirmed case it belongs to and its role (the attacker, a payout wallet, the target …), what was taken, where the money went. Unconfirmed suspicions are never shown as hacks |
| `plan_scoped_key` | "How do I act for my owner without their full-access key?" | The `AddKey` transaction for a **function-call key** limited to one contract and its methods, with a gas-only allowance (such a key can never send NEAR). The owner signs it once. Also returns the transaction that revokes it |

Transactions are accepted in every shape the firewall reads:
- wallet-selector `{ signerId, receiverId, actions: [{ type, params }] }`;
- near-api-js / RPC JSON;
- Borsh base64 (`transaction_base64`, `signed_transaction_base64`);
- NEP-366 meta transactions (`delegate_base64`).

### The policy

```json
{
  "max_near_per_tx": 1,
  "max_near_per_request": 2,
  "max_near_per_day": 5,
  "max_usd_per_tx": 50,
  "max_usd_per_day": 200,
  "allowed_receivers": ["wrap.near", "*.ref-finance.near"],
  "allowed_methods": ["near_deposit", "swap"],
  "forbidden_actions": ["add_full_access_key", "delete_account", "deploy_contract", "delete_key", "stake"],
  "block_on": ["block"],
  "ask_on": ["warn"]
}
```

- **Every field is optional.** By default nothing is limited, the five dangerous actions above are forbidden, a `block` verdict blocks, and a `warn` verdict asks a human.
- **Receivers:** `*.ref-finance.near` also matches the account's sub-accounts. A transaction on the agent's own account needs no allow-listing; what it does there (keys, code, deletion) falls under `forbidden_actions`.
- **What counts as spending:** everything the transactions send out, not only attached NEAR: NEAR attached or staked; **wNEAR** sent with `ft_transfer` (counted as NEAR for the NEAR limits); **any token** sent with `ft_transfer` / `ft_transfer_call`; and **NEAR Intents balances** moved with `ft_withdraw`, `mt_transfer` or `mt_batch_transfer`. The check values them in USD at today's prices (`value.moves` in the check), and the `max_usd_*` limits cap them. A token with no price under a USD limit answers `ask_human`: it is never waved through. Tokens sent to the agent's own account are not spending.
- **Daily limits:** the guard holds no state. The agent's runtime passes `spent_near_today` and `spent_usd_today` (what it already spent today) with each call, so `max_near_per_day` and `max_usd_per_day` can be enforced.
- **Fail closed:** a check whose lookups did not finish in time (`context.complete: false`) answers `ask_human`; if the guard cannot be reached or fails, the tool says *do NOT sign* and the server's instructions tell the agent to treat it as `ask_human`.

## Connect your agent

Remote: `https://app.safe-near.org/mcp` (Streamable HTTP). Local: `npm run mcp` (stdio; it asks the hosted API, no database needed).

### Claude Code

```bash
claude mcp add --transport http safe-near https://app.safe-near.org/mcp
```

Then ask, for example: *"Send 0.5 NEAR from my-agent.near to efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af"*. Claude calls `guard_transaction` and is told **block**: the account received the money drained from Binance's hot wallets.

**Claude Desktop:** Settings → Connectors → *Add custom connector*, with the URL `https://app.safe-near.org/mcp`. Or run it locally: add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{ "mcpServers": { "safe-near": { "command": "node", "args": ["/path/to/entity-tracker/src/agent/mcp-stdio.js"] } } }
```

### OpenAI Codex (CLI, IDE extension, ChatGPT desktop)

```bash
codex mcp add safe-near --url https://app.safe-near.org/mcp
```

or in `~/.codex/config.toml` (or a project's `.codex/config.toml`):

```toml
[mcp_servers.safe-near]
url = "https://app.safe-near.org/mcp"
```

Locally over stdio instead: `codex mcp add safe-near -- node /path/to/entity-tracker/src/agent/mcp-stdio.js`. Codex reads the server's instructions, which tell the agent to call `guard_transaction` before signing anything.

### An agent written in code

Any framework with an MCP client works the same way: connect, call `guard_transaction` before signing, and sign only on `allow`. [examples/agent-guard.mjs](../examples/agent-guard.mjs) is a complete agent in Node (`@modelcontextprotocol/sdk`). It guards three transactions it would like to send and prints what it would do. It never signs and needs no wallet:

```bash
npm install
npm run agent-example      # or: SAFE_NEAR_MCP=http://127.0.0.1:8790/mcp npm run agent-example
```

```
> Pay 0.5 NEAR to an account someone asked us to pay
  BLOCK: Blocked: do not sign this transaction.
    - critical: efd2242…: received the money drained from Binance's hot wallets on 2026-10-29 (~$45,669,049 taken)

> Wrap 0.5 NEAR to trade it
  ALLOW: Allowed: nothing in the check or the policy stops this transaction.

> Give a "support agent" full access to fix the wallet
  BLOCK: Blocked: do not sign this transaction.
    - policy: this adds a FULL ACCESS key (whoever holds it controls the account)
    - critical: Gives full control of your account
```

The core of it:

```js
const r = await client.callTool({ name: 'guard_transaction', arguments: { transaction, policy, spent_near_today } });
const { decision, reasons } = JSON.parse(r.content[1].text);   // content[0] is the same answer in words
if (decision === 'allow') await account.signAndSendTransaction(transaction);
else if (decision === 'ask_human') await askOwner(reasons);
else log('blocked', reasons);
```

## Limits

- **Rate limit:** shared with the transaction API, 300 requests per 10 minutes per IP. An `x-api-key` header from `FIREWALL_API_KEYS` lifts it, on the remote endpoint and for the stdio server (`SAFE_NEAR_API_KEY`).
- **Spending limits** count NEAR sent and NEAR attached to calls. Token amounts (`ft_transfer`) are not converted to NEAR. To limit tokens, allow only the receivers and methods the agent needs.
- **The guard advises; the agent's runtime enforces.** An agent that ignores the answer can still sign. That is why the strongest setup is a key from `plan_scoped_key`: even an agent that misbehaves can then only call one contract and never move NEAR.

Code: [src/agent/](../src/agent/) (`policy.js` for the policy and the scoped key, `mcp.js` for the tools, `api.js` for local or HTTP checks, `mcp-stdio.js`); tests: [test/agent.test.js](../test/agent.test.js).
