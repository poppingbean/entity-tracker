# Hacks and incidents

Safe Near watches NEAR for hacks as they happen and rebuilds each one from the chain, the way an investigator does by hand. It is part of **Safety Check** (`/firewall`):
- Pasting an attack transaction, an attacker's account or an exploited contract shows the incident.
- Each investigation has its own page at `/firewall/<incident>`.

Code: `src/incident/` (`flows.js`, `trace.js`, `oneclick.js`, `prices.js`, `ai.js`, `detect.js`, `service.js`). NEAR AI prompts: `src/ai/prompts/incident-report.md` and `incident-deep-review.md`.

## What an investigation answers

| Question | How it is worked out |
|---|---|
| Who is the attacker? | The account the value went to: the signer of an attack transaction, unless the transaction paid someone else more. Its accounts are added around it: <br>• sub-accounts and token contracts it created; <br>• NEAR Intents accounts that withdrew to it; <br>• wallets the loot passed through; <br>• who created it and who first funded it (at least 0.1 NEAR, not a refund from a contract it called). |
| What was the target? | The contract that paid the attacker the most in USD, net of what the attacker paid it. Tokens the attacker deployed count as worth nothing. |
| How much was taken, from whom? | Per token, in USD at **today's** prices (Ref Finance's price list, Intear's for the rest). Every account whose value ended with the attacker is a victim. For a contract exploit, the losers are its users or liquidity providers; for a drainer, each wallet it emptied. |
| Where did the money come from? | Followed back from the pasted wallet, hop by hop (up to 3), through the wallets that sent most of its money. It stops at an exchange, a contract or an older wallet. Exchange hot wallets often have no NEAR name, so they are recognised by what they do: tens of thousands of transactions, the tracker's `hub` kind, and above all the exchange-named account they send their reserves to (a wallet that sweeps to `binancecold3.near` is a **Binance hot wallet**). |
| Was an exchange drained? | An exchange hot wallet that sent at least `INCIDENT_ALWAYS_USD` to an account created within `INCIDENT_FRESH_HOURS` (or by that very transfer) is an **exchange hot-wallet drain**. The exchange's wallets are the victims, never flagged. The account that received the money first is the attacker's root, and the investigation is re-rooted there, so every wallet it paid out to is followed. The pasted wallet shows as one of them, and an old link to it opens the re-rooted case. |
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

**Status.** Value received is never enough on its own: a whale withdrawing its own stake is the biggest outflow a protocol ever sees.

- **`confirmed`** needs at least $1,000 taken **and** an attacker signal:
  - **protocol exploit:** fake tokens used against the target, or an account that was new (`INCIDENT_FRESH_HOURS`) when it took the money;
  - **exchange drain:** exchange hot wallets emptied into a just-created account;
  - **wallet drainer:** at least 3 wallets emptied (each kept under 10 % of what it sent), plus a drainer's signing fingerprint: one key moving several victims' money, the attacker signing the moves itself (an approval), or an attacker account under 30 days old. Wallets sweeping into a fund or an OTC desk each sign with their own key and are not a drainer.
- **`suspected`:** value was received but there is no attacker signal. No flags, no hack alert.
- **`nothing_found`:** nobody took value for nothing in return.

NEAR attached to a call (`deposit_and_stake`, `near_deposit`) counts as paid in, so withdrawing what you deposited nets to zero. An exchange paying a customer is a withdrawal, not a loss. The money trail never follows into a contract: a deposit into a protocol is a destination, and a protocol is never flagged.

**Deep review.** Every finding (a drain report or a new case) gets a second, slower look `INCIDENT_REVIEW_DELAY_MINUTES` (3) after it was found. Investigations and deep reviews each start at most once a minute (`INCIDENT_EVERY_SECONDS`, 60; the chain watch that spots drains keeps reading blocks every 15 s), and one investigation gets `INCIDENT_INVESTIGATE_TIMEOUT_MINUTES` (10) before the worker moves on. NEAR AI has its own daily budget for the investigations and deep reviews (`INCIDENT_AI_PER_DAY`, 60), apart from the contract audits; a review NEAR AI could not answer (budget spent, outage) is tried again every hour, up to 6 times, and reads "waiting for NEAR AI" meanwhile. Findings are reviewed one at a time, in the order they were found (`deep_reviews`, `src/incident/deepreview.js`):
1. A follow-up of the trace (`src/incident/followup.js`: what the accounts did since; a full trace when new money came in or the case is from an older version): by then the money's path has settled.
2. The receiver's past with whoever paid it. Many earlier transfers from the same accounts, over months, mean a routine relationship (consolidation, treasury, OTC), not theft.
3. The own-funds check.
4. NEAR AI (`NEAR_AI_ANALYSIS_MODEL`) reads it all and answers hack / not a hack / unclear, with its confidence and reasons.

The tag then follows the verdict, and the page shows how it changed, e.g. **Large transfer → Normal**, **Large transfer → Watching**, **Large transfer → Hack**, or **Hack → Watching**:
- **Hack** (or **Exploited** for a protocol exploit, **Rugged** for a rug) needs the rules' attacker signal; NEAR AI never confirms one alone.
- A case the rules did not confirm is cleared (**Normal**) on a routine relationship, or on NEAR AI's "not a hack" with medium or high confidence. Its alerts are relabelled "Safe after review".
- A confirmed case that NEAR AI calls "not a hack" with high confidence goes back to **Watching**.
- A case that is not proven is never shown as a hack: it reads **Watching** until its review, and its page uses plain words (the receiving account, the accounts that paid it, the transfers), never attacker, victim or stolen.

Each case page has a Deep review card with the verdict, NEAR AI's reasons and the receiver's past with its payers. `node src/cli.js deep-review [--now]` runs the reviews by hand.

**Withdrawals of a wallet's own funds.** A whale unstaking from LiNEAR or taking its collateral out of Burrow is the biggest outflow a protocol ever sees, and looks just like a drain. The difference is in the wallet's past, so before anything is called a drain, Safe Near looks back through the transactions the wallet signed (oldest first, up to 4,000). It counts what the wallet paid into that same protocol at least a day before the withdrawal: NEAR attached to `deposit_and_stake` and similar calls, and tokens sent in. An exploit deposits and takes in one go, so same-day deposits don't count.

When those deposits are worth at least half of what came out (staking rewards and price moves account for the rest):
- it is a **withdrawal of its own funds**;
- it stays on the live feed and Explore as **Large transfer → Normal**, with the proof ("it put 3.13M NEAR into linear-protocol.near between 2023-06-11 and 2023-10-28");
- it raises no alert and starts no trace;
- the tracer never confirms it.

Past reports are checked by the worker, a few per pass, and by `node src/cli.js review-drains`; their alerts are relabelled.

**Re-traces keep flags in sync.** When an incident is re-traced or followed up, accounts no longer in the attacker's set lose its flag. An incident that is no longer confirmed loses all its flags, and its alert is marked "Retracted (not a hack)".

**Hand-added accounts survive a full re-trace.** A full trace rebuilds the account list from the chain. Accounts an analyst added by hand carry `added_by` (the writer, e.g. `trace/binance-hack-laundering-tokens`). These are carried over, with their role and their flag, unless the new trace finds them to be the target or a victim. If the trace finds such an account itself, the trace's role wins, and the account keeps its `added_by` mark. A case confirmed by a public report still gets the report's `accomplice` role for the accounts the report names. Revoking a confirmation is done by hand: `node src/cli.js unconfirm-incident <account> "<reason>"` (there is no button or API for it).

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

Pass-through accounts and protocol-to-protocol moves are left out. Pass-through is one rule from the [ontology](ontology-design.md), shared by the detector and both tracers: routers (`wrap.near`, `intents.near`, aggregators, `dex.intear.near`), relayers, the Aurora engine and the system accounts.

**When it fires.** A receiver that took at least `INCIDENT_MIN_USD` ($5,000) from one protocol is a suspect when:
- its account is younger than `INCIDENT_FRESH_HOURS` (72 h); or
- it deployed contracts of its own in the last day (the fake-token pattern); or
- it pulled 3+ different tokens in at most 3 transactions, worth 3× the threshold; or
- it took more than `INCIDENT_ALWAYS_USD` ($250,000) whatever it looks like.

**Exchange drains are watched too.** A transfer of at least `INCIDENT_ALWAYS_USD` out of an exchange hot wallet (the tracker's `hub` wallets) to an account at most `INCIDENT_FRESH_HOURS` old, or created by that transfer, is a suspect. Transfers to exchange-named accounts (an exchange's own cold wallets) are left out.

A suspect:
- raises a `drain_suspected` alert at once;
- is recorded in `incident_detections`;
- is queued for a full trace (`incident_queue`), which the worker runs one at a time beside its other work.

The watcher also writes `security:watch` (block reached, lag, last check), which the live feed shows.

## Money watch: every large movement

Beyond hacks: every movement worth $100k or more (whatever the token) opens a **watch**, a case that is followed until it is judged normal. See [money-watch-design.md](money-watch-design.md): where the money came from, where it goes (a partial send keeps both accounts watched, a full send drops the sender), an AI review with its own daily budget, and reports by address from people. A watch is private and is not an accusation; only a suspicious one opens an incident (the cases above).

## Early warning for crimes that are not on-chain hacks

Some thefts happen off-chain: an exchange's signing keys or withdrawal system is compromised, and the chain only sees the exchange's own wallets sending money, signed with their usual key. Nothing on-chain is broken, but the money movement is unmistakable. Four parts watch for it.

### 1. Exchange wallet watch (`src/incident/exchanges.js`)

- **Registry (`exchange_wallets`).** Most hot wallets have no NEAR name, so they are discovered by what they do:
  - start from the busy `hub` wallets the tracker meets while profiling buyers;
  - find the exchange-named account each one sends its reserves to (its cold wallet, which names the exchange);
  - add every other busy wallet that sends to the same cold wallet.

  It is refreshed daily (`EXCHANGE_REGISTRY_EVERY_HOURS`, `node src/cli.js exchanges`). Add one by hand with `node src/cli.js exchange-wallet <account> <exchange>`.
- **Baselines.** Per hot wallet, its customer withdrawals: the median and the large end (p98). Moves to its own cold wallets are left out, and p98 is used rather than the maximum, so a past drain in the sample does not make the next one look normal.
- **Live protocol rule.** A large outflow from a protocol is a suspect only with an attacker signal: a new account, its own fresh token contracts, or several tokens at once from an account under 30 days old. Size alone never is.
- **Drain rules.** An outflow worth at least `INCIDENT_EXCHANGE_MIN_USD` ($50k) to a non-exchange account is a suspect when:
  - the receiver is new (at most `INCIDENT_FRESH_HOURS`, or created by the transfer), and the amount is unusual: 5× the wallet's p98, or half or more of its balance; or
  - the receiver is new and the amount is above `INCIDENT_ALWAYS_USD`; or
  - two or more hot wallets paid the same account within an hour.
- **Key changes.** A full-access key added to or removed from a hot wallet raises `exchange_key_change`. Exchanges rotate keys, but an unexpected one is how a takeover starts.

On the Binance case, the three hot wallets' customer withdrawals have a p98 of 35k–87k NEAR; the drain transfers were 24–93× that and 100 % of each balance.

### 2. Live follow of stolen funds

Every account of a confirmed incident (the attacker, its sub-accounts and NEAR Intents accounts, the cash-out wallets) is watched block by block. A transfer of at least `INCIDENT_FOLLOW_MIN_USD` ($500) out of one:
- is recorded (`incident_moves`) and raises `stolen_funds_moved`. It is **high** severity when large or when the money had been idle for a day or more ("Stolen funds woke up after 3 days");
- if it goes to a 1Click deposit address, the swap is resolved right away (chain, asset, recipient);
- otherwise the receiver joins the incident, is flagged and is followed from then on;
- the incident is re-traced (at most hourly).

The investigation page lists these moves as they happen.

### 3. The blocklist feed

The parties who can still stop stolen money are the services that convert it: NEAR Intents / 1Click, bridges, exchanges, wallets. `GET /api/v1/flags?since=<ms>` gives every flagged account (synced incrementally, with an ETag), and `GET /api/v1/flags/check?ids=a,b` checks up to 100 accounts before a swap or withdrawal. High-severity alerts (drains, moves of stolen funds, confirmed hacks) also go to the public Telegram channel. See [tx-firewall.md](tx-firewall.md).

### 4. Off-chain signals (`src/incident/signals.js`)

- **On the bot.** `/hack <wallet | tx | link>` on @safenear_bot answers in the chat with what Safe Near knows about the case:
  - the summary, and the part the pasted wallet plays in it;
  - where the money came from and where it left NEAR (chains and addresses);
  - what is still on NEAR, wallet by wallet;
  - the latest move.

  It then attaches the evidence pack as a Markdown file, ready to forward to whoever can act: the victim, SEAL 911, NEAR Intents / 1Click, bridges, exchanges. The pack lists the sources with transactions, every attacker wallet with its holdings (the "please refuse" list), the cross-chain recipients with destination transactions, and how the source was identified.

  Only confirmed cases are shown. A wallet that was looked at and not confirmed gets "no hack is confirmed", never an accusation. An unknown wallet is investigated: ask again in a few minutes. `/hacks` lists the latest confirmed cases.
- **Reports.** `/report <account | tx> [what happened]` to @safenear_bot, or the form on Safety Check, starts an investigation and shows in the live feed. A report never flags anything by itself; flags come only from what the trace confirms.
- **News.** Public feeds (`NEWS_FEEDS`: Cointelegraph, The Block, Decrypt, rekt.news, CryptoSlate) are read every `NEWS_EVERY_MINUTES` (15). A story that mentions NEAR and a crime word raises `security_news`; any NEAR accounts or transaction hashes it names are investigated.

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

## Worked example: Binance hot wallets, 2026-10-29

The investigation started from `3f61f7…a2540f5`, a wallet reported as the hacker's. Its money came in three transfers (41,363 NEAR) from `efd224…ae5af`. That account was **created by** a transfer of 8.09M NEAR from a Binance hot wallet at 20:15 UTC on 2026-10-29. Within 7 minutes two more Binance hot wallets sent 2.20M and 2.12M NEAR: **12.41M NEAR in total, about $46M at the NEAR price of 2026-11-11** (the case values it at today's price, so the figure moves). All three are recognised as Binance's because they sweep their reserves to `binancecold3.near`, which they did two hours later.

The investigation is re-rooted at `efd224…`. From 2026-11-01 it paid out to five wallets (`3f61f7…`, `d06a8a…`, `2c9f5e…`, `6490b3…`, `b2e145…`). Through 1Click:
- about $120k was swapped to Bitcoin (`bc1qwwnfu5vvrw8p82q9qsydnk5jrsgmjarkqpxwzt`, `bc1qagexex37cu0mgc46wn8fj597rlmhsxue5vmll6`);
- $4.5k to Ethereum (`0xCAD8EC2fFF1579aB8dcA6B62BB8cf497c9B62459`).

$8.8k went through `omni.bridge.near`, and one wallet spreads NEAR over about 60 small wallets. One 1Click swap of 9,038 NEAR failed and is not counted as gone.

About **12.3M NEAR is still in `efd224…`**, plus ~66k NEAR in the payout wallets. Native NEAR cannot be frozen by an issuer.

Replaying the drain's blocks, the exchange-drain detector flags the first transfer ($33M to an account it creates) in the block it lands in.

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

- **Prices:** a case is valued at the prices **when the money moved**, with today's value beside it (`prices` on the case: how each price was found, and the same amounts at today's rates). In order: stablecoins at 1; NEAR from an hourly NEAR/USD history (Binance klines, `PRICE_HISTORY_URL`, cached for good in `price_history`); a token the tracker follows from its own trades; a token only the attacker traded, from the case's own swaps; otherwise today's price, and the page says which share. `PRICE_AT_INCIDENT=false` restores today's prices. Live detection (`INCIDENT_MIN_USD` and the other thresholds) keeps using today's prices: a live event is "now".
- **Trail depth:** the money trail is a best-first search: the wallet that received the most USD is followed first, and each branch stops by value, not by a fixed hop count: below `TRAIL_FLOOR_USD` ($200), below `TRAIL_SHARE_FLOOR` (0.5 %) of the case's loss, past `TRAIL_MAX_WALLETS` (40), `TRAIL_MAX_DEPTH` (6) or `TRAIL_MAX_MINUTES` (5). Every case says how much of the loss it traced (`coverage`: to an endpoint, still held, not traced) and which branches it did not follow and why (`stopped`). A follow-up uses 10 wallets and 60 seconds. `TRAIL_SEARCH=bfs` restores the old hop-by-hop search. It still stops at other chains: past an exchange deposit or a chain address, the exchange or that chain's explorer has to take over.
- **1Click lookups:** a rate limit or timeout is retried and never cached. A deposit address whose status still cannot be read, but whose money only went to `bridge-mng.near`, is listed as a 1Click service account, never flagged.
- **Contract scan:** `target:<contract>` reads up to 6,000 recent transactions. A very busy contract's window is cut, and the answer says so.
- **Drainers:** wallets drained through a stolen key are traced from the attacker's account. The live detector watches protocol outflows and exchange hot wallets, not ordinary wallets.
- **Busy accounts are not exchanges.** An account known only for being busy (20,000+ transactions: a market maker, a bot, an airdrop distributor) is never called an exchange hot wallet: the tracer calls it "Busy account (unidentified)", follows its money, and live drain detection ignores it. A registry entry needs a sweep to an exchange's cold wallet or a hand entry; `node src/cli.js exchanges-prune` lists (and with `--apply` removes) the entries that rest on being busy alone. `IDENTIFY_BUSY_NEUTRAL=false` restores the old fallback.
- **Exchange wallets:** the tracer asks the [ontology](ontology-design.md) first. A wallet in the exchange registry that sweeps to an exchange's cold wallet, a hand label, or an exchange name is an exchange, named after its operator ("Binance hot wallet"); a NEAR Intents solver is a service. Only an account the ontology knows nothing about falls back to the on-chain checks: busy enough (20,000+ transactions, or a grouping hub) and not a solver means an exchange hot wallet. It is named only if it sends its reserves to an exchange-named account; otherwise it reads "Unnamed exchange hot wallet".
- **Where a trail stops:** at a named exchange (the deposit), a bridge, a NEAR Intents solver (a swap) or another chain. An account known only as busy is still followed.

**Tags.** A finding starts plain and only ends grave with proof: **Large transfer** (found, being checked) → **Normal** (explained: routine, own funds) or **Watching** (checked, not explained yet) → **Hack**, **Exploited** (a protocol exploit) or **Rugged**, only for a case with the rules' attacker signal. Alerts read the same way ("Large transfer from an exchange hot wallet … (being checked)"). Moves of funds are shown and alerted only for proven cases; a case cleared later retracts its move alerts.

**Follow-ups instead of full re-runs.** A case traced before is not traced again from scratch: "Follow up" on the case page, a move of its funds (at most every 10 minutes per case), a new report on the same account and the deep review all run a follow-up (`src/incident/followup.js`). It reads only what the case's accounts did since the last look (up to 400 transactions each, 15 accounts), follows the new money one hop, refreshes what is still held, and adds it to the trail and the timeline; it takes seconds. The analyst report stays as it was; NEAR AI (the fast model, prompt `src/ai/prompts/incident-followup.md`) adds a short note (what is new, where the money is now, what can be done) only when at least `INCIDENT_FOLLOW_MIN_USD` moved. A full trace (and a new report) still runs when new money came **in** to the attacker's accounts (a possible new victim), on "Full re-trace", and once for a case traced by an older version (`INCIDENT_V`), so better rules reach old cases.

**Past hacks found later.** A hack Safe Near only learns about long after it happened (someone reports the account months later) is recorded as a past case: no alert and no Telegram post, not counted in the last 24 hours, shown with its real attack date and a "found later" mark. Its accounts are still flagged, and a new move of its money still alerts ("woke up after N days"). `INCIDENT_ALERT_MAX_AGE_DAYS` (7) sets how old is "past".

**Confirmed by public reports.** Some hacks cannot be proven from the chain alone: a key compromise, or a collector account traced on its own, whose master looks like a victim. `node src/cli.js confirm-incident <account> <source link | -> "<reason>" [--kind protocol_exploit] [--target <contract>] [--loss <usd>] [--accounts a,b,c]` confirms one with its source. The case stays confirmed through every re-trace, NEAR AI cannot clear it, the attacker's accounts named in the report are flagged and followed, and the page shows "Confirmed by public reports" with the link.

**NEAR Intents solvers are not exchanges.** A solver paying an account is how every 1Click / Intents swap delivers, so a busy account named `solver*`, or one whose transactions mostly settle through `intents.near`, is a service, never the exchange hot wallet of a drain. The accounts that paid into a case (its victims, its sources) are never followed as the attacker's.

## Laundering rings and `case-add`

**Ring detector** (`src/incident/ring.js`, worker). Every `RING_EVERY_MINUTES` (default 360; 0 turns it off), it scans one confirmed case, the one scanned longest ago. Only cases updated in the last 60 days are scanned, because a scan reads a few thousand transactions.

How a scan works:
- It follows the NEAR the case's accounts paid out after the hack, three hops deep. It keeps the 40 biggest receivers per hop, and exchanges, solvers and other hubs never count.
- It reads which tokens those wallets bought, and who else bought each one.
- It skips bridge and factory tokens, and tokens with more than 20,000 transactions.
- A token where at least 2 linked wallets make up at least 80% of the buyers is a ring.

It only **proposes**: a `ring_proposals` row, a log line, and a private message to `RING_OPERATOR_CHAT_ID` when that is set. It never raises a public alert and never flags anything. An unapproved suspicion must not name wallets in the public channel, and flags change what other people see. A re-scan updates an open proposal but never one that was approved or rejected.

```bash
node src/cli.js ring-scan [case id]          # scan now, store proposals
node src/cli.js ring-approve <id> --dry      # build what approving would write
node src/cli.js ring-approve <id>            # an operator applies it (case-add)
node src/cli.js ring-reject <id> "reason"
```

A proposal's plan:
- **The whole path from the case to each buyer** (attacker → hub → funder → buyer) becomes the case's `cash_out_wallet` accounts, flagged high, with each hop's `funded` edge as evidence. A buyer is never flagged without the payments that tie it to the hack.
- **The token's creator** is only **suspected**: an `accomplice` role with status `suspected`, confidence 0.6, "linked by trading, no traced payment". It is not flagged, and it is added to the scanner's creator blacklist. A creator the case paid directly is already on the path, so it is never also "suspected".

**Tested** on the Binance case with the hand-added accounts removed. It finds `olccl-4` and `mmli-6` with the right creators, and their full paths from the attacker. It misses the other four tokens, because their buyers fall outside the per-hop cap. For those, extend the plan by hand.

**`case-add`** is the one writer for an analyst's findings (the detector's approval uses it too):

```bash
node src/cli.js case-add <case id | account> plan.json [--dry]
```

`plan.json`: `name` (the writer `case-add/<name>` and the group `grp:<name>`; running a name again replaces its facts), `accounts` (`account`, `role`, `why`; roles `cash_out_wallet`, `sub_account`, `intents_account`, `funder`), `edges` (`[from, to]`; the amount, transaction and time are read from the chain), `suspected`, `members` (group only, confidence at most 0.8), `blacklist`. Only a confirmed case takes accounts. It writes the case accounts (marked `added_by`, so a full re-trace keeps them), the firewall flags, the `funded` / `member_of` / suspected `role_in` facts, and the blacklist, then runs the incidents and firewall_flags backfill writers.

## Measuring the verdicts

Every case keeps a `status_history` (`{ ts, status, kind, by }`, by = rules, report, operator or review), so a public call that was later retracted is not forgotten. The Accuracy page scores them against what really happened (a public report with a link, an operator's confirmation or clear, a deep review's clear that stood 14 days, a hand label from the ⚑ button): how often a *Hack / Exploited* call was right, how many real hacks the rules caught before any report and how fast, how close the traced loss was to the reported one, and the same for live detections. `node src/cli.js truth-backfill [--dry]` builds the history of cases stored before it existed. `node src/cli.js trace-replay [--limit N]` re-traces every stored case with the current code and diffs it against what is stored: the before / after check for any change to the tracer. Few cases are labelled yet, and every block says how many (`n`) and warns when that is small.
