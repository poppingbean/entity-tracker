# Accuracy and depth upgrade: execution plan

Status: plan, nothing built yet. Written 2026-11-10 against `main` at `a2be32e` (after PR #80).

This plan turns the evaluation "where can Safe Near get more accurate and go deeper" into work packages (WP) that an AI coding agent can execute one at a time. Each package says which model should run it:

- **Opus**: design decisions, anything that changes what users see as a verdict, anything that touches the tracer or the ontology's rules.
- **Sonnet**: mechanical work with a clear spec: fixtures, CLI wiring, UI cards, data files, tests.

One package = one branch = one pull request. Do not combine packages.

---

## 0. Rules for every executor

Read this section before any package. These rules come from how the repository already works.

### 0.1 Conventions

- **Language and layout.** Node.js 20+, ES modules, no TypeScript, no build step. Source in `src/`, tests in `test/`, docs in `docs/`. Match the surrounding style: dense single-line functions, a `//` header comment at the top of every file that says what the file does and why, JSDoc one-liners on exports.
- **No new dependencies** unless the package says so. Current ones: `mongodb`, `wabt`, `dotenv`, `@modelcontextprotocol/sdk`, `zod`.
- **Tests.** `node:test` + `node:assert/strict`. `npm test` runs an **explicit list of files** in `package.json`. A new test file is not run until it is added to that list. Add it.
- **Pure logic first.** Put decisions in pure functions (no DB, no network) and unit-test those. I/O wrappers stay thin. `src/accuracy/score.js` (pure) and `src/accuracy/run.js` (I/O) are the model.
- **Settings.** Every new threshold goes in `src/config.js` with an env name, and is documented in `.env.example` and in the README section it belongs to.
- **Collections.** MongoDB through `col('<name>')` from `src/db.js`. New indexes go in `src/db.js` beside the existing `ix(...)` calls.
- **CLI.** Commands are `else if (cmd === '...')` branches in `src/cli.js`, each listed in the comment block at the top of that file.

### 0.2 Product rules that must never be broken

1. **Read-only on chain.** No wallet, no keys, no transactions sent.
2. **The rules decide, the AI explains.** No AI output may make anything look safer than the rules say, and no AI output may flag an account by itself.
3. **Grave tags need proof.** *Hack*, *Exploited*, *Rugged* only with the rules' attacker signal or a public report. A measurement or an experiment in this plan must never raise a public alert or write a `firewall_flags` row.
4. **Public dashboard.** The site is public with no password. Never expose rule thresholds or gate conditions in an API response; `src/web/redact.js` strips them. Anything new that carries a threshold must be redacted the same way.
5. **Chain data is untrusted.** Token names, memos and metadata go through `src/ai/tools/untrusted.js` before any AI reads them.
6. **Ontology first.** "What is this account?" is asked of `src/ontology/` (`whatIs`, `classOf`, `passThrough`). Do not add a new hardcoded account list.

### 0.3 The sandbox has no chain access

An agent's sandbox usually cannot reach NEAR RPC, the FastNEAR indexer, 1Click, price APIs or the production database. So:

- Write code so its logic is testable with stored inputs.
- When a step needs live data, the package has an **Operator step**: an exact command for the owner to run where the network is reachable (their machine with `.env`, or the Railway shell), and what to send back.
- Never claim a live result you did not see. In the PR, list what was verified with real data and what was only verified with fixtures.

### 0.4 Definition of done (every package)

- `npm test` passes, with the package's new tests in the list.
- New settings are in `src/config.js`, `.env.example` and the README.
- The PR description has: why, what changed per file, how it was tested, what was **not** tested and why, and the rollback switch.
- No change in any public verdict unless the package says it changes one. If it does, the PR shows before/after on stored cases.

### 0.5 Prompt to start an executor

```
You are implementing work package <WP-ID> from docs/accuracy-depth-plan.md in poppingbean/entity-tracker.
Read section 0 of that file and the whole of your package first, then the files under "Read first".
Do only this package. Follow "Steps" in order, meet every line of "Acceptance", and stop.
If a step needs live chain or production data, do not guess: prepare the Operator step and report what you need.
```

---

## 1. Package overview

| ID | Package | Model | Size | Depends on | Changes a verdict? |
|---|---|---|---|---|---|
| WP-01 | Regression fixtures from real transactions | Sonnet | M | – | No |
| WP-02 | Ground truth for security verdicts | Opus | M | – | No |
| WP-03 | Accuracy of hack detection and cases | Opus | M | WP-02 | No |
| WP-04 | Accuracy of the firewall | Sonnet | S | WP-02 | No |
| WP-05 | Accuracy of contract audits | Sonnet | S | WP-02 | No |
| WP-06 | Accuracy page, API and CLI for the above | Sonnet | S | WP-03, 04, 05 | No |
| WP-07 | Golden set: 15 → 200+ accounts | Sonnet | M | – | No |
| WP-08 | Close the "busy account = exchange" gap | Opus | S | WP-07 | **Yes** (tracer) |
| WP-09 | AI write-ups: check every number and account | Sonnet | M | – | No (text only) |
| WP-10 | Prices at the time of the incident | Opus | M | WP-01 | **Yes** (USD figures) |
| WP-11 | Money trail by value budget, not fixed caps | Opus | L | WP-01, WP-03 | **Yes** (trails) |
| WP-12 | Ring detector on the same budget | Sonnet | S | WP-11 | No (proposals only) |
| WP-13 | Wallet linking: measure, then deepen | Opus | L | WP-02 | **Yes** (groups) |
| WP-14 | Cross-chain entities | Opus | L | WP-07 | No (new data) |
| WP-15 | Holders: complete candidate set | Sonnet | S | – | No |
| WP-16 | Data health: second source cross-check | Opus | M | – | No |

**Order.** Phase 1 = WP-01 to WP-09 (measure first). Phase 2 = WP-10 to WP-13 (go deeper, checked by Phase 1's numbers). Phase 3 = WP-14 to WP-16.
WP-01, WP-02, WP-07 and WP-09 have no dependencies and can run in parallel.

---

## Phase 1: measure

### WP-01 Regression fixtures from real transactions (Sonnet)

**Goal.** Parsers are tested against real NEAR transactions stored in the repository, so a log-format surprise fails `npm test` instead of production.

**Why.** Two production bugs were format surprises: the Ref v2 swap log ends in `, total fee N, admin fee N` (the old pattern captured `wrap.near,`), and BLACKDRAGON's pool was never found because discovery only knew Ref DCL. Today's tests build every transaction by hand, so they only cover shapes the author already imagined.

**Read first.** `src/near/indexer.js` (`decodeTx`), `src/collect/trades.js` (`tradesFromTxs`), `src/collect/launches.js` (`poolHit`, `checkTknPool`), `src/incident/flows.js` (`flowsOfReceipt`, `flowsOfTx`), `src/nft/decode.js` (`nftEventsOf`), `src/launchpads.js` (adapters' `parse`), `test/incident.test.js` (how receipts are hand-built today).

**Steps.**

1. **Fixture format.** One file per transaction: `test/fixtures/tx/<name>.json`:
   ```json
   {
     "name": "refv2-sell-blackdragon",
     "note": "A Ref v2 sell of BLACKDRAGON for wNEAR; the log ends in ', total fee …'",
     "hash": "<transaction hash>",
     "captured_ts": 1794300000000,
     "synthetic": false,
     "tx": { "...": "one element of the FastNEAR /v0/transactions `transactions` array, unchanged" }
   }
   ```
   `tx` is the raw indexer object, because `decodeTx(t)` and `flowsOfTx(t)` both take that shape.
2. **Capture command.** Add to `src/cli.js`: `node src/cli.js fixture-tx <hash> <name> [--note "<text>"] [--stdout]`.
   - Fetch with `txIndexer('/v0/transactions', { tx_hashes: [hash] })`.
   - Shrink deploys: in every `DeployContract` action (top level and inside receipts), replace a `code` longer than 2,000 characters with `"<omitted N chars>"`. Nothing else is changed.
   - Write `test/fixtures/tx/<name>.json`, or print it with `--stdout` (the Railway file system is not kept).
   - Put the shrink step in a pure exported function `shrinkTx(tx)` in a new `src/near/fixture.js` and unit-test it.
3. **Make trade parsing testable.** `tradesFromTxs(token, pool, txs)` calls `decimals()` and `quoteNearPrice()` (network). Split it:
   - New pure export `tradesFromDecoded(token, pool, txs, { dec, qDec, qPx })` holding today's loop unchanged.
   - `tradesFromTxs` becomes: read `dec`, `qDec`, `qPx` as today, then `return tradesFromDecoded(...)`. Behaviour must be identical.
4. **Loader.** `test/helpers/fixtures.js`: `loadTx(name)` returns `{ raw, decoded }` where `decoded = decodeTx(raw)`; `allTx()` lists every fixture.
5. **Tests.** New `test/fixtures.test.js`:
   - A generic test over `allTx()`: `decodeTx` does not throw, returns a hash, a signer, a numeric `ts` in milliseconds, and arrays for `calls`, `events`, `logs`.
   - One specific test per fixture with exact expected values (see the list below). Expected values are written in the test, not in the JSON.
6. **Until real fixtures exist**, create each fixture by hand from the shapes in the existing tests and mark it `"synthetic": true`. The generic test prints a warning line listing synthetic fixtures. A synthetic fixture is replaced, not kept, once the real one arrives.
7. Add `test/fixtures.test.js` to the `test` script in `package.json`. Document `fixture-tx` in the README's Tests bullet.

**Fixtures to capture (minimum set).**

| Name | What it must prove | Assertion |
|---|---|---|
| `refv2-sell-wnear` | Ref v2 sell, log with trailing `, total fee …` | `tradesFromDecoded` gives 1 trade, `buy: false`, NEAR > 0 |
| `refv2-buy-wnear` | Ref v2 buy | 1 trade, `buy: true` |
| `refv2-swap-msg-poolid` | `ft_transfer_call` message names a pool id | `poolHit` returns `{ dex: 'refv2', poolId: <id>, quote: 'wrap.near' }` |
| `dcl-swap` | Ref DCL swap event | 1 trade with the right trader (`swapper`, or the signer for an aggregator) |
| `dcl-swap-via-aggregator` | swap through `aggregatedex.near` / `dex.intear.near` | trader = transaction signer |
| `launch-nearlytrade` | launch event | `adapters.nearlytrade.parse` returns the token, creator and pool |
| `launch-justhoot` | launch event | same for `justhoot` |
| `launch-memecooking` | launch event | same for `memecooking` (pool id present) |
| `launch-tkn` | `create_token` on `tkn.near` | `adapters.tkn.parse` returns `<symbol>.tkn.near`, `awaitingPool: true` |
| `ft-transfer-wallet-to-wallet` | plain token transfer | `tradesFromDecoded` gives 0 trades and 1 transfer |
| `intents-native-withdraw` | NEAR Intents withdrawal | `flowsOfTx` has a flow with `kind: 'intents_out'` |
| `oneclick-deposit` | a transfer to a 1Click deposit address (64-hex) | `flowsOfTx` has the flow to that address |
| `near-transfer-large` | plain NEAR transfer from an exchange hot wallet | `flowsOfTx` gives one `near` flow with the exact raw amount |
| `failed-tx` | a failed transaction | `decodeTx(...).failed === true`, `flowsOfTx` gives no flow |
| `nft-transfer` | NEP-171 transfer | `nftEventsOf` returns the transfer |

**Operator step.** For each row, find a hash and run `node src/cli.js fixture-tx <hash> <name> --note "<what it is>"`, then commit the files. Where to find hashes:
- Trades: `db.trades.findOne({ token: '<token>', buy: false })` gives `hash` (pick a token whose `pool.dex` is `refv2`, then one with `dcl`).
- Launches: `db.tokens.findOne({ launchpad: 'justhoot' }).live_tx` (same for the others; BLACKDRAGON's is `AE5aC3wTe6jUiUMkXam5vzwCCTagYyLCSfbzuL1uiBAK`).
- Incident flows: any `tx` in `db.incidents.findOne({ _id: 'inc:efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af' }).trail.moves`, one with `swap` set for the 1Click row.

**Acceptance.**
- `npm test` passes and runs `test/fixtures.test.js`.
- `tradesFromTxs` output is unchanged for the same inputs (covered by an existing-behaviour test that calls both paths with fixed `dec` / `qPx`).
- Every row above has a fixture; the PR lists which are still synthetic.
- When a real fixture contradicts a parser, the parser is fixed in the same PR and the PR says which.

**Out of scope.** Recording RPC view calls; replaying whole investigations (WP-03 does case replays).

---

### WP-02 Ground truth for security verdicts (Opus)

**Goal.** One definition of "what really happened" for cases, live detections, flagged accounts and audited contracts, stored and derivable, that every accuracy number in WP-03 to WP-05 uses.

**Why.** Today ground truth exists only for token launches (price 24 h later, or a hand label). Hacks, firewall verdicts and audits have none, so nothing measures a false "$38.5M exchange drain" like the one on 2026-11-04.

**Read first.** `src/accuracy/feedback.js`, `src/accuracy/run.js`, `src/accuracy/score.js`, `src/incident/service.js` (`investigate`, `confirmIncident`, `unconfirmIncident`, `clearIncident`, the `tags` array), `src/incident/deepreview.js` (what a review writes: `result.tag`, how it clears a case), `src/incident/detect.js` (`incident_detections`, `verdict`, `review`), the `truth` and `feedback` commands in `src/cli.js`.

**Design to implement.**

1. **Kinds.** Extend `FEEDBACK_KINDS` in `src/accuracy/feedback.js` with `incident`, `detection`, `account`, `contract`. Labels stay `bad` / `good` (`bad` = the thing we try to catch really happened: it was a hack, the account is malicious, the contract harmed users).
2. **Status history.** A case's `status` is overwritten on every save, so past public calls are lost. In `src/incident/service.js`, append to a new array `status_history` on the incident whenever the status or its cause changes:
   `{ ts, status, kind, by }` with `by` one of `rules`, `report` (`confirmed_by`), `operator` (clear / unconfirm), `review` (deep review). Keep the last 30. Write it in `investigate` (compare with the previous document), `confirmIncident`, `unconfirmIncident`, `clearIncident`, and where the deep review changes a status.
   - Pure helper: `nextHistory(prevHistory, prevStatus, doc, by)` in a new `src/accuracy/truth.js`, unit-tested: no entry when nothing changed; an entry when the status changes; capped at 30.
3. **Derived labels** (computed, never stored; a stored hand label always wins). New pure function in `src/accuracy/truth.js`:
   `incidentTruth(inc, manual)` → `{ label: 'bad' | 'good' | null, source }` with this priority:
   1. `manual` (a `ground_truth` row of kind `incident`) → that label, source `manual`.
   2. `inc.confirmed_by?.source` is a link → `bad`, source `public_report`.
   3. `inc.confirmed_by` without a link → `bad`, source `operator_confirm`.
   4. `inc.status === 'cleared'` and `inc.cleared.by` is a person (not the deep review; read `deepreview.js` to see what it writes in `by`) → `good`, source `operator_clear`.
   5. `inc.status === 'cleared'` by the deep review, unchanged for 14 days → `good`, source `review_clear` (weaker; reported apart).
   6. Otherwise `null` (unknown: excluded from precision / recall, counted as "unlabelled").
   `detectionTruth(det, incidentTruthOfItsCase, manual)` → the case's label when the detection led to a case; `good` when `det.verdict` is `own_funds` or `safe` and 14 days passed with no case; else `null`.
   `accountTruth(account, roles, manual)` → `bad` when the account has role `attacker`, `accomplice`, `sub_account`, `intents_account` or `cash_out_wallet` in a case whose `incidentTruth` is `bad`; `good` when it is in the golden set with a class under `exchange`, `service`, `contract` or `system`; else `null`.
4. **Backfill of history.** One-off CLI `node src/cli.js truth-backfill [--dry]`: for every incident without `status_history`, build it from what is stored: `first_seen_ts` + current status, plus one entry per item in `tags` (`hack` → `confirmed`, `safe` → `cleared`, `review` → `suspected`, with the tag's `by`). `--dry` prints counts only.
5. **Hand labels for the new kinds.** The existing `truth` CLI command and `/api/feedback` accept the new kinds with no other change (verify, and extend their validation). The ⚑ "Wrong verdict" button is added to the case page and the audit page (`reportBtn(kind, id)` in `src/web/public/assets/js/pages/accuracy.js` is the existing helper).

**Tests.** New `test/truth.test.js`: every priority line of `incidentTruth`, `detectionTruth`, `accountTruth`, and `nextHistory`. Add to `package.json`.

**Acceptance.**
- No verdict, flag or alert changes: this package only records history and defines labels.
- `truth-backfill --dry` runs on production and prints how many cases get a history and how many end up labelled `bad`, `good` and unlabelled (**Operator step**; paste the output in the PR).
- The ⚑ button on a case page stores a `feedback` row of kind `incident`.

**Rollback.** None needed: additive fields, no reader depends on them yet.

---

### WP-03 Accuracy of hack detection and cases (Opus)

**Goal.** The Accuracy pass reports, for hacks: how often a public "Hack / Exploited" call was right, how many real hacks were caught, how fast, and how close the loss figure was.

**Read first.** WP-02's `src/accuracy/truth.js`, `src/accuracy/run.js` (`evaluateAccuracy`), `src/incident/service.js`, `src/incident/detect.js`, `docs/incidents.md` (tags and their meaning).

**Steps.**

1. New file `src/accuracy/security.js`, exporting `securityAccuracy()` (I/O) and pure helpers. `evaluateAccuracy()` in `run.js` calls it and stores the result under `out.security` in the same `meta` document.
2. **Cases** (`security.incidents`). Load every incident with `status_history`, compute `incidentTruth`. Report:
   - `called`: cases that were ever `confirmed` by `rules` (a public grave tag).
   - `precision`: of `called` with a label, the share labelled `bad`. Use `confusion()` from `score.js` with `flagged = ever confirmed by rules`, `bad = label === 'bad'`.
   - `retracted`: cases confirmed by rules and later cleared or unconfirmed, with the list of ids (at most 20) and the hours each stayed public.
   - `recall`: of cases labelled `bad`, the share confirmed by `rules` **before** any `report` / `operator` entry.
   - `time_to_detect`: for those, median and p90 of `first rules-confirmed ts − started_ts`, in minutes.
   - `found_later`: count of `bad` cases whose first confirmation came more than `config.incidents.alertMaxAgeDays` after `started_ts`.
   - `loss_ratio`: for cases with both `confirmed_by.loss_usd` and a traced figure, median of `traced / reported` and the share within ±25 %. The traced figure must be the tracer's own number: `applyConfirmation` overwrites `stolen_usd` with the reported loss, so store the tracer's value before that overwrite in a new field `traced_usd` (one line in `applyConfirmation`) and use it here.
   - `unlabelled`: count.
3. **Live detections** (`security.detections`). From `incident_detections`: `flagged = verdict in ('suspect', 'hack')`, truth from `detectionTruth`. Report `confusion()` and the count by `kind`.
4. **By kind.** Repeat `precision` / `recall` per `inc.kind` (`exchange_drain`, `protocol_exploit`, `wallet_drainer`, …) when a kind has 5+ labelled cases; otherwise print `n` only.
5. **Small samples.** Every block carries `n` and a `note` when `n < 20`: "few cases: read as a first sign, not a measurement" (the wording the AI block already uses).
6. **Case replay harness.** `src/ontology/replay.js` already replays stored cases under two rule sets. Add `node src/cli.js trace-replay [--limit N]`: re-trace each stored case with the current code (`traceIncident`, no AI, nothing saved) and print a diff of status, kind, `stolen_usd`, number of accounts and `exit_usd` per kind against the stored document. Reuse `diff` from `replay.js`. WP-08, WP-10 and WP-11 use it as their before/after check.

**Tests.** `test/security-accuracy.test.js` on hand-built incident documents: a retracted case lowers precision; a report-only case counts as a miss for recall; `time_to_detect` uses the first rules entry; small-sample notes appear. Add to `package.json`.

**Acceptance.**
- `node src/cli.js accuracy` prints a `security` block. **Operator step:** run it on production and paste the block in the PR.
- The 2026-11-04 false drain appears under `retracted` if its case is still stored (if it was deleted, say so).
- No public behaviour changes.

---

### WP-04 Accuracy of the firewall (Sonnet)

**Goal.** Two numbers for the firewall: how many known-bad accounts it blocks, and how many known-good accounts it warns about by mistake.

**Read first.** `src/firewall/rules.js` (`checkTransactions`, `lookalikeOf`, `VERDICT`), `src/firewall/context.js` (`buildContext`), `src/firewall/inspect.js` (`inspectAccount`), `test/firewall.test.js`.

**Steps.**

1. In `src/accuracy/security.js` add `firewallAccuracy()`.
2. **Known-bad set:** accounts with `accountTruth === 'bad'` (WP-02). **Known-good set:** the golden set (WP-07's file once it exists, else `GOLDEN`) plus the 200 entities with the highest `tx_count` whose ontology class is under `exchange`, `service` or `contract`.
3. For each account, build the same transaction a wallet would check: a transfer of 1 NEAR from `user.near` to the account, and a `ft_transfer` of a known token to it. Run `checkTransactions(txs, ctx)`.
   - `ctx` must come from the database only. Read `buildContext`: if it calls RPC, add an option `{ offline: true }` that skips those calls and uses stored data. Do not change its default behaviour.
4. Report `security.firewall`: `blocked_bad` (share of the bad set with verdict `block` or `warn`), `false_alarm_good` (share of the good set with a verdict above `ok`), and for each false alarm the account, the verdict and the finding key (at most 30 rows).
5. **Look-alike check.** Run `lookalikeOf(id)` over the known-good set: any hit is a false alarm of the look-alike rule; list them.

**Tests.** In `test/security-accuracy.test.js`: a flagged account counts as blocked; a trusted account with a look-alike name is reported as a false alarm.

**Acceptance.** The block appears in `accuracy` output; production numbers pasted in the PR (**Operator step**). No rule is changed in this package: false alarms found here become separate small PRs.

---

### WP-05 Accuracy of contract audits (Sonnet)

**Goal.** Does a "High" audit level predict harm? Report it with honest sample sizes.

**Read first.** `src/audit/auto.js` (`autoAudit`, the stored level), `src/audit/service.js`, `docs/auto-audit-design.md`, the `audit_risk` line in `src/accuracy/run.js`.

**Steps.**

1. `auditAccuracy()` in `src/accuracy/security.js`. Truth for a contract, in order: a hand label of kind `contract`; `bad` when the contract is a token with `outcome.rugged`, or is the `target.account` of a case labelled `bad`, or has a `firewall_flags` row of severity `critical`; `good` when it is at least 30 days old with none of those; else unknown.
2. Report `security.audits`: counts per level (`critical`, `high`, `medium`, `low`, `info`), the bad rate per level (`calibration`-style), and AUC with the level as the risk (`auc()` from `score.js`, levels mapped 4…0).
3. Report coverage: audited contracts with a label / all audited contracts.

**Tests.** Level-to-risk mapping and the truth order, on hand-built documents.

**Acceptance.** Block in the `accuracy` output with `n` per level and the small-sample note; production numbers in the PR (**Operator step**).

---

### WP-06 Accuracy page, API and CLI (Sonnet)

**Goal.** The public Accuracy page shows the security numbers beside the launch numbers.

**Read first.** `src/web/public/assets/js/pages/accuracy.js` (helpers `cm`, `rets`, `aucTxt`, `ratio`), the `/api/accuracy` route in `src/web/server.js`, `src/web/redact.js`.

**Steps.**

1. `/api/accuracy` already returns the whole `meta.accuracy` document, so `security` arrives with no route change. Check `redact.js`: the security block carries no thresholds; keep it that way (ids of retracted cases are public already).
2. On the page add a section "Security verdicts" with four cards:
   - **Hacks called**: precision, recall, the confusion table (`cm`), median time to detect, the retracted list as links to `/firewall/<id>`.
   - **Live detections**: the confusion table.
   - **Firewall**: blocked share of known-bad, false-alarm share of known-good, the false-alarm rows.
   - **Contract audits**: bad rate per level as a small table.
   Each card prints `n` and the small-sample note in the muted style used for the AI block.
3. A fifth card, **Classification** (filled by WP-07): golden-set size, how many pass.
4. README: extend the "Measures itself" bullet and the Accuracy paragraph with the new numbers and what counts as ground truth.

**Acceptance.** Page renders with a `security` block and without one (older `meta` documents). Checked in a browser against a stub API; screenshot in the PR.

---

### WP-07 Golden set: 15 → 200+ accounts (Sonnet)

**Goal.** A classification benchmark large enough to catch a regression in any class.

**Read first.** `src/ontology/golden.js`, `src/ontology/classes.js` (the class tree, `isA`), `src/ontology/known.js`, `docs/ontology-design.md` (sections 3 and 6), `test/ontology.test.js`, the `ontology-backfill --dry` command.

**Steps.**

1. Move the data to `src/ontology/golden.json`: an array of `{ account, expect, note, source }`. `source` says why this is certain: `operator`, `public` (with a link in `note`), `self_evident` (a system or well-known protocol account). `golden.js` loads it and keeps exporting `GOLDEN` in today's tuple shape so nothing else changes.
2. **Candidates command.** `node src/cli.js golden-candidates [--class <class>] [--limit 50]`: lists resolved entities from `ontology_entities` that are not in the golden set, strongest source first, with their class, `why` and conflicts, as JSON lines ready to paste. It writes nothing.
3. **Operator step.** Run it per class and confirm entries. Targets (minimum):

   | Class | Minimum |
   |---|---|
   | `exchange/hot_wallet` and `exchange/cold_wallet` (at least 5 different exchanges) | 30 |
   | `exchange/deposit` | 10 |
   | `service/intents_solver` | 15 |
   | `service/relayer`, `service/router`, `service/bridge` | 20 |
   | `service/launchpad`, `service/factory`, `service/treasury` | 15 |
   | `contract/*` (tokens, AMM, lending, DAO, staking) | 40 |
   | `person/wallet`, `person/smart_wallet`, `person/app_user` | 40 |
   | `system` | 5 |
   | **Hard negatives**: busy accounts that are *not* exchanges (solvers, bots, airdrop distributors, market makers) | 25 |

   Hard negatives matter most: they are what the 2026-11-04 mistake looked like.
4. **Report.** `checkGolden` stays. Add `goldenReport(ents)` → `{ n, ok, by_class: [{ class, n, ok }], failures: [...] }`, called by the accuracy pass and stored as `security.ontology`.
5. Validation test: every `expect` in the JSON is a class that exists in the tree; no duplicate accounts; every entry has a `source`.

**Acceptance.** 200+ entries; `ontology-backfill --dry` (**Operator step**) reports the pass count; any failure is either fixed in the data (wrong expectation) or opened as an issue (wrong classification) and listed in the PR. No classification rule changes in this package.

---

### WP-08 Close the "busy account = exchange" gap (Opus)

**Goal.** An account no source knows, and that is merely busy, is never called an exchange hot wallet.

**Why.** `docs/ontology-design.md` lists this as still open. In `src/incident/origin.js` `identify()`, an unknown non-contract account with 20,000+ transactions (or a grouping hub) becomes `Unnamed exchange hot wallet` unless the solver check fires. A payment from an "exchange" to a new account is what starts an exchange-drain case, so this fallback is the direct cause of a false drain.

**Read first.** `src/incident/origin.js` (`identify`, `sweepTarget`, `intentsSolver`), `src/incident/exchanges.js` (`refreshExchangeRegistry`, how a wallet enters the registry), `src/incident/detect.js` (`exchangeEvents`, who counts as a hot wallet live), `src/ontology/sync.js` (`confident`).

**Design.**

1. New neutral answer in `identify()`: `{ kind: 'wallet', name: 'Busy account (unidentified)', how: '<N> transactions', busy: true }`. It replaces the `Unnamed exchange hot wallet` branch. The branch with a proven sweep to an exchange-named account stays an exchange.
2. Consequences to check and handle, each with a test:
   - **Tracer endpoints.** A busy unidentified account is not an endpoint ("an exchange"): the trail keeps following it, under the existing caps. `docs/incidents.md` already says "An account known only as busy is still followed"; make the code match.
   - **Drain detection.** An outflow from a busy unidentified account cannot open an `exchange_drain` case. It may still be recorded as a *Large transfer* detection with tag *Watching*.
   - **Registry.** `refreshExchangeRegistry` must not add a wallet on busyness alone; it needs a sweep to an exchange-named cold wallet or a hand entry. Read how entries with no `cold` are created and stop creating them; existing ones are listed by a `--dry` run of the new rule and removed only after the operator confirms.
3. Behind a switch: `IDENTIFY_BUSY_NEUTRAL` (default `true`; `false` restores the old fallback without a deploy).
4. **Before/after.** Run `trace-replay` (WP-03) on stored cases with the switch off and on. The PR lists every case whose status, kind or loss figure changes, and why each change is right.

**Tests.** `identify` with a stubbed registry / ontology: busy + no sweep → neutral; busy + sweep → exchange; busy + intents activity → solver. Golden-set hard negatives (WP-07) all pass.

**Acceptance.** Replay diff reviewed by the operator before merge (**Operator step**). No case labelled `bad` in WP-02 loses its confirmation.

**Rollback.** `IDENTIFY_BUSY_NEUTRAL=false`.

---

### WP-09 AI write-ups: check every number and account (Sonnet)

**Goal.** Every AI text shown to users is checked against the evidence it was given: dollar amounts, token amounts and account names.

**Read first.** `src/ai/tools/verify.js` (`unverifiedAmounts`, `verifiedFindings`), `src/incident/ai.js` (how `unverified` is used today), `src/analysis/ai.js` (`clean`, `assessWithAi`), `src/evaluate/ai-review.js`, `src/nft/ai.js`, `src/incident/deepreview.js`, `src/incident/followup.js`, `test/incident.test.js` (existing `unverifiedAmounts` test).

**What exists.** Dollar amounts in incident reports are checked; audit findings must cite a real method or string. Nothing checks account names, and token analyses, group reviews, NFT reports, deep reviews and follow-up notes are not checked at all.

**Steps.**

1. In `verify.js` add pure functions:
   - `accountsIn(text)`: every NEAR account-like string: `name.near`, `name.tg`, sub-accounts, 64-hex implicit ids, and shortened ids in the form the prompts ask for (`first 8 hex + …`).
   - `unverifiedAccounts(output, evidence)`: accounts in the output that appear nowhere in `JSON.stringify(evidence)`; a shortened id matches any evidence id with that prefix.
   - `unverifiedNumbers(output, evidence, { minValue = 100 })`: generalise `unverifiedAmounts` to plain numbers with a unit (`N`, `NEAR`, `%`, `x`), same 6 % tolerance. Percentages match a fraction in the evidence (`0.05` ↔ `5%`).
   - `groundingReport(output, evidence)` → `{ ok, accounts: [...], amounts: [...] }`.
2. Apply it in every write-up path listed under "Read first". Policy, same everywhere:
   - If the report has unverified items, **retry once**, appending to the user message: "These are not in the evidence, remove or correct them: …". Check how `src/incident/ai.js` handles `unverified` today and keep its behaviour where it is stricter.
   - If the retry still has them, keep the text but store `ai.unverified = { accounts, amounts }`.
   - The UI shows a muted line under such a text: "Not found in the evidence: …" (one helper in `core.js`, used by each page).
3. Count it: each path increments counters in `meta.ai_grounding` (`{ path, checked, clean, retried, unverified }`, per day, 30 days kept). The accuracy pass copies the 30-day totals into `security.ai_grounding`.

**Tests.** `test/grounding.test.js`: an invented account is caught; a shortened id matches; `$1.2M` matches `1200000`; `5%` matches `0.05`; an account from the evidence passes. Add to `package.json`.

**Acceptance.** No AI text can change a verdict (unchanged). Every path listed stores `unverified` when it applies; shown on the page; counters appear in the accuracy output.

---

## Phase 2: go deeper (each step checked with Phase 1's numbers)

### WP-10 Prices at the time of the incident (Opus)

**Goal.** A case shows what was taken at the prices **when it happened**, with today's value beside it.

**Why.** `src/incident/prices.js` prices everything at today's rate; `docs/incidents.md` lists it under Limits. A case from April valued today can be off by a large factor, and WP-03's loss-accuracy number inherits that error.

**Read first.** `src/incident/prices.js`, every caller of `valueOf` / `usdPrice` (`grep -rn "valueOf(\|usdPrice(" src`), `src/collect/analyze.js` (`priceSeries`, `priceAt`), `src/near/quotes.js`.

**Design.**

1. New module `src/incident/pricehistory.js` with one entry point: `usdAt(token, ts)` → `{ usd, basis, at_ts }`. `basis` says how the price was found, tried in this order:
   1. `stable`: USDT / USDC ids → 1.
   2. `near_history`: NEAR and wNEAR from a stored hourly series (collection `price_history`, `_id: 'near|<hour>'`).
   3. `tracker_trades`: a token the tracker follows: `priceAt(priceSeries(trades), ts)` in NEAR × the NEAR price at `ts`.
   4. `implied`: the case's own swaps. When the attacker swapped the token for NEAR or a stablecoin within 24 h of `ts`, the swap's two legs give a price. Pure function `impliedPrices(flows)` over flows grouped by transaction.
   5. `today`: `usdPrice(token)`, as now.
2. **NEAR history source.** A public hourly series for NEAR/USD. Candidates: Binance klines (`/api/v3/klines?symbol=NEARUSDT&interval=1h`), CoinGecko `market_chart/range`. **Operator step:** confirm which one the production network can reach, and add the host to the allowlist. The fetcher is one small function behind `PRICE_HISTORY_URL`; the series is cached in `price_history` for good (past prices do not change). If neither is reachable, tier 2 is skipped and the code falls through.
3. `valueOf(token, raw, { ts } = {})`: with `ts`, use `usdAt`; without, unchanged. Returns `{ amount, usd, symbol, basis }`.
4. In the tracer, pass each flow's own `ts`. A case stores, beside every USD figure it stores now, the basis mix: `prices: { at: 'incident', bases: { near_history: n, implied: n, today: n }, today_usd: <same total at today's prices> }`. `prices_note` (existing field) is written from it.
5. UI and reports: "≈ $51M at the time (≈ $48M today)". When any part is `today`, say which share.
6. The AI evidence packet carries both totals, so the grounding check (WP-09) accepts either.

**Tests.** Tier order; `impliedPrices` on a fixture from WP-01; a missing series falls through to `today`; `valueOf` without `ts` unchanged.

**Acceptance.** `trace-replay` before/after on stored cases; the PR tabulates old and new `stolen_usd` per case. Thresholds that decide whether something is a case (`INCIDENT_MIN_USD` and the others) keep using **today's** price in live detection (a live event is "now" anyway); say so in `docs/incidents.md`.

**Rollback.** `PRICE_AT_INCIDENT=false` → `usdAt` returns tier 5 only.

---

### WP-11 Money trail by value budget, not fixed caps (Opus)

**Goal.** The tracer follows the money as far as the money justifies, and every case says how much of the loss it traced to an endpoint.

**Why.** `followMoney` in `src/incident/trace.js` is breadth-first with fixed caps: `depth = 2`, the 100 largest moves per hop (`HOP_MOVES`), the 10 richest wallets per hop, 300 transactions per wallet (`HOP_TXS`), 3 minutes (`FOLLOW_MS`). A $50M case and a $60k case get the same depth. Follow-ups go one hop.

**Read first.** All of `src/incident/trace.js`, `src/incident/followup.js`, `src/incident/oneclick.js` (rate limits and the breaker), `docs/incidents.md` ("Where a trail stops", Limits).

**Design.**

1. **Best-first search.** Replace the hop loop with a priority queue of wallets to expand, ordered by the USD that reached them. Expanding a wallet = today's inner block (read its transactions, keep its outgoing flows, classify destinations, look up 1Click swaps). `hop` stays on each move for display.
2. **Stop rules** (all in `config.incidents.trail`):
   - `floorUsd` (default 200, today's value): never expand below it.
   - `shareFloor` (default 0.005): never expand a wallet that received less than this share of the case's loss. For a $50M case that is $250k; for a $60k case, $300.
   - `maxWallets` (default 40; today's effective maximum is 20).
   - `maxDepth` (default 6).
   - `maxMs` (default 5 minutes; the worker's own timeout is `INCIDENT_INVESTIGATE_TIMEOUT_MINUTES` = 10, stay under it).
   - Endpoints are unchanged: a named exchange, a bridge, a NEAR Intents solver, another chain, a contract.
3. **Coverage.** The result gains `coverage: { stolen_usd, to_endpoints_usd, still_held_usd, untraced_usd, untraced_share, stopped: [{ account, usd, why }] }`, where `why` is the stop rule that ended that branch. `capped` (existing text field) is written from it.
   - Pure function `coverageOf(moves, exits, held, stolen)`, unit-tested.
4. **Follow-ups.** `followUpIncident` passes the same budget instead of depth 1, capped at `maxWallets: 10` and 60 seconds so it stays "seconds".
5. **Measure.** The accuracy pass (WP-03) adds `security.trail`: median `untraced_share` over confirmed cases, and the share of cases with `untraced_share < 0.2`.
6. **Before/after.** `trace-replay` on stored cases with `TRAIL_SEARCH=bfs` (old) and `best_first` (new): the PR tabulates per case the wallets followed, exits found, `untraced_share` and run time.

**Tests.** With a stubbed transaction source (inject `accountTxHashes` / `fetchTxs` through an options argument, defaulting to the real ones): a 5-hop chain is followed to its exchange; a branch under `shareFloor` is not expanded and appears in `stopped`; `maxWallets` holds; a loop terminates. Use WP-01 fixtures for flows.

**Acceptance.** No confirmed case loses an exit it had before. Run time per case stays under `maxMs`. 1Click lookups stay at 3 at a time.

**Rollback.** `TRAIL_SEARCH=bfs`.

---

### WP-12 Ring detector on the same budget (Sonnet)

**Goal.** The ring detector stops missing tokens because of a per-hop cap.

**Why.** `docs/incidents.md`: tested on the Binance case it found 2 of 6 tokens; "it misses the other four tokens, because their buyers fall outside the per-hop cap" (`RING.perHop = 40`, `hops = 3` in `src/incident/ring.js`).

**Steps.** Replace the fixed `perHop` selection in `scanCase` with the WP-11 ordering: expand the accounts that received the most first, up to a total budget (`RING.maxAccounts`, default 200) instead of 40 per hop. Keep every other rule (`minNear`, `minLinked`, `minShare`). It still only **proposes**.

**Tests.** Extend `test/ring.test.js`: a buyer that is the 60th largest receiver at hop 2 is now reached when the budget allows.

**Acceptance.** **Operator step:** `node src/cli.js` ring scan (dry) on the Binance case with the hand-added accounts removed, as in the documented test; the PR reports how many of the 6 tokens it finds now.

---

### WP-13 Wallet linking: measure, then deepen (Opus)

**Goal.** More true links between wallets of one owner without more false ones, proven with numbers.

**Why.** README "Known limits of the funding trace": about a third of early wallets are funded from an exchange hot wallet and only link through "hub twins". The trace reads the oldest 30 transactions for funders, the latest 60 for outflows (`FLOW_LOOKBACK_TXS`), and deep links go 1 hop (`DEEP_DEPTH`).

**This package starts with a written finding, not code.**

1. **Part A, measurement (no behaviour change).**
   - Build a **pair truth set**: wallet pairs known to be the same owner and pairs known not to be. Sources: accounts of one confirmed case with roles `sub_account` / `cash_out_wallet` (same owner); approved ring proposals and `case-add` plans (`member_of` facts with confidence ≥ 0.8); hand labels of kind `group`; negatives = pairs of golden-set `person` accounts from different known owners, and any two exchange customers linked only by the exchange.
   - `node src/cli.js link-eval`: for the current grouping, pairwise precision and recall on that set, and the share of early wallets that are in no group, split by funder kind (exchange, intents, relayer, wallet).
   - Deliver `docs/linking-findings.md`: the numbers, and which missing links each candidate signal below would have found.
2. **Part B, candidate signals**, each behind its own switch, each evaluated with `link-eval` before it is turned on:
   - **Exchange deposit address.** Two wallets that send to the same exchange *deposit* account (ontology class `exchange/deposit`, a per-customer address, not the hot wallet) belong to one exchange customer. This is the strongest untapped signal for exchange-funded wallets.
   - **Withdrawal twins, widened.** Today: the same odd amount from an exchange wallet within an hour. Add: consecutive withdrawals within N seconds to fresh wallets that then buy the same token within the entry window.
   - **Longer look-back.** `FLOW_LOOKBACK_TXS` 60 → 300 for wallets with fewer than 2,000 transactions.
   - **Deep links at 2 hops** through ordinary wallets only, keeping the "reached by more than 15 early wallets = a service" rule.
3. A signal ships only if pair precision does not fall and recall rises on the truth set. The PR for each signal shows the two numbers before and after, and how many groups merge.

**Acceptance.** Part A merged first as its own PR. Each Part B signal is a separate PR with `link-eval` output. Group verdict accuracy in the existing Accuracy pass does not get worse.

**Rollback.** Per-signal env switches; `npm run reprofile` + regroup restores the old groups.

---

## Phase 3: new data

### WP-14 Cross-chain entities (Opus)

**Goal.** An address on another chain that received money from a NEAR case is an entity Safe Near remembers, links and answers about.

**Why.** The tracer already learns the destination chain, recipient address and destination transaction of every 1Click swap and intents withdrawal (`exits[]` in `followMoney`). It stores them inside the case and nowhere else. `docs/ontology-design.md` lists "accounts on other chains" as open and already reserves ids like `eth:0x…`.

**Read first.** `docs/ontology-design.md` (fact shape, subjects), `src/ontology/index.js` (`invalid`, `factId`), `src/ontology/backfill.js` (`WRITERS`), `src/ontology/writers.js` (`syncFacts`), `src/incident/oneclick.js` (`assetChain`, the `CHAIN` map), `src/firewall/inspect.js` (`parseInput`).

**Design.**

1. **Ids.** `<chain>:<address>` with the chain keys of `CHAIN` in `oneclick.js` (`eth`, `btc`, `sol`, …), the address lower-cased for EVM chains and unchanged otherwise. Pure `chainId(chain, address)` and `parseChainId(id)` in a new `src/ontology/chains.js`.
2. **Facts.** Extend the `incidents` writer: for each exit with a `recipient`, assert
   `{ subject: 'inc:<case>', predicate: 'sent_to', object: '<chain>:<address>', source: 'trace', confidence: 0.9, evidence: 'swapped <amount> <symbol> to <asset> on <chain> (tx <hash>)', amount_usd, valid_from }`
   and `{ subject: '<chain>:<address>', predicate: 'role_in', object: 'inc:<case>', role: 'cash_out_address' }`.
   Check `invalid()` accepts the new subject form; extend it if needed, with tests.
3. **Shared destinations.** A chain address that received from two different cases links them. Report-only at first: `node src/cli.js chain-links` lists such addresses with the cases. It flags nothing (rule 0.2-3); it gives the operator a lead, the way ring proposals do.
4. **Answers.**
   - `parseInput` in `inspect.js` recognises a pasted `0x…` (40 hex), a Bitcoin or Solana address, or an explicit `eth:0x…`. `inspect` answers from the facts: "This Ethereum address received about $X from the <case> case on NEAR" with a link, verdict `danger` only when the case is confirmed, otherwise "nothing known" (never "safe").
   - `GET /api/v1/entity?id=eth:0x…` and the MCP `what_is` tool return the same.
   - The case page lists destination addresses with a link to their entity page.
5. **Out of scope.** Following the money on the other chain (needs per-chain explorers). The package ends at the first address on the other chain; say so on the page.

**Tests.** Id parsing; the writer emits the facts from a stored case document; `inspect` on a known destination address; an unknown address says nothing known.

**Acceptance.** **Operator step:** `ontology-backfill --dry` shows the new facts for the Binance and Rhea cases. Golden set gains 5 chain addresses from confirmed cases.

---

### WP-15 Holders: complete candidate set (Sonnet)

**Goal.** The "Largest holders" list stops missing wallets that got their tokens by transfer.

**Why.** `src/analysis/token.js` estimates holders from trades only ("misses transfers") and checks the 15 largest live (`HOLDERS_VERIFIED`). A wallet that received a large transfer and never traded is invisible, which is exactly the hidden-dump pattern the transfer trails look for.

**Steps.**

1. Candidates = traders ∪ every account in the token's stored `transfers` (both sides) ∪ the creator. Estimated balance = net trades + net transfers.
2. Check the 60 largest estimates live with `ftBalance`, in batches of 10 at a time. `HOLDERS_VERIFIED` becomes `config.analysis.holdersVerified` (default 60).
3. Each row gains `via: 'trades' | 'transfers' | 'both'`. The page shows it; a holder who never traded is marked "received by transfer".
4. **Optional, verify first.** FastNEAR may expose top holders per token (an `/v1/ft/<token>/top`-style endpoint). **Operator step:** check whether it exists and what it returns. If it does, use it as an extra candidate source behind `HOLDERS_FASTNEAR=true`; do not rely on it.
5. New risk note when a holder in the top 10 received its tokens only by transfer from the creator or an early buyer.

**Tests.** Candidate building and the `via` field on hand-built trades and transfers.

**Acceptance.** Page renders; the analysis for a token with transfers lists a transfer-only holder (mock data); live balances verified by the operator on one real token.

---

### WP-16 Data health: second source cross-check (Opus)

**Goal.** Know when the chain data itself is wrong or missing, instead of trusting one provider.

**Why.** Blocks, the transaction indexer and RPC all come through FastNEAR. A gap or a wrong record silently becomes a wrong verdict.

**Read first.** `src/near/rpc.js` (`rpc` already rotates over `NEAR_RPC_URLS`), `src/near/indexer.js`, the chain-watch loop (find it from `scanBlocks` in `src/incident/detect.js` and its caller), `src/worker.js`.

**Design.**

1. **Block continuity.** The live watch records the last block height it processed. Add a check: a jump of more than `DATA_GAP_BLOCKS` (default 5) between consecutive processed blocks is logged to `meta.data_health.gaps` (`{ from, to, ts }`, last 100) and the missing range is queued for a re-read. Skipped heights that the chain itself skipped are not gaps: confirm with an RPC `block` call before recording.
2. **Sampled cross-check.** Every `DATA_CHECK_EVERY_MINUTES` (default 60), take `DATA_CHECK_SAMPLE` (default 10) recent transactions the indexer returned and fetch each from RPC (`EXPERIMENTAL_tx_status`) through a **different** RPC host than FastNEAR's. Compare with a pure function `sameOutcome(indexerTx, rpcTx)`: same success or failure, same receipt count, same logs. Mismatches go to `meta.data_health.mismatches` (last 100).
3. **Surface it.** The Accuracy page gets a "Data health" card: gaps in the last 7 days, mismatches / checked, last check time. The existing status line turns amber when there is an unrepaired gap older than 10 minutes.
4. **No verdict depends on it** in this package. It alerts the operator (a private Telegram message to `RING_OPERATOR_CHAT_ID` if set) and nothing else.

**Tests.** `sameOutcome` on WP-01 fixtures (identical → true; a dropped log → false); gap detection on a sequence of heights.

**Acceptance.** **Operator step:** run for 24 h on production; the PR reports checks done, mismatches and gaps found.

---

## 2. What the operator needs to do

Agents cannot reach the chain or the database. These are all the hand steps, in order:

1. **WP-01:** run `fixture-tx` for the 15 rows and commit the files.
2. **WP-02:** run `truth-backfill --dry`, then without `--dry`.
3. **WP-03 to 05:** run `node src/cli.js accuracy` and paste the `security` block.
4. **WP-07:** confirm golden-set candidates class by class (about 200 accounts; the biggest hand task in the plan).
5. **WP-08:** review the replay diff before merging.
6. **WP-10:** say which price-history host production can reach.
7. **WP-12, 14, 15, 16:** one dry run each, as each package says.

## 3. Risks

| Risk | Where | Guard |
|---|---|---|
| Too few labelled cases for a meaningful rate | WP-03 to 05 | Every block prints `n` and a small-sample note; hand labels (⚑) grow the set |
| A deeper trail flags an innocent wallet | WP-11 | Endpoint and flag rules are unchanged; only confirmed cases flag; replay diff before merge |
| Removing the busy fallback hides a real exchange drain | WP-08 | Sweep-proven and registry wallets stay exchanges; outflows still show as *Large transfer*; env switch |
| Deeper linking merges unrelated wallets | WP-13 | Ships only when pair precision holds on the truth set |
| A price source is unreachable or rate-limited | WP-10 | Tiers fall through to today's price, and the basis is shown |
| Slower investigations | WP-11 | Time budget under the worker's timeout; measured in the replay |

## 4. How success is measured

At the end of Phase 1 the Accuracy page answers, with numbers:

- Of the hacks Safe Near called publicly, how many were right, and how long did a wrong one stay up?
- Of the hacks that really happened, how many did it catch by itself, and how fast?
- How often does the firewall warn about a known-good account?
- How many of 200+ known accounts does the ontology classify correctly?
- How often does an AI text contain something that is not in its evidence?

Phases 2 and 3 are judged by those same numbers moving in the right direction, plus two new ones: the share of each loss traced to an endpoint (WP-11) and pairwise link precision / recall (WP-13).
