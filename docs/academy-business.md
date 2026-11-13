# Safe Near Academy as an autonomous business

The [Safe Near Academy](academy-design.md) trains and tests AI agents. It also runs as a small business on its own. A person sets the rules in one file, [`academy-business.json`](../academy-business.json): prices, the revenue split, spending limits, and a kill switch. The agent does everything else:

| Step | What the agent does |
|---|---|
| **Sell** | Training and the exam stay free up to a daily cap. `academy_buy` sells a **training pass**, a **dataset pass** (each unlimited for 30 days), or an **exam certificate** (a certified exam result, public on the ledger) |
| **Get paid** | In NEAR or USDC on NEAR, or from any chain through **NEAR Intents**: a 1Click deposit address swaps what the buyer sends into exactly the order's USDC, paid to the treasury. Every order has a unique amount, so the payment is matched by its exact amount; no memo or account link is needed. The worker reads the treasury's transactions every minute and credits the buyer |
| **Spend** | Every NEAR AI call's tokens are counted per day and booked as a cost at the prices in the rules. The revenue's reserve share buys **extra AI calls** a day on top of the base budget (more revenue, more AI reviews of new contracts), worked out from what the reserve received minus what the AI cost |
| **Pay out** | Once a day the revenue is split (by default 50% to the AI reserve, 30% to contributors, 20% kept in the treasury). Each payout first passes **Safe Near's own Agent Guard**, then the agent proposes and approves it on the **treasury DAO** |
| **Show it** | Every sale, cost, payout, held payout and certificate is a row on the public ledger, with its transaction: <https://app.safe-near.org/academy/ledger> and `GET /api/v1/academy/ledger` |

## What is free, and what a certificate is for

**Practising and taking the exam are free.** What costs money is a *certificate*: a public, permanent record of an exam result. The order is:

1. **Practise** (free, 50 training tasks a day). After each task the agent sees the right answer and why.
2. **Take the exam** (`academy_exam`, **free**). The agent answers the fixed, hidden test tasks and sees its own score per level and overall. Anyone can take it, as often as they like, under new agent names.
3. **If the agent wants that score certified:** `academy_buy` with product `exam_certificate` ($1). It returns the exact amount to pay and where to send it.
4. **Pay that exact amount.** Within a minute or two the Academy sees the payment and credits one certificate to that agent.
5. **`academy_certify`.** The score is written to the [public ledger](https://app.safe-near.org/academy/ledger), with an id anyone can check.

So the payment comes *before* certifying, and what it buys is not the exam or the score. It buys the **public, checkable record** of the score.

**Why charge for that record:**
- **The value is in the record, not the score.** A score an agent reports about itself is just a claim. A certificate on a public ledger can be checked by anyone: "this agent took the fixed, hidden exam and scored 0.841, at this time". That is what a company can show a client, or what a marketplace can list next to an agent.
- **A free certificate would mean nothing.** Agent names are free, so free certificates could be printed by the thousand. $1 is small enough for any real user and enough to make a certificate worth something.
- **It pays for what makes the tasks.** Every day Safe Near spends NEAR AI calls auditing new contracts and reviewing launches. That work is what the tasks are built from.

The **training pass** ($3) lifts the 50-tasks-a-day cap for 30 days, and the **dataset pass** ($5) lifts the dataset export cap for 30 days. They are bought and paid for the same way.

Real example: on 12 November, `demo-auditor` took the memecoins exam for free, then paid $1 (transaction `9KfTs77eEQnrJ6cY5fp7mXHhvjzXc3RKQ7AAjg5mefzB`) and certified its score of 0.841. The certificate id is `cert:0e9bf0e130a2dd7f`.

## Who needs a certificate, and why

The exam tells an agent how good it is. A certificate tells **someone else**, without them having to take anyone's word for it. It is for third parties: clients, partners, marketplaces, and other agents.

| Who | What the certificate is for |
|---|---|
| **Teams selling an agent** (auditing, security, trading agents; B2B) | Proof of skill a client can check. A site can say "our agent scored 0.84 on the Safe Near Academy's contract security exam, certificate `cert:…`", and the client looks the id up on the public ledger: the score, the date and the score per level. |
| **Agents hiring other agents** (the agent economy) | An agent about to pay another agent to check a contract or a token can pick one with a strong certificate instead of picking blindly. It is a record of ability that a machine can read. |
| **Agent marketplaces** (for example the NEAR AI Agent Market) | A badge next to a listed agent: "certified on Safe Near's security exam", with the score. |
| **Model builders and researchers** | A fair comparison. Every agent takes the same hidden tasks, scored by the same fixed rules, so 0.84 and 0.71 mean the same thing for everyone. Scores can also be compared with Safe Near's own gates (0.735 on memecoins). |
| **Teams improving their agent** | A public history of versions. Certify v1, retrain, then certify v2 under a new name: the ledger shows whether the agent really got better. |
| **Wallets and users who let an agent move money** | A first check before trusting an agent with funds: has it shown, on a fixed exam, that it can tell a rug from a real launch, or find an open door in a contract? |

**Why the score can be trusted:**
- **Hidden tasks:** the exam's answers are never shown or exported, so they can't be memorised.
- **A fixed exam:** every agent gets the same tasks, so the scores compare.
- **Scored against facts:** the right answers come from deployed code, the chain and real price outcomes, never from another AI's opinion.
- **One answer per task:** the first answer counts, so a score can't be ground out by retrying.
- **Public and permanent:** the certificate is a row on the ledger with its time and the score per level.

**Limits in v1:**
- **The agent name is a label, not an identity.** A certificate says "the name `demo-auditor` scored 0.841". It does not prove that an agent running somewhere is that agent, or the same model.
- **The natural next steps** (not built):
  - bind a certificate to a **NEAR account**, with the agent signing its exam answers with its own key, so the certificate belongs to an identity on chain;
  - record the **model version** that took the exam.

  With both, a certificate becomes proof of ability tied to a real identity, usable for insurance, tenders, or as a condition for letting an agent hold money.

## How a payment is matched to the right agent

Many agents can buy at the same time, all paying into the same treasury, even from the same wallet. The Academy does not look at who paid. **It matches a payment to its order by the exact amount**, because every open order has an amount no other open order has.

**1. An order belongs to an agent.** `academy_buy(agent: "agent-A", product: "exam_certificate")` creates an order that records `agent-A`. It also gives the order a random number from 1 to 999 (`ref`) that no other open order of the last day uses.

**2. The number is added to the price, in the smallest unit of the currency:**

| Paid in | Smallest unit | The exact amount for a $1 order with `ref` 44 |
|---|---|---|
| USDC on NEAR | 0.000001 USDC (6 decimals) | $1 + 44 millionths: **1.000044 USDC** (raw `1000044`) |
| NEAR | 1 yoctoNEAR (24 decimals) | $1 at the current NEAR price, rounded up to 4 decimals, + 44 yocto. For example 0.2869 NEAR = **`286900000000000000000044`** yocto |
| Any chain, through NEAR Intents | the USDC that arrives | 1Click is asked for an *exact output*: it delivers exactly the order's USDC amount (`1000044`) to the treasury |

The extra is under a tenth of a cent, so the buyer barely notices it. For the Academy, it names the order.

**3. The payment is matched.** Every minute the worker reads the transactions into the treasury DAO:
- a NEAR transfer, from the transaction's receipts;
- a USDC transfer, from the USDC contract's `ft_transfer` events (a fake token's event is ignored).

It compares each **exact amount** with the open orders. When one matches, the order is marked paid, with the transaction, and the product is credited **to the agent named in that order**. A USDC memo naming the order (`SN-44`) also matches, as long as the payment is at least the price.

**An example: 5 agents take the exam, 3 buy a certificate**

| Agent | Takes the exam | Buys a certificate | `ref` | Pays exactly |
|---|---|---|---|---|
| agent-A | yes | yes | 44 | 1.000044 USDC |
| agent-B | yes | yes | 517 | 1.000517 USDC |
| agent-C | yes | yes | 266 | 0.2891 NEAR + 266 yocto |
| agent-D | yes | no | | |
| agent-E | yes | no | | |

Even if the three payments arrive in the same minute, from the same wallet, each amount matches exactly one order. agent-D and agent-E have their scores (`academy_exam`), but no certificate.

The two real sales on 12 November were matched this way: `…044` to `safe-near-demo`, and `…266` to `demo-auditor`.

**Edge cases:**

| Case | What happens |
|---|---|
| **The wrong amount** (even one smallest unit off) | It matches no order. It is still recorded on the ledger as revenue ("a payment that matches no open order"), but nothing is credited. Pay exactly the amount you were given. With USDC, a memo naming the order still matches if the payment is at least the price |
| **A late payment** | An order is open for 60 minutes (`order_minutes`). A payment up to 6 hours after that still matches; then the order expires |
| **One wallet paying for several agents** | Fine: the payer's account does not matter, only the amount |
| **Paying the same order twice** | The first payment pays the order. The second matches no open order and is recorded as unmatched revenue |
| **More than 999 open orders at once** | No free number is left: the agent is told to try again in a minute |
| **Checking an order** | `academy_order` shows its state (open, paid with the transaction, or expired), and for NEAR Intents the swap's state. One agent cannot see another agent's orders |

The agent name is a label, not an account (there is no sign-in in v1). Anyone who uses that name can use a certificate bought for it, but only to certify an exam that name has finished.

## Where the money goes

Once a day, at 01:00 UTC (`payout_hour_utc`), the agent closes the day by the rules in `academy-business.json`. A person sets those rules; the agent follows them.

1. **It books the AI cost.** The NEAR AI tokens used the day before are priced at the rules' rates and written as a `cost` row.
2. **It splits the revenue not paid out yet**, per currency:

   | Share | Default | What it is for |
   |---|---|---|
   | **AI reserve** (`reserve_account`) | 50% | Pays for NEAR AI. What is left after costs buys **extra AI calls a day**, on top of the base budget, for auditing new contracts: more audits make more and better tasks |
   | **Contributors** | 30%, split equally | People who give data: reports of hacks, labels. With no contributors set, this share stays in the treasury |
   | **Treasury** (the DAO) | the rest | Stays in `safe-near.sputnik-dao.near`, for running costs |

3. **It pays each share.** Every payout first passes Safe Near's own Agent Guard (per-payout and daily USD limits, payees from the rules only). Then the agent proposes and approves it on the DAO. A share under $0.05 stays in the treasury.
4. **It sets today's extra AI calls:** (what the reserve has received − all AI costs booked) ÷ the price of one call, capped at 200 a day.

**The first real close, 13 November 2026 at 01:00 UTC:**

| Row | Amount |
|---|---|
| Revenue (2 certificates) | $2.00 |
| AI cost booked for 12 November (49 NEAR AI calls) | $0.05 |
| Paid to the AI reserve, `safenear.near` (tx `79H7rZqYDtb4o5BjW2qc2jDF7qWGv2qyntLABQpCNfSS`) | $0.99 |
| Kept in the treasury DAO (no contributors set yet) | $0.99 |
| Left in the reserve after costs | $0.94: **200 extra AI calls** on 13 November (the daily cap) |

That is the closed loop: certificates pay for AI, the AI audits more contracts, and those audits become more tasks.

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
