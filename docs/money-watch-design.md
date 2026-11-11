# Money watch: every large movement gets a case, and an AI reviewer decides when it is normal

Status: **built 2026-11-11** (see "As built" at the end for where the build differs from this design). Written 2026-11-11 from the request: *every transfer worth more than $100k, whatever the token, becomes a watch case; look back at where the money came from; follow where it goes; keep watching until the AI reviewer says it is normal; a person can report a hack by address.*

## 1. What exists today, and what is new

| Today | New |
|---|---|
| The detector (`detect.js`) fires only on money leaving a DeFi protocol or an exchange hot wallet, with an attacker signal (fresh account, fake tokens, many tokens). | Any movement of $100k or more, from anywhere, opens a **watch**. No attacker signal needed: the watch finds out. |
| Only accounts of a **confirmed** case are followed live (`followStolen`). | Every watched account is followed, until the reviewer calls it normal. |
| A deep review (`deepreview.js`) runs once, minutes after a finding. | The reviewer runs again whenever the picture changes (new moves, a person's report, a new on-chain link). |
| A confirmed hack comes from a public report or an operator. | A person's report by address is evidence for a re-review; the AI never confirms by itself (this rule stays). |

Reused as they are: the flow decoder (`flows.js`), valuation (`prices.js`, including the price at the time), pass-through accounts (the ontology's one rule), `ownFunds` (is this the account's own money), `followMoneyBestFirst` (the value-budgeted trail), the grounding check on AI texts (`grounded`), the ontology (`what_is`), `case-add`.

## 2. The trigger: one movement of $100k or more

A **movement** is one transaction's transfer, valued in USD whatever the token (`valueOf`, at the price of that moment). `WATCH_MIN_USD` = 100,000.

Not a movement (left out before any case is opened):
- pass-through accounts on either side (the ontology's `pass_through`: routers, relayers, the system), service accounts that move other people's money (Intents solvers, bridges), and protocol-to-protocol moves;
- mint and burn, NFTs;
- the legs of one swap: a transfer whose receiver sends back about the same value in the same transaction.

**Measured volume.** A read-only sample of 4,332 blocks (about 72 minutes of chain, spread over the last day; the feed rate-limited the other 5,668 requests) found 12 raw flows of $100k or more: 4 identical legs at $735k, 4 at $372k and the rest single. Most were solvers, the intents contract and bridges, which the filter above removes. A fair reading is **tens of watches per day, not thousands**. The sample is small: the first week runs in shadow mode (section 9) to get the real number before anything is alerted.

A watch is also opened when:
- a person reports an address (section 7);
- an account of an existing watch or case receives money from, or sends money to, an account not yet watched (section 5).

If the sending account is already inside an open watch, **no new watch is opened**: the movement joins that watch.

## 3. The case record

A new collection `watches`, separate from `incidents` on purpose: the Accuracy page scores `incidents` against hack truth, and thousands of ordinary large movements would swamp it. A watch becomes an incident only on **escalation** (section 6).

```
{ _id: 'w:<first tx hash>',
  status: 'watching' | 'normal' | 'suspicious' | 'confirmed',
  opened_ts, closed_ts, trigger: { tx, from, to, usd, token, ts },
  origin: { class, evidence },              // step 1
  watched: { <account>: { since, reason, state: 'active' | 'dropped', last_usd } },
  moves: [{ ts, tx, from, to, usd, token, partial }],
  reviews: [{ ts, trigger, verdict, confidence, reasons, by: 'rules' | 'ai' | 'human', cost }],
  status_history: [{ ts, status, by }],      // same shape as cases
  incident: null | 'inc:…' }
```

A `normal` watch stays stored and searchable. It is never deleted: if the money turns out to be stolen later, the history is there.

## 4. Step 1: look back (where did the money come from)

On opening, a rules pass classifies the **source** of the money and gathers evidence for the reviewer. Reuses `ownFunds` and the receiver's past with the payer (`deepreview.js` step 2).

| Origin class | How it is recognised | Leans |
|---|---|---|
| unstake or withdrawal from a staking pool | sender is a staking pool / liquid-staking contract, and the receiver deposited into it earlier | normal |
| farm or liquidity removal | sender is a farm or AMM, and the receiver added liquidity earlier | normal |
| exchange withdrawal | sender is a registry exchange hot wallet | normal, unless the receiver is new and the amount is unusual for that wallet (existing drain rule) |
| ordinary user | sender has a long history with the receiver, or both are old, active accounts | normal |
| unusual | receiver is fresh, sender never paid it before, many tokens in one go, no history | keep watching |

The rules give a first verdict and the facts; the AI reads them (section 6).

## 5. Step 2: follow the money forward

`W` is the set of watched accounts, starting with the receiver of the trigger movement.

For every movement out of an account in `W` worth at least `WATCH_FOLLOW_MIN_USD` (10,000, or 10 % of the trigger, whichever is larger):
- **the receiver joins `W`;**
- **partial send** (the sender still holds at least `WATCH_DUST_USD`, 1,000, or 5 % of what it received): the sender **stays** in `W`, so both are watched;
- **full send** (almost nothing left): the sender is marked `dropped` and no longer polled. Its history stays in the case.

Where a branch ends (recorded as an exit, not followed further): an exchange deposit address, a bridge or a 1Click swap out to another chain (chain, asset and recipient resolved as today), a DeFi protocol deposit (recorded as "parked in X"; a later withdrawal from it wakes the branch), and a pass-through account. Branches below the size floor stop as in the current trail.

Limits so a watch cannot grow without bound: `WATCH_MAX_ACCOUNTS` (40), `WATCH_MAX_DEPTH` (6), `WATCH_MAX_AGE_DAYS` (30 with no movement; a watch that has gone quiet is closed as `normal` with reason "idle", not deleted).

Implementation: the per-block hook that `followStolen` uses today, extended to read the set of watched accounts from an in-memory index (all `watches.watched` with state `active`), plus `followMoneyBestFirst` for the catch-up of a new branch.

## 6. The AI reviewer

**When it runs:** after step 1 (the first verdict); after each batch of new moves (at most one review per watch per hour, and only when at least $10k moved or a new exit appeared); on a person's report; when an on-chain link adds a new account. Nothing runs on a quiet watch.

**What it reads:** the trigger, the origin class and evidence, the `W` tree with balances, the moves and exits, the ontology's answer for each account (`what_is`), and any human report. Treated as untrusted data as the other prompts do (`UNTRUSTED_RULE`).

**What it returns:** `{ verdict: 'normal' | 'keep_watching' | 'suspicious', confidence, reasons[], what_to_check_next }`.
- `normal` (and not low confidence): the watch is closed as `normal`; monitoring of every account in it stops. The case is stored.
- `keep_watching`: nothing changes; the next trigger runs it again.
- `suspicious`: the watch is **escalated**: an incident is opened with `investigate` (the full trace, deep review and, when it confirms, the alerts and flags as today), and the watch links to it.

**Rules that do not change:**
- the AI never confirms a hack by itself; only a person or a public report does (existing rule);
- a case the rules found evidence for is never closed by the AI alone;
- every AI text is checked by the grounding check (WP-09): an account or number not in the evidence is flagged and, once, asked again.

**Cost.** Its own budget scope `watch` (`WATCH_AI_PER_DAY`, default 100) beside `audit` and `incident`, so watches cannot starve the hack investigations. A routine origin (a staking withdrawal by its depositor) is closed by **rules alone, no AI call**: the AI is for the unusual and the mixed. When the budget is spent, the rules' verdict stands and the watch stays `watching`.

## 7. People

- **Report by address.** A person gives an address (and optionally a link or a note).
  1. If the address is in a watch or an incident: the report is stored as evidence, `status` becomes `confirmed` for a hack report with a source (the existing human-confirmation rule), and the reviewer re-reviews with the report as the first item. A confirmed watch is promoted to an incident with `investigate`.
  2. If it is in no case: a **look-back** follows the address's funding over large movements, up to `WATCH_LINK_HOPS` (3). If the chain of money reaches an account of a watch or an incident, the address joins that case and the reviewer re-reviews with the link and the report.
  3. Otherwise a new watch is opened with trigger `reported` and step 1 runs.
- **Reverse link.** When a new movement's sender is already in `W` of an open watch, it joins that watch (section 2).
- **Operator tools.** `node src/cli.js watch-report <address> [--source <url>] [--note ...]`, `watch-close <id> <reason>`, `watch-list`. The existing `case-add` stays for adding accounts to a confirmed case.

## 8. Alerts, pages, and measuring it

- **Quiet by default.** A watch raises no alert and appears in no public list while `watching` or `normal`. Only `suspicious` (escalated) alerts, through the existing incident path. A watch is never called a hack in any text before a person or a report says so.
- **Page** "Money watch": open watches (amount, origin class, accounts watched, last move, last review), closed ones, and per watch the tree of accounts, moves, exits and the review log.
- **Accuracy.** Ground truth is the human report. Measured: how many watches the reviewer closed as `normal` were later reported as a hack (the number to keep at zero), how many escalated ones were confirmed, and the AI calls per day. The Accuracy page gets a block like the others, with its sample size.

## 9. Order of work (each step behind a switch, each measured before the next)

| Step | What | Gate to go on |
|---|---|---|
| 1. Shadow | Trigger, filters, `watches` collection, step 1 and the rules verdict. **No AI, no following, no alerts.** | A week of real volume: watches per day, share the rules close as normal, false triggers (swap legs, solvers) fixed. |
| 2. Reviewer | The AI verdict and the budget scope, still no following. | Reviewer verdicts read by a person on a sample (are `normal` calls right?); grounding clean. |
| 3. Follow | The watched set `W`, partial/full-send rule, exits, limits. | Per-watch size and the live-follow cost within budget. |
| 4. People | `watch-report`, the look-back, the reverse link, the promotion to an incident. | A test with a known past case (Binance, Rhea) reported by address. |
| 5. Page and accuracy | The Money watch page and the Accuracy block. | |

**Timing.** This is a design only. Changes are frozen 14 to 18/11/2026 (hackathon judging); build from about 20/11, step 1 first, in shadow.

## 10. Open decisions (the owner's call)

1. **$100k of what?** One transaction's movement (this design), or the sum an account moves in a window (for example several $40k transfers in an hour)? The second catches splitting but multiplies cases.
2. **Which accounts never open a watch?** The design drops pass-through accounts, protocols and swap legs. Should an exchange's own cold-to-hot moves, staking pools and known treasuries (DAO, foundation) also be silent?
3. **How long to watch.** 30 days idle, 40 accounts, 6 hops are first guesses.
4. **AI budget.** 100 calls per day for watches: enough? What may it cost per month?
5. **Wording and publication.** Watches stay private. Do `normal` ones ever show on the public site?
6. **Follow into DeFi.** "Parked in a protocol" ends a branch here; following the position inside the protocol is more work and probably not needed.

## 11. As built

Code in `src/watch/` (`rules.js` pure rules, `store.js` collection and index, `scan.js` the block scan, `review.js` the review lane, `report.js` people), the prompt `src/ai/prompts/watch-review.md`, the page `src/web/public/assets/js/pages/moneywatch.js`, CLI `watch-list`, `watch-show`, `watch-scan`, `watch-report`, `watch-confirm`, `watch-close`, `watch-review`. Tests: `test/watch-rules.test.js` (pure rules, the decision table, the look back); the block scan, the follow rule, the review and the reports were also run end to end on a scratch database.

Differences from the design:
- **Partial or full send** is judged from what the case itself tracked (what an account received from the case minus what it sent on), not from a balance read on the chain: it works for any token, and costs no RPC. An account that held its own money before the case may therefore look "fully sent" earlier than it is.
- **A suspicious watch keeps being followed and reviewed** (the incident opened from it follows only confirmed cases' accounts). The reviewer can still call it normal later, unless an incident from it is still open or a person gave a source.
- **Everything ships on, in one step**, not shadow-first: `WATCH_ENABLED=true`. Watches raise no alert; the first week's numbers (the Money watch page shows opened in 24 h and AI calls against the budget) say whether the rules need tightening. `WATCH_ENABLED=false` switches it off without a deploy of code.
- **No existing data is read, changed or backfilled.** The only new collection is `watches`; the only change to an existing one is the new `watch` AI budget counter in `meta`.
- **Not built:** "parked in a protocol" does not wake when the money later leaves the protocol (the branch ends there); a report with a link on an address found only by the look back does not confirm the case it was funded from (it asks for a re-review).
