# Safe Near (NEAR Entity Tracker)

An online sibling of the launch scanner. Instead of trading, it answers one question: **who buys NEAR launchpad tokens early, how are those wallets connected, and is each group good or bad money?**

- **Tracks every early investor** of tokens launched on nearly.trade, justhoot and meme.cooking (anyone who buys inside the first minutes after the pool opens).
- **Groups them by on-chain relationships:** shared funders up the funding chain, NEAR flowing between wallets or into a shared destination, near-simultaneous buying across several tokens, and funding by a token's creator.
- **Evaluates each group** from how its early buys actually turned out (ROI at 1 h / 6 h / 24 h, rug exposure, insider links, fresh-wallet and synchronised-buy patterns) with a rule score, then asks **NEAR AI** to judge it: good / bad / neutral, with reasons and red flags.
- **MongoDB is the main database.** It is **read-only on-chain**: no wallet, no private key, no trading anywhere in this project.

## How it works

```
launchpad contracts ──► tokens ──► trades (token contract history) ──► early entries + token outcome
                                                         │
early wallets ──► funding chain (who funded them, up to N hops) + recent outflows ──► edges
                                                         │
                          union-find grouping ──► group metrics + rule verdict ──► NEAR AI review ──► final verdict
```

| Step | What it does |
|---|---|
| Discover | Follows each launchpad contract (and `backfill` replays history). Re-reads a few minutes of blocks every poll, so a late-indexed launch is not lost. |
| Trades | Reads each token's own transaction history (oldest first) and keeps every DCL / Ref v2 swap with its NEAR value. |
| Early entries | A wallet is "early" when its first buy is inside `ENTRY_WINDOW_MINUTES` and among the first `ENTRY_MAX_BUYERS` buyers (buys under `MIN_ENTRY_NEAR` are ignored). ROI at a checkpoint = (NEAR already taken out + tokens still held × price then) / NEAR in − 1. |
| Full ledger | After a token's first 24 h are read (status `done`), the worker keeps reading its trades up to today: tokens already done catch up first (newest launch first, `LEDGER_ROWS_PER_PASS` transactions per pass), then a token that still trades is re-read every `LEDGER_ACTIVE_HOURS` (6 h), a quiet one (no trade for `LEDGER_QUIET_DAYS`) every `LEDGER_QUIET_HOURS` (24 h), and one with no trade for `LEDGER_STOP_DAYS` (14) is no longer followed. `tokens.ledger` holds today's price and multiple, the all-time high, the drawdown from it, all-time volume and whether it collapsed after day 1. Early buyers' **current** ROI and realized / unrealized profit follow the latest price. Verdicts, tags and group scores still judge the 1 h / 6 h / 24 h checkpoints, so groups stay comparable. **Sync now** on a token page reads its whole history at once; `node src/cli.js ledger [token]` does it from the command line. `LEDGER_ENABLED=false` turns it off. |
| Outcome | Price at 1 h / 6 h / 24 h, peak, drawdown, creator buys / sells, and the **rug flag**. A token is rugged when its price fell `RUG_DRAWDOWN` (90 %) from the peak (*price crash*), when it fell `SOFT_RUG_DRAWDOWN` (70 %) while the creator sold 1+ NEAR (*creator dump*), when it pumped to `ROUND_TRIP_PEAK` (3x) its launch price and is back at or below `ROUND_TRIP_BACK` (1.25x) of it (*round trip*), when the creator sold `CREATOR_EXIT_SHARE` (80%) of their dev buy within the first hour and the price is now below its launch price (*creator exit*), when the creator took (almost) their whole dev buy out within the first hour and the token is at most `CREATOR_EXIT_BACK` (1.5x) its launch price (*creator exit*), when the creator sold any of the token at all, above `CREATOR_SELL_RUG_NEAR` (0) NEAR (*creator sold*: every creator sale is a dump, in the first 24 h or later, when the full ledger finds it), or when the creator is on the dev-rug blacklist (*flagged*: the scanner's blacklist, imported with `import-scanner`, and every creator this tracker's simulated wallet catches dumping). `outcome.rug_kinds` says which; flagged tokens also carry `rug.reason`. `node src/cli.js rugs` flags and re-applies the rules to every stored token. |
| Profile | For each early wallet: who **really** funded it, the funder's own funder up to `FUNDING_DEPTH` hops, kind of every account (exchange/hub, relayer, intents, protocol, ordinary wallet), and where it sent NEAR recently. Wallets created by a relayer (meteor, Intear, HERE) all share the relayer as creator, which proves nothing, so the tracker reads the oldest 30 transactions, collects every NEAR inflow (including contract-originated ones and NEAR Intents `native_withdraw` events, which name the intents account that ordered the withdrawal), drops gas top-ups and takes the earliest sender of at least 1 NEAR as the funder (other large senders are kept as extra funders). |
| Group | Wallets are linked through non-generic funders, flows between members or into a shared destination (at least 2 NEAR each), repeated co-buying, creator funding, "hub twins" (an exchange wallet paying two wallets the same odd amount within an hour) and **deep links**. Exchanges, relayers, intents and "distributor" wallets that fund dozens of unrelated buyers link nothing. |
| Network | Deep links follow funding and money flow up to `DEEP_DEPTH` (3) hops from every early wallet, only through ordinary wallets (never an exchange, relayer, hot wallet or an account touching more than 30 wallets), and link two early wallets when both reach the same account (an account reached by more than 15 early wallets is a service and links nothing). To see those hops the worker profiles the **linked wallets around each group** (`NETWORK_EXPAND_BATCH` per cycle, nearest hop and biggest group first, capped at `NETWORK_MAX_NODES`), then regroups, so when a group's network grows the new linked wallets are picked up on the next pass. Each group stores its network (wallet, hops, kind, launch tokens it traded itself). `node src/cli.js expand [batches]` does it by hand. |
| Creator network | Every token creator gets the same funding trace as an early wallet (newest launch first, a few per worker cycle; `node src/cli.js creators` traces them all): its funders, the first funder's chain up to `FUNDING_DEPTH` hops, and where it sends NEAR (2+ N). Two creators are **tied** when one funded or paid the other, or they share an ordinary-wallet funder or cash-out wallet; exchanges, relayers, NEAR Intents and distributors (an account tied to more than 30 creators) link nothing. The creator page shows the network (tied creators, how, and their launches and rugs), who funded the creator and where its NEAR went; the token page shows who is behind its creator; every funder entity shows the token creators it funded and how many rugged (sort *Funders & entities* by *rugging creators funded*). The scanner gives the network to the AI analyst, takes 3 points per token rugged by a tied creator off the rule score (up to 15), and the **`creator_network_clean`** gate fails when more than `CREATOR_NETWORK_MAX_RUGGERS` (0) tied creators rugged or are blacklisted (`-1` turns the gate off). |
| Evaluate | Per group and per wallet: **profitable share** (tokens that ended in profit), win rate (+`WIN_ROI`), weighted ROI, rug share, win rate inside rugs, creator-linked share, fresh-wallet share, synchronised-buy share… → score 0-100, rule tags (insider, rug-farmer, sybil-sniper …) and a rule verdict. |
| NEAR AI | A compact evidence packet goes to NEAR AI Cloud; it answers with verdict, confidence, a short label, archetype, summary, reasons, red flags and follow/watch/avoid advice. The AI verdict is used when its confidence is at least 0.55, otherwise the rule verdict. |

**Tags** (shown for every wallet and group, replacing good / dangerous) look at the money first, then the hit rate (the share of the tokens it bought early that ended in profit, ROI above 0 at the latest checkpoint). **loss** = lost money overall (weighted ROI at or below 0). With a net profit: **win80** = hit rate 80 %+, **win50** = 50 %+, **win30** = 30 %+, **sniper** = under 30 % (a few big wins pay for many small losses; counted with the winners). **unrated** = fewer than `MIN_TOKENS_FOR_VERDICT` judged tokens. A group is tagged from its combined record, a wallet from its own. The rule / AI verdict (insider, rug farmer, sybil sniper, bots / consistent losers) is still computed and still feeds the scanner's entity gate and the AI analyst, but the UI shows the tags. ROI figures are mark-to-market estimates from on-chain swap prices (fees ignored).

**Known limits of the funding trace:** wallets funded from an exchange hot wallet (about a third of early wallets in a 97-token sample) only link through hub twins, because the exchange hides who the customer is; intents-funded wallets link only when the same intents account funds several of them. More tokens and time give more overlaps, so groups firm up as data accumulates. `npm run reprofile` redoes the funding trace for every wallet after the logic changes.

## Setup

Requires Node.js 20+.

```bash
cd entity-tracker
npm install
cp .env.example .env     # fill in MONGODB_URI, NEAR_AI_API_KEY, FASTNEAR_API_KEY
npm run check-ai         # optional: test the NEAR AI key / model
npm run backfill -- all 48   # replay the last 48 h of launches (nearlytrade, justhoot, memecooking)
npm run process          # read trades, profile wallets, group, evaluate, AI review
npm start                # worker + web UI (http://127.0.0.1:8790)
```

- **NEAR AI:** create a key at <https://cloud.near.ai> (API Keys). `NEAR_AI_MODEL` can be any chat model from `https://cloud-api.near.ai/v1/models` that supports JSON output (default `z-ai/glm-5.3-flash`). Without a key the tracker still runs with rule-based verdicts.
- **FastNEAR:** an API key raises rate limits on the transaction indexer and RPC.
- **Tests:** `npm test` (grouping, ROI, verdict and AI-parsing logic).
- **Nothing here trades:** there is no wallet or private key; the only "trading" is the simulated wallet in MongoDB.

## Scanner mode: monitor, AI analyst and simulated investing

The tracker also does what the live scanner does, with **paper money instead of live trading**:

1. **Monitor.** Every new launch on the configured launchpads is followed. `OBSERVE_SECONDS` (120; justhoot 240) after the pool opens it gets its first check.
2. **Hard gates** (ported from the live scanner): tradable quote, standard token contract, locked LP, pool size, market cap, number of independent buyers, creator not selling, tax, no linked / creator-funded buyers (checked with the tracker's funding profiles), not over-extended, executable quote, plus two that only the tracker can apply: the creator has no earlier rugged or dumped launch (or a dev rug seen by the simulated wallet), and early buying is not dominated by groups judged **dangerous** (insiders, rug farmers, sybil snipers).
3. **AI analyst (NEAR AI).** A token that passes the gates is reviewed by NEAR AI, which sees the features *and the tracker's memory of who the early buyers are* (`features.intel`: share of early NEAR from good / dangerous / bot-or-loser / neutral / unknown groups, and the creator's record). It answers BUY_MORE / HOLD / SELL with confidence, risk and reasons. BUY_MORE at `AI_MIN_CONFIDENCE` or above buys; a clean pass with rule score >= `HOLD_BUY_MIN_SCORE` also buys on HOLD; 5 NEAR (2 NEAR when the AI rates the risk high).
4. **Simulated wallet.** `SIM_START_NEAR` paper NEAR. A buy or sell is priced with the pool's real on-chain quote (price impact and pool fee included), then the launch's token tax and `SIM_EXTRA_SLIPPAGE_BPS` are applied; caps on exposure, buys per day and a cash reserve apply. Take profit: at ROI above `TAKE_PROFIT_ROI` (+300 %) it takes out the cost plus `TAKE_PROFIT_PROFIT_SHARE` of the profit and keeps the rest. A creator dumping a held token (balance down 20 %) is blacklisted and the position is sold. The UI has simulated **Sell 25 / 50 / All** buttons.
5. **Follow-up reviews.** Tokens that scored above `FOLLOWUP_MIN_SCORE` are re-reviewed at +15, +90 and +180 minutes (fresh features, gates and AI). A failed review of a token we do not hold cancels the later ones; an AI SELL on a held token sells it.

Everything is stored in MongoDB (`scans`, `followups`, `sim_account`, `sim_positions`, `sim_fills`, `sim_equity`, `blacklist`, `templates`). Useful commands: `node src/cli.js scan <token> [--features] [--buy]` (gates + AI on any stored token; `--buy` makes a simulated buy), `node src/cli.js sim-reset`. With no NEAR AI key nothing is bought unless `SIM_REQUIRE_AI=false`.

**Limits:** the simulation uses the pool quote at decision time, so real fills could be worse in a fast market, and it cannot model another bot buying first. Treat results as a sanity check of the strategy, not a promise.

## Importing the live scanner's data

`node src/cli.js import-scanner [path/to/state.json] [--dry]` (default `../near-launch-scanner/data/state.json`) copies what the scanner already knows: its launches become `tokens` (new ones are queued so the tracker reads their trades and early buyers), its evaluations and follow-up reviews become `scans` (source `scanner`, with gates, scores, AI verdicts and features), its creator blacklist feeds the tracker's creator gate, its code-hash counts merge into `templates`, and its **real** positions and spend go to `scanner_positions` / `scanner_spend`, kept apart so they never touch the simulated wallet. Imported launches are marked scanned, so the simulated wallet never buys them. Safe to re-run; existing tracker data is not overwritten.

## Contract audit

Ported from the TrustFlow backend (`contractAuditService`, `nearContractAnalysis`, `nearRpcClient`): a NEAR token / contract audit scored into a **risk** (0-100, higher = riskier: low / medium / high / critical) and a separate **trust** score, with the full checklist (passed checks are listed too):

- **Access keys:** a full-access key lets its holder redeploy or drain the contract; "locked" only counts as trust when the code has no backdoor.
- **Code:** the WASM exports are analysed offline. A fake NEP-145 `storage_*` method is the classic honeypot backdoor (NEARDOGE's `storage_unstake`); privileged methods (blacklist / freeze / pause / mint / upgrade ...), owner-only guards and non-standard methods are flagged, standards, getters and callbacks are not.
- **Behaviour:** recent sells (do holders' sells succeed, across how many wallets) and privileged accounts calling non-standard methods on other holders' accounts.
- **Tax:** the launchpad's `get_tax` (buy / sell bps).

Where it is used: the scanner audits every token it checks (cached 1 h) and puts a summary in `features.audit`; a confirmed malicious finding or a risk score at or above `AUDIT_MAX_RISK` (70) fails the `contract_audit_ok` gate, the risk also lowers the rule score, and the AI analyst reads the findings. The **Contract audit** page (`/audit`, `/audit/<account>`) audits any NEAR account on demand, the token page shows its audit, and `node src/cli.js audit <account> [--force] [--json]` does it from the command line. Results are stored in the `audits` collection. Checked against NEARDOGE (`doge.neardogecoin.near`: critical 92, fake `storage_unstake` called 24 times on holders), `wrap.near` (risk 0, trust 100) and a nearly.trade token (risk 0, only the launchpad's tax methods noted).

## Entities (exchange wallets included)

A **group** is a set of early investors; an **entity** is any account in their funding and money-flow graph: exchange hot wallets, NEAR Intents accounts, relayers / wallet services, ordinary funder wallets and the destinations their NEAR goes to. The `entities` collection (and the **Entities** tab) records for each one: its kind and label, how many early wallets it funded and how much, which tokens those wallets bought, how they performed, which good / bad groups they belong to, and how much early-investor NEAR it received. An exchange wallet is shown like any other entity, with a note that funding from it links nothing by itself.

Names come from built-in patterns (Binance, OKX, Bybit, Meteor, Intear ...), then from hand-set labels, otherwise a generic "unlabelled exchange / hub wallet": `node src/cli.js label <account> "Binance" exchange` names an account and rebuilds the table. `node src/cli.js entities` rebuilds it without changing anything else.

## Web UI

The UI is organised around two ways in, **tokens** and **wallets / groups**, plus the scanner. A search box at the top (press `/`) finds tokens by symbol or account, early wallets by account, and groups by id, AI label or member wallet. A NEAR account it doesn't know can still be sent to the contract audit. Dark by default, with a light theme toggle.

| Section | Pages |
|---|---|
| **Explore** (`/explore`, home) | Headline counts (groups by tag, rugged tokens, linked wallets), tokens where rated wallets bought early (cards with an early-money bar), best (win80 / win50) and largest loss groups, latest launches. |
| **Tokens & Scanner** (one menu) | `/tokens`: one page for every launch: the scanner's first check, gates and decision, the early-money bar by tag, outcome, rug flags (price crash / creator dump / dev-rug blacklist); tabs All · New (24 h) · Checked · Passed gates · Bought (sim) · Rugged, plus launchpad poll health. `/signals`: recent tokens with winners in / loss wallets in / mixed. `/tokens/<id>`: outcome tiles, why it counts as rugged, early money by tag, a **bubble map** of the early buyers clustered by group, early buyers with their tags, contract audit summary. `/sim` (simulated wallet with simulated sell buttons), `/scans` and `/scans/<id>` (gate checks and AI reviews), `/audit` and `/audit/<account>`. `/monitor` now opens `/tokens`. |
| **Wallets & Groups** | `/groups`, `/groups/<id>`: tag, AI review, track record, tokens bought early, members, funding / money-flow graph, the linked wallets within 3 hops, why the wallets are linked, review history. `/wallets`, `/wallets/<id>`: group membership, track record, early entries, funders, funding chain, outflows. `/entities`, `/entities/<id>`: exchange wallets, services, funders and destinations. |
| **System** | `/logs`, `/config` (read-only settings). |

**Launchpads.** `nearlytrade`, `justhoot` and `memecooking` get the full pipeline. `qlyphs` (migration tokens on a DCL pool quoted in QTC; the token goes live at its first real trade), `tkn` (plain FT factory `<symbol>.tkn.near`; the token waits as `awaiting_pool` until its owner adds liquidity on Ref DCL, found within 7 days) and `gaypad` (bonding curve inside `gaypad.j1-racing.near`; each `token_swap` event is a trade, valued from the change in its wNEAR reserve, with dust thresholds scaled down because a whole curve holds only a couple of NEAR) are tracked for their early investors only: no gates, AI analyst or simulated buys. `node src/cli.js backfill <launchpad> <hours>` replays history.

**Tokens not in the database.** Opening `/tokens/<account>` (or choosing "Fetch & analyse" in the search box) for a token the tracker has never seen fetches it from the chain in the background: it finds the launch on a supported launchpad, reads the trades and early buyers, audits the contract and runs the gates + AI analysis once (stored as an *on-demand* evaluation, never buying). Wallet profiling, groups and tags follow in the normal worker loop. Rate-limited to 10 fetches / 10 min per IP.

**justhoot v2.** Since 2026-10-19 justhoot launches through `v2-launchpad.justhoot.near` (tokens `<symbol>.v2-launchpad.justhoot.near`); the `justhoot` launchpad follows both the old and the new contract (`justhoot_v2` adapter, stored as `justhoot`).

**Hidden criteria on a public dashboard.** A public deployment (hosted, no `DASHBOARD_PASSWORD`) must not teach a rugger what is checked, so the API strips thresholds, rule names and reasons before answering: which rug rule fired, the creator-exit numbers, blacklist reasons, gate ids and decision texts of the scanner, the imported scanner evaluation, rule scores / tags / link types, AI reasons and archetype, the fresh / synced / insider metrics, audit weights and passed checks (only findings are listed). Prices, trades, wallets, on-chain links, tags, scores of groups and the rug flag itself stay. With a password, or locally, everything is shown. `HIDE_CRITERIA=1` / `0` forces it either way.

**Creators.** The *Creators* page (`/creators`, `/creators/<account>`) lists every token creator with launches, rugged launches, rug rate and the dev-rug blacklist (the scanner's blacklist plus creators this tracker's simulated wallet catches dumping). Tokens show a creator warning (blacklisted / rugged N of M launches), and every group lists the **contract creators inside it**: member wallets or linked wallets (up to 3 hops) that launched tokens, with their rugs; a group holding a blacklisted or rugging creator gets the `creator-rug` flag. The Log and Settings pages are no longer in the menu, and their API (`/api/logs`, `/api/config`) answers 404 on a public deployment without a dashboard password.

**Realized vs unrealized profit.** Every P&L is split: *realized* = NEAR already taken out minus the cost of the tokens sold, *unrealized* = tokens still held at the latest price minus their cost. Shown for groups, wallets, each token a group / wallet bought early, and for the simulated wallet and each simulated position.

Every token, wallet, group and entity has its own page at a clean path (History API, no `#`); external links go to the token's launchpad page and NearBlocks. `/` and `/overview` open `/explore`.

The UI and API are read-only except the simulated sell button (`POST /api/sim/sell`, paper positions only, same-origin + header check + Basic auth when exposed). `npm run web` serves the UI alone, `npm run worker` runs only the background loop, `npm start` runs both in one process.

## Deploying online (e.g. Railway)

1. Create a service from this repository, start command `npm start` (the default).
2. Variables: `MONGODB_URI`, `MONGODB_DB`, `NEAR_AI_API_KEY`, `FASTNEAR_API_KEY` (plus any threshold you want to change). On Railway the UI listens on `0.0.0.0` and port **8080** (or `PORT` when the host sets it); point the service's public domain at port 8080.
3. `DASHBOARD_PASSWORD` is **optional**. Without it the UI is public and read-only: the simulated-sell button is disabled (otherwise anyone could sell the paper positions). Set it to require HTTP Basic auth (any username) and re-enable the button.
4. In MongoDB Atlas allow the service's IP under Network Access.
5. Run **one** worker only (two workers would duplicate work). `npm run web` serves the UI alone if you want to scale it separately.

## MongoDB collections

`tokens` (launches, outcome, status) · `trades` (swaps) · `transfers` (token hand-offs between wallets) · `entries` (early wallet × token, with ROI per checkpoint) · `wallets` (profile, funding chain, outflows, track record, group) · `edges` (funding and flow edges) · `audits` (contract audits) · `scans` (gate checks + AI reviews) · `followups` · `sim_account` / `sim_positions` / `sim_fills` / `sim_equity` (simulated wallet) · `blacklist` · `templates` · `entities` (every funder / destination account incl. exchange wallets) · `labels` (hand-set names) · `clusters` (groups: members, links, metrics, tokens, rule + AI verdicts) · `cluster_history` · `events` (30-day log) · `meta` (cursors, worker heartbeat).

## Configuration

See `.env.example`; every threshold (early window, win ROI, rug drawdown, co-buy rule, score cut-offs, AI review frequency) is configurable.
