# Safe Near Academy as an autonomous business

The [Safe Near Academy](academy-design.md) trains and tests AI agents. It also runs as a small business on its own. A person sets the rules in one file, [`academy-business.json`](../academy-business.json): prices, the revenue split, spending limits, and a kill switch. The agent does everything else:

| Step | What the agent does |
|---|---|
| **Sell** | Training and the exam stay free up to a daily cap. `academy_buy` sells a **training pass**, a **dataset pass** (each unlimited for 30 days), or an **exam certificate** (a certified exam result, public on the ledger) |
| **Get paid** | In NEAR or USDC on NEAR, or from any chain through **NEAR Intents**: a 1Click deposit address swaps what the buyer sends into exactly the order's USDC, paid to the treasury. Every order has a unique amount, so the payment is matched by its exact amount; no memo or account link is needed. The worker reads the treasury's transactions every minute and credits the buyer |
| **Spend** | Every NEAR AI call's tokens are counted per day and booked as a cost at the prices in the rules. The revenue's reserve share buys **extra AI calls** a day on top of the base budget (more revenue, more AI reviews of new contracts), worked out from what the reserve received minus what the AI cost |
| **Pay out** | Once a day the revenue is split (by default 50% to the AI reserve, 30% to contributors, 20% kept in the treasury). Each payout first passes **Safe Near's own Agent Guard**, then the agent proposes and approves it on the **treasury DAO** |
| **Show it** | Every sale, cost, payout, held payout and certificate is a row on the public ledger, with its transaction: <https://app.safe-near.org/academy/ledger> and `GET /api/v1/academy/ledger` |

## How the agent holds money without holding keys

- **The treasury is a Sputnik DAO.** The money sits there, never on the agent's account.
- **The agent has its own NEAR account**, which holds one **function-call key** that may call only the treasury DAO. A function-call key cannot attach a deposit, send NEAR, or add or remove keys. The signer refuses to sign if the key turns out to be a full-access key, or a key for another contract. The signer is `src/near/sign.js`: Node's own ed25519 and a small Borsh writer, tested by decoding what it signs with the firewall's own decoder.
- **In the DAO, the agent's account is the only member of a role** that may add and approve `transfer` proposals, with a proposal bond of 0 (a function-call key cannot pay a bond). So a payout is two calls: `add_proposal`, then `act_proposal` with `VoteApprove`.
- **Every payout must pass the Agent Guard first**, with this policy:

  | Rule | Value |
  |---|---|
  | Per payout | at most `max_usd_per_payout` |
  | Per day | at most `max_usd_per_day` |
  | Who may be paid | only the reserve account and the contributors in the rules |
  | Verdicts that block | `block` and `warn` |
  | Verdict that waits for a person | `caution` |

  The only finding it ignores is "the USDC contract is a high-risk contract": its issuer can freeze and upgrade it, and a person chose USDC as the currency. Any finding about the recipient still counts. For example, a payee that turns out to be a hack account is blocked as critical.
- **A payout the guard stops, or that fails, is a "held" row on the ledger.** The money stays in the DAO, and every daily close tries the payout again until it is paid.

## The kill switch

The business stops taking orders and paying out in any of these cases:
- `"paused": true` in the rules file;
- `node src/cli.js academy-business pause` (and `resume`);
- the DAO council removes the agent's role. This one works on chain, without Safe Near.

Payments already sent are still credited.

## Setting it up (once, by a person)

1. **Create the treasury DAO** on Sputnik (for example `safe-near-academy.sputnik-dao.near`):
   - your council as the owners;
   - `proposal_bond` set to `0`;
   - a role `academy-agent` with the agent's account as its only member, permissions `transfer:AddProposal` and `transfer:VoteApprove`, and a vote policy that one member approves.
2. **Create the agent's account** (for example `academy-agent.near`). Add one **function-call key** whose receiver is the DAO and whose methods are `add_proposal` and `act_proposal`, with a small gas allowance (0.25 NEAR). Put the agent's account in its own DAO role only. Never give it a full-access key that the server holds.
3. **Register the DAO on the USDC contract** (`storage_deposit`), so USDC can be paid to it.
4. **Choose the reserve account** (the account a person uses to top up NEAR AI credits) and the contributors.
5. **Set the environment on the server:**

   | Variable | What it holds |
   |---|---|
   | `ACADEMY_BUSINESS=true` | turns the business on |
   | `ACADEMY_TREASURY` | the DAO |
   | `ACADEMY_AGENT_ACCOUNT` | the agent's account |
   | `ACADEMY_AGENT_KEY` | `ed25519:…`, the function-call key's secret. **A secret: only in the server's environment, never in the repository** |
   | `ACADEMY_RESERVE_ACCOUNT` | the reserve account |
   | `ACADEMY_CONTRIBUTORS` | the contributor accounts, comma-separated |
   | `ACADEMY_ONECLICK_JWT` | optional: a 1Click partner token, for lower fees |

   Any of these can be set in `academy-business.json` instead, except the key.
6. **Check it:** `node src/cli.js academy-business` shows the rules and anything still missing.
7. **Run the demo:** `node src/cli.js academy-demo <agent>` runs one full loop in under two minutes. It opens an order, waits while you send the exact amount from any wallet, credits it, then runs a dry daily close that shows what would be paid out and the guard's answer for each payout.

## What a person still does

- **Tops up NEAR AI credits from the reserve account.** NEAR AI Cloud sells credits in its dashboard only, with no on-chain top-up we could find. The agent books every AI cost and decides how many extra AI calls the reserve pays for, but buying the credits is one manual step.
- **Watches held payouts.** The ledger shows why each one was stopped.

## Commands

| Command | What it does |
|---|---|
| `node src/cli.js academy-business` | The rules, the totals, and what is missing |
| `node src/cli.js academy-business scan` | Look for payments now |
| `node src/cli.js academy-business close --dry` | The daily close without changing anything: costs, the split, and the guard's answer per payout |
| `node src/cli.js academy-business close` | The daily close now |
| `node src/cli.js academy-business pause` / `resume` | The kill switch |
| `node src/cli.js academy-demo <agent> [product] [usdc\|near]` | One full loop |

## Checked before shipping

- **1Click.** The quote request as the Academy builds it was accepted by 1Click (a dry quote). An exact-output quote delivers exactly the order's unique USDC amount, which is how a 1Click payment is matched.
- **The Agent Guard on real payout transactions:**

  | Payout | Result |
  |---|---|
  | Over the per-payout limit | blocked |
  | Over the daily limit | blocked |
  | To a payee that is the Binance drain account | blocked as critical |
  | To an account not in the rules | refused |
  | A small payout in USDC | not blocked by USDC's own risk rating |

  The guard's lookups can run out of time. Then it waits for a person and tries again; it never pays on an incomplete check.
- **The signer.** A signed transaction decodes with the firewall's own decoder, and its signature verifies.
- **The tools end to end** (through an MCP client, with the business on in a test process):
  - the free tier stops at the cap, and the exam stays free;
  - each order gets its own exact amount;
  - one agent cannot see another's orders;
  - a certificate needs a finished exam and a bought certificate, and cannot be used twice;
  - a pass lifts the cap;
  - the kill switch stops sales.
