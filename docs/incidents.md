# Hacks and incidents

Safe Near watches NEAR for hacks as they happen and rebuilds each one from the chain, the way an investigator does by hand. It is part of **Safety Check** (`/firewall`):
- Pasting an attack transaction, an attacker's account or an exploited contract shows the incident.
- Each investigation has its own page at `/firewall/<incident>`.

Code: `src/incident/` (`flows.js`, `trace.js`, `oneclick.js`, `prices.js`, `ai.js`, `detect.js`, `service.js`).

## What an investigation answers

| Question | How it is worked out |
|---|---|
| Who is the attacker? | The account the value went to: the signer of an attack transaction, unless the transaction paid someone else more. Its accounts are added around it: <br>• sub-accounts and token contracts it created; <br>• NEAR Intents accounts that withdrew to it; <br>• wallets the loot passed through; <br>• who created it and who first funded it (at least 0.1 NEAR, not a refund from a contract it called). |
| What was the target? | The contract that paid the attacker the most in USD, net of what the attacker paid it. Tokens the attacker deployed count as worth nothing. |
| How much was taken, from whom? | Per token, in USD at **today's** prices (Ref Finance's price list, Intear's for the rest). Every account whose value ended with the attacker is a victim. For a contract exploit, the losers are its users or liquidity providers; for a drainer, each wallet it emptied. |
| How did the attack work? | The attack transactions with their method calls and arguments, and the events the target logged while it was drained. The NEAR AI analyst reads them. |
| Where did the money go? | Hop by hop out of the attacker's accounts (up to two wallets deep, only moves of $50+). Endpoints: <br>• exchanges; <br>• bridges; <br>• NEAR Intents; <br>• **1Click** cross-chain swaps. A 1Click deposit address is an implicit account run by `bridge-mng.near`, and 1Click's public status names the destination chain, asset, recipient address and destination transaction. A refunded 1Click swap is shown as refunded, and 1Click's own refund accounts are listed apart and never flagged. |
| What can still be done? | What the attacker's NEAR accounts still hold, and which tokens an issuer can freeze (USDT: Tether's blacklist; USDC: Circle's). |

Money flows come from executed receipts only:
- NEAR `Transfer` actions (gas refunds left out);
- NEP-141 events and the older "Transfer N from A to B" log;
- NEP-171 NFT transfers;
- NEP-245 balances inside `intents.near`;
- dip4 withdrawals from it.

Failed receipts move nothing.

**Status:**
- **`confirmed`:** at least $1,000 taken, and the incident is a protocol exploit or a wallet drainer.
- **`suspected`:** something was taken, but less.
- **`nothing_found`:** nobody took value for nothing in return.

A confirmed incident:
- raises an `incident` alert;
- flags the attacker's accounts in `firewall_flags`:
  - **critical:** the attacker, its fake tokens and sub-accounts;
  - **high:** its NEAR Intents accounts and cash-out wallets;
  - **medium:** the funder.

So Safety Check, the transaction firewall and `GET /api/v1/account` warn about them.

## The NEAR AI analyst

The analyst (`NEAR_AI_ANALYSIS_MODEL`) gets a compact evidence packet. It writes the headline, the attack type, a summary, how it worked step by step, the impact, the money trail, what is still recoverable, recommendations and open questions.

Guardrails:
- **Untrusted data.** Call arguments, token names and memos are attacker-written, so they go through the untrusted-data guard.
- **Rules decide.** The rules decide every number, the status and the flags.
- **Numbers are checked.** Every dollar amount in the write-up is checked against the evidence (within 6 %, or a rounding to thousands). Anything else is listed as `unverified_amounts` on the page.
- **Budget.** Calls come out of the audit's daily budget (`AUTO_AUDIT_AI_PER_DAY`).

## Live detection

The deploy watcher already reads every block from neardata; the same blocks feed the detector (`scanBlocks`).

**What is watched.** Every flow out of a **DeFi protocol** is summed per receiver over 30 minutes. Protocols are:
- a built-in list (Veax, Ref, Rhea / Burrow, Meta Pool, LiNEAR, launchpads …);
- every contract the automated audit typed as an AMM, lending, liquid staking, order book, farm or bridge.

Routers (`wrap.near`, `intents.near`, aggregators) and protocol-to-protocol moves are left out.

**When it fires.** A receiver that took at least `INCIDENT_MIN_USD` ($5,000) from one protocol is a suspect when:
- its account is younger than `INCIDENT_FRESH_HOURS` (72 h); or
- it deployed contracts of its own in the last day (the fake-token pattern); or
- it pulled 3+ different tokens in at most 3 transactions, worth 3× the threshold; or
- it took more than `INCIDENT_ALWAYS_USD` ($250,000) whatever it looks like.

A suspect:
- raises a `drain_suspected` alert at once;
- is recorded in `incident_detections`;
- is queued for a full trace (`incident_queue`), which the worker runs one at a time beside its other work.

The watcher also writes `security:watch` (block reached, lag, last check), which the live feed shows.

## Worked example: Veax, 2026-10-31

The investigation started from one attack transaction (`BQkmuByxyoovFknaHCPjDFBWtXm3FkLSsNg6FS7e4vbV`); the trace took about a minute.

**How it was prepared:**
- **Attacker:** `realkingdom9695.near`. It was created through `meteor-relayer.near` at 03:15 UTC and funded with 31.8 NEAR by `e2f223…41a8e2`.
- **Setup:** at 04:01–04:02 it deployed six token contracts (`wa`/`wb`/`ua`/`ub`/`ta`/`tb.realkingdom9695.near`) and registered them on `veax.near`.

**The attack:** at 04:04–04:05, three transactions to `veax.near`. Each one:
- opened full-range positions pairing fake tokens with each other and with wNEAR;
- ran `swap_exact_out` through them into real tokens, with almost no input;
- withdrew the real tokens.

The NEAR AI analyst pointed at the target's own events. The wNEAR/fake pool held about 1 wNEAR, yet 11,889 wNEAR was paid out. That is likely a per-hop accounting flaw in chained swaps; the analyst marked it as inference, since the contract code is not in the evidence.

**Losses:** about $62.4k at today's prices. 11,889 wNEAR, 3.26M SHITZU, 336.7B BLACKDRAGON, 2,258 USDT and 1.59M PURGE; $4 came back.

**Where it went:**
- **To Ethereum:** 11,888 wNEAR and 2,255 USDT went through 1Click and became 23.68 ETH, sent to `0x938CEeAa9Ae1869E1379a6d1e9929474525A34A3`. Both destination transactions are known.
- **Refunded:** the SHITZU and BLACKDRAGON swaps were refunded (thin pools), so about $7.8k is still on the attacker's account.
- **Sold:** PURGE was sold on `aggregatedex.near`.
- **NEAR hops:** 377 NEAR hopped through three new implicit wallets.

**Detection:** replaying blocks 222,368,745–222,368,800, the attacker stands out at $62.8k in 5 tokens across 3 transactions; the next-largest receiver took $767. It would have been flagged within one watcher pass (about 15 s).

## Use it

- **Page:** paste into Safety Check:
  - an attack transaction or its NearBlocks / Pikespeak link;
  - an account;
  - `target:<contract>`, which reads up to 6,000 recent transactions of a contract and traces who it paid most.

  The answer offers "Investigate as a hack" on a transaction with a large payout, and "Look for hacks on this contract" on every contract.
- **CLI:** `node src/cli.js incident <account | tx hash | target:<contract>> [--no-ai]`.
- **API:** `GET /api/v1/incidents`, `GET /api/v1/incident?id=`. `GET /api/v1/inspect?q=` carries the `incidents` an input is linked to (see [tx-firewall.md](tx-firewall.md)).
- **Settings:** `INCIDENTS_ENABLED`, `INCIDENT_MIN_USD`, `INCIDENT_ALWAYS_USD`, `INCIDENT_FRESH_HOURS`.

## Limits

- **Prices:** USD values are at today's prices, not the incident's.
- **Trail depth:** the money trail follows two wallet hops and stops at other chains. Past an exchange deposit or a chain address, the exchange or that chain's explorer has to take over.
- **Contract scan:** `target:<contract>` reads up to 6,000 recent transactions. A very busy contract's window is cut, and the answer says so.
- **Drainers:** wallets drained through a stolen key are traced from the attacker's account. The live detector watches protocol outflows only.
