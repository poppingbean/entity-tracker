# Safe Near: security gate and defenses for NEAR

**The problem.** On NEAR, a user about to sign a transaction, send to a wallet or buy a new token cannot tell whether it is safe, and when an exchange or a protocol is drained, nobody can see where the money goes until it is gone.

**Safe Near** reads every NEAR block live, audits every new contract, catches large outflows within seconds, traces stolen money across chains, follows every new token from the moment it gets liquidity, and answers "is it safe?" for anything a user pastes: on a website, a Telegram bot, an API wallets call before signing, and MCP tools for AI agents. It is read-only: no wallet, no keys, no trading.

**Website (live, public, no login): <https://app.safe-near.org>** · **Telegram:** [@safenear_bot](https://t.me/safenear_bot) · **API:** `https://app.safe-near.org/api/v1/…` ([docs](docs/tx-firewall.md)) · **MCP:** `https://app.safe-near.org/mcp` · **License:** [MIT](LICENSE)

## Try it (5 minutes, on the hosted demo)

| Do | See |
|---|---|
| Open <https://app.safe-near.org/firewall> | **Safety Check**: one box, and beside it the **live feed**: "Watching NEAR live · block …", new contracts as they are audited, large transfers out of exchanges and protocols with their tags (*Large transfer → Normal* or *Watching*; *Hack* / *Exploited* / *Rugged* only with proof) |
| Paste `efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af` into the box | **Danger · Linked to a hack**: this account received a drain of three Binance hot wallets |
| Click **Full investigation →** (or open [the case](https://app.safe-near.org/firewall/inc%3Aefd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af)) | The case rebuilt from the chain: what was taken (about $46M at today's NEAR price; the figure moves with it), the hot wallets it came from, every hop of the money after, cross-chain swaps through NEAR Intents / 1Click with the destination chain and transaction, what is still held, NEAR AI's report and its deep review |
| On that page, press **Follow up** | What the accounts did since the last run (seconds), with a short NEAR AI note when money moved |
| Open <https://app.safe-near.org/tokens/fuk-3.smithii.near> | A memecoin the Binance attacker's wallets traded to launder money. It was made by a factory no launchpad list covers; Safe Near found it from its deploy and its first liquidity, with its creator and early buyers |
| Open <https://app.safe-near.org/audit/pets.kibble.near> | An automated contract audit: what kind of contract it is, the powers its code gives its owner (mint, freeze …), who holds them, each method's effects read from the WASM, NEAR AI's function review; tagged **High** |
| Run `curl "https://app.safe-near.org/api/v1/inspect?q=efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af"` | The same answer as JSON (`"verdict": "danger"`): what a wallet or an AI agent calls before it lets a user sign. `POST /api/v1/tx/check` checks a whole transaction ([docs/tx-firewall.md](docs/tx-firewall.md)) |
| In Telegram, send `/hacks` to [@safenear_bot](https://t.me/safenear_bot), then `/hack efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af` | The latest proven hacks, then this case with an evidence file to forward to whoever can act (an exchange, a bridge, SEAL 911) |
| Add the Agent Guard to Claude Code: `claude mcp add --transport http safe-near https://app.safe-near.org/mcp`, then ask *"Send 0.5 NEAR from my-agent.near to efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af"* | The agent calls `guard_transaction` and gets **BLOCK**: the receiver holds the Binance drain. Codex: `codex mcp add safe-near --url https://app.safe-near.org/mcp` ([docs/agent-guard.md](docs/agent-guard.md)) |
| Press `/` on any page and type `binance`, then `burrow`, then paste `efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af` | **One search over everything**: the Binance hot wallets and the drain case; the Rhea (Burrow) exploit and its lending contract; for a pasted account, **Is it safe?** first, then its wallet page and the case |
| Open <https://app.safe-near.org/entities/9c484fa5d2d069569ba063fc555c34e621ccd88fdbb0295fc79bad232621c5c1>, or run `curl "https://app.safe-near.org/api/v1/entity?id=solver-priv-liq.near"` | **What Safe Near calls it** (the ontology): *an exchange hot wallet · operated by Binance*, why (it sends its reserves to `binancecold3.near`), and its links. The API answers the same for any account; an agent asks with the `what_is` tool |
| Run `npm install && npm run agent-example` | An agent in code guards three transactions: a payment to the drain account (**BLOCK**), wrapping 0.5 NEAR (**ALLOW**), a full-access key for a "support agent" (**BLOCK**), then plans a function-call key limited to one contract instead |

## What it does

**Is it safe?**
- **Safety Check:** one box for anything a user pastes (a wallet, a token or its name, an NFT, a contract, a transaction, a link, a website, a transaction about to be signed) answers *safe*, *be careful* or *danger* in plain words, with the hacks it is linked to. The same answer is a public API (`GET /api/v1/inspect`).
- **Transaction firewall:** `POST /api/v1/tx/check` takes a transaction as a wallet holds it, right before signing, and returns `ok` / `caution` / `warn` / `block` with one plain line per action: drainers (a full-access key added, account deletion, code deployed on the wallet), look-alike contracts, approvals, rugged tokens, sending almost everything. Rules decide; the AI only explains. [docs/tx-firewall.md](docs/tx-firewall.md)
- **Agent Guard:** the same checks as MCP tools for AI agents. `guard_transaction` applies the owner's policy (spending limits, allowed receivers and methods, forbidden actions) and answers *allow*, *ask_human* or *block*; `plan_scoped_key` gives the agent a function-call key limited to one contract instead of full access. [docs/agent-guard.md](docs/agent-guard.md)

**Watching the chain**
- **Every new contract audited:** each deploy on NEAR is queued and classified (token, NFT, AMM, lending, DAO, bridge …); its code is decompiled to see what each method can really do; the powers it gives someone over users, and who holds them, are rated per contract type. NEAR AI explains what the rules cannot place. [docs/auto-audit-design.md](docs/auto-audit-design.md)
- **Every new token, from any factory:** a contract seen deployed becomes a tracked token the second liquidity is first added for it (Ref v2 or Ref DCL, against wNEAR or another valued quote); it must be a plain fungible token (NEP-141), never an NFT. Launchpads (nearly.trade, justhoot, meme.cooking …) are followed as well. [docs/token-tracking.md](docs/token-tracking.md)
- **Hacks caught live and traced:** money leaving a protocol for an account that looks like an attacker, or an exchange hot wallet emptied into a new account, is flagged within seconds and traced: the attacker's accounts, the target, losses at the time of the hack, and the money trail across chains through NEAR Intents / 1Click, budgeted by value. A hack is confirmed only by the rules' evidence or a person with a public report. [docs/incidents.md](docs/incidents.md)
- **Money watch (private):** every movement of $100k or more is followed until the rules or NEAR AI call it normal; people can report an address. [docs/money-watch-design.md](docs/money-watch-design.md)
- **Laundering rings:** memecoins bought almost only by wallets a confirmed case paid are found and proposed for the case, with the evidence.

**Who is behind the money**
- **Early buyers and linked wallets:** every tracked token's early buyers are traced to who really funded them, linked into groups by money only (shared funders, flows between wallets, creator funding), and judged by how their buys turned out, then by NEAR AI.
- **The scanner:** each new token gets a first check 130 s after its liquidity: hard gates, the tracker's memory of who the early buyers and the creator are, and an AI analyst, with a simulated wallet to measure it.
- **One answer for "what is this account?"** (the ontology): a person, an exchange hot or cold wallet, a NEAR Intents solver, a relayer, a contract … from the strongest evidence, with why. The hack tracer, wallet grouping and the firewall read the same answer, and modules write what they learn at once (a case's accounts, a token's creator). [docs/ontology-design.md](docs/ontology-design.md)

**Trust**
- **Warns in time:** alerts on rugs in progress, contract changes, large moves of anything watched, on the dashboard, the Telegram bot, an API and webhooks. [docs/alerts.md](docs/alerts.md)
- **Measures itself:** every gate, score and AI verdict is scored against what happened afterwards: hacks called and retracted, how fast real hacks were caught, the firewall's misses and false alarms, audit levels against outcomes, a golden set of known accounts, chain data against a second source. [docs/ai-and-accuracy.md](docs/ai-and-accuracy.md)
- **AI cannot be steered by chain data:** token names and memos are cleaned before any AI reads them, every AI text is checked against its evidence, and the AI can never make something look safer than the rules say.

## How it works

```
FastNEAR blocks (every block, live) ──► deploy watcher ──┬─► contract audits (every new contract)
                                                          ├─► first liquidity ──► tokens ──► trades ──► early buyers ──► groups ──► scanner
                                                          ├─► hack detector (protocol and exchange outflows) ──► incidents ──► money trail
                                                          └─► money watch ($100k+ movements)
FastNEAR indexer + RPC ──► account histories, funding chains, contract code and state
                       ontology (one answer per account, with why) ◄──► every module above
NEAR AI Cloud ──► write-ups and reviews (checked against their evidence)      MongoDB ──► web UI · API · Telegram · MCP
```

Rules decide every verdict; NEAR AI explains, reviews and can only add risk. Grave tags (*Hack*, *Exploited*, *Rugged*) need the rules' evidence or a public report.

## How it uses NEAR

- **The chain, live:** every block (FastNEAR neardata) and the FastNEAR RPC and transaction indexer; flows decoded from NEAR transfers, NEP-141 tokens, NEP-171 NFTs and NEP-245 multi-tokens.
- **NEAR Intents / 1Click:** the money trail follows intents withdrawals and 1Click deposit addresses through the 1Click status API to the destination chain, recipient and transaction.
- **NEAR AI Cloud:** every write-up (incident reports, deep reviews, follow-up notes, contract code and function reviews, analyses) comes from NEAR AI; prompts are in [src/ai/prompts/](src/ai/prompts/).
- **Function-call keys for agents:** `plan_scoped_key` gives an agent a key that can call one contract's methods with a gas-only allowance (it can never send NEAR), instead of its owner's full-access key.
- **Access keys and contract code:** audits read every account's keys and what each contract method can really do from its WASM (deploy code, add keys, delete the account, send NEAR).

## Built at NEAR HACKATHON

- **Window:** this repository was created on 2026-10-20, after the hackathon's announcement (2026-10-19); every commit is inside the window.
- **Carried over from our earlier work (baseline, Q-005):** the token/contract audit core was ported from our own earlier, pre-hackathon backend (`contractAuditService`, `nearContractAnalysis`, `nearRpcClient`: keys, privileged methods, sell checks; the "Keys, code and token checks" card and its risk/trust scores); the scanner's hard gates were ported from our live launch scanner; the token analyst prompt adapts our earlier hand-written analyst prompt.
- **Built in the window:** everything else: Safety Check, the transaction firewall and the Agent Guard; the live chain watch; automated audits of every new contract; tokens found from their deploy and first liquidity; hack detection, tracing, deep reviews and follow-ups; the money watch and the laundering-ring detector; wallet grouping and the scanner; the ontology layer; accuracy measurement and the grounding check on AI texts; the web UI, the Telegram bot, the API and the MCP server.
- **Libraries:** `mongodb`, `wabt` (WASM decompiling), `dotenv`, `@modelcontextprotocol/sdk` and `zod` (the Agent Guard). Written with the help of AI coding agents (Claude Code).
- **Tracks:** AI Security & Defense (`security`): scam and hack detection, a policy engine and spending limits for agents, function-call keys instead of full-access keys. Agent Economy (`agents`): the Agent Guard lets an agent hold and spend money on NEAR, checked before every payment.

## Run it yourself

Requires Node.js 20+, MongoDB, a NEAR AI key (<https://cloud.near.ai>; without one, verdicts are rule-based) and a FastNEAR API key (raises rate limits).

```bash
npm install
cp .env.example .env     # fill in MONGODB_URI, NEAR_AI_API_KEY, FASTNEAR_API_KEY
npm start                # worker + web UI on http://127.0.0.1:8790
npm test                 # unit tests, including real NEAR transactions stored as fixtures
```

`npm run web` serves the UI alone, `npm run worker` runs only the background loop, `npm run mcp` runs the Agent Guard locally (stdio, asks the hosted API). Deployment, operating notes and every setting: [docs/operations.md](docs/operations.md).

## Documentation

| Doc | What it covers |
|---|---|
| [docs/tx-firewall.md](docs/tx-firewall.md) | Safety Check and the transaction firewall API, for wallets and dApps |
| [docs/agent-guard.md](docs/agent-guard.md) | The MCP tools for AI agents, policies and scoped keys |
| [docs/auto-audit-design.md](docs/auto-audit-design.md) | Automated contract audits: types, powers, WASM effects, AI reviews |
| [docs/incidents.md](docs/incidents.md) | Hack detection and tracing, with worked examples (Veax, the Binance hot-wallet drain) |
| [docs/money-watch-design.md](docs/money-watch-design.md) | The money watch: every $100k+ movement, followed and reviewed |
| [docs/token-tracking.md](docs/token-tracking.md) | Tokens from deploys and launchpads, trades, early buyers, groups, the scanner, on-chain analysis, NFTs |
| [docs/ontology-design.md](docs/ontology-design.md) | The ontology layer: classes, facts, resolution, the migration |
| [docs/ai-and-accuracy.md](docs/ai-and-accuracy.md) | AI safety, the grounding check, measured accuracy, the audit checklist |
| [docs/alerts.md](docs/alerts.md) | Alerts, watchlists, the Telegram bot, webhooks |
| [docs/operations.md](docs/operations.md) | Setup, deployment, operating notes, the web UI, code layout, collections, configuration |
| [docs/accuracy-depth-plan.md](docs/accuracy-depth-plan.md), [docs/linking-findings.md](docs/linking-findings.md) | The accuracy and depth plan, and the wallet-linking measurements |
