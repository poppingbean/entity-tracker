# Running and operating Safe Near

Setup, deployment, operating notes, the web UI, the code layout, the database and every setting. Back to the [README](../README.md).

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

- **NEAR AI:** create a key at <https://cloud.near.ai> (API Keys). `NEAR_AI_MODEL` can be any chat model from `https://cloud-api.near.ai/v1/models` that supports JSON output (default `anthropic/claude-haiku-5-5`, used by the scanner's AI analyst and group reviews; the On-chain analysis write-up uses `NEAR_AI_ANALYSIS_MODEL`, default `anthropic/claude-sonnet-5-5`). Without a key the tracker still runs with rule-based verdicts.
- **FastNEAR:** an API key raises rate limits on the transaction indexer and RPC.
- **Tests:** `npm test` (stored real transactions as fixtures: `node src/cli.js fixture-tx <hash> <name>` captures one into `test/fixtures/tx/`, and the ones marked synthetic are replaced by real captures; grouping, ROI, outcome and rug rules, verdicts, AI parsing and the injection guard, alert detectors and delivery, accuracy metrics).
- **Nothing here trades:** there is no wallet or private key; the only "trading" is the simulated wallet in MongoDB.

## Deploying online (e.g. Railway)

1. Create a service from this repository, start command `npm start` (the default).
2. Variables: `MONGODB_URI`, `MONGODB_DB`, `NEAR_AI_API_KEY`, `FASTNEAR_API_KEY` (plus any threshold you want to change). On Railway the UI listens on `0.0.0.0` and port **8080** (or `PORT` when the host sets it); point the service's public domain at port 8080.
3. `DASHBOARD_PASSWORD` is **optional**. Without it the UI is public and read-only: the simulated-sell button is disabled (otherwise anyone could sell the paper positions). Set it to require HTTP Basic auth (any username) and re-enable the button.
4. In MongoDB Atlas allow the service's IP under Network Access.
5. Run **one** worker only (two workers would duplicate work). `npm run web` serves the UI alone if you want to scale it separately.

**Operating notes.**
- **Is the new version running?** `node src/cli.js ontology-gate` prints the commit and the ontology steps each production process reports (a heartbeat, once a minute), the golden set and the shadow log. `/api/health` says whether the database and NEAR AI are reachable.
- **A merge that does not deploy.** If the host missed the push (the last deployment is still the previous commit), use *Deploy latest commit* in Railway, or check the service's Source settings: branch `main`, automatic deploys on, *Wait for CI* off (this repository has no CI), no watch paths that exclude `src/`.
- **Rolling back the ontology without a deploy.** Set `ONTOLOGY_READ=none` and restart: the tracer, drain detection, grouping and the firewall go back to their old rules, and grouping's stored kinds are re-synced the other way. A subset works too, e.g. `ONTOLOGY_READ=pass_through,tracer`.
- **After a grouping rule change** the worker re-syncs the kinds stored on wallets by itself (log line `ontology: grouping rule … wallets re-synced, groups rebuilt`); nothing to run by hand.
- **Working from a laptop on the production database.** Allow its IP in Atlas (a TLS "internal error" on connect means it is not allowed), and set `ONTOLOGY_HEARTBEAT=false ONTOLOGY_SHADOW=false ONTOLOGY_BACKFILL_EVERY_HOURS=0` for any local server, so it never tells the gate that unmerged code is running. Dry runs that write nothing: `ontology-backfill --dry`, `ontology-apply --dry`, `ontology-replay`.

## Web UI

The UI is organised around **tokens**, **wallets / groups** and **safety** (Safety Check, contract audits, hacks), plus the scanner. AI write-ups are credited to **NEAR AI**: the page never names the model, and API responses drop `model` fields. A search box at the top (press `/`) searches everything at once: tokens (symbol or account), wallets, groups (id, AI label or member), token creators, funders and entities (by name, e.g. "binance"), audited contracts (account, token name or symbol), hack cases (an account in the case, its target, or words of its headline), flagged accounts and NFT collections. Paste a full account, a transaction hash or a link and the first results are **Is it safe?** (the Safety Check, with what the ontology calls the account and whether it is flagged), its wallet page, and for a contract its audit, whether Safe Near has seen it before or not. Dark by default, with a light theme toggle.

| Section | Pages |
|---|---|
| **Explore** (`/explore`, home) | Headline counts (tokens, early wallets, winning and loss groups, rugged tokens, blacklisted creators, contracts audited and hacks in the last 24 h), then two columns: highest trading volume and latest launches; large transfers & hacks and new contracts with their audit level; latest alerts and an "Is it safe?" box with the live watch status. |
| **Safety Check** | `/firewall`: one box for anything pasted, with the hacks it is linked to and buttons to investigate a transaction or a contract as a hack; beside it the live feed (the chain watch, new contracts as they are audited, large transfers caught live, traced hacks, 24 h counts; refreshed every 15 s). `/firewall/<incident>`: one investigation (NEAR AI analyst report, losses, victims, money trail across chains, attacker accounts, what is still held, attack transactions, timeline). The old `/incidents` links open here. |
| **Monitoring** | `/alerts`: the alert feed (all, high only, my watchlist), the watchlist with its search, and the Telegram bot guide. |
| **Tokens & Scanner** (one menu) | `/analysis`, `/analysis/<token>`: the on-chain analysis and AI analyst report. `/tokens`: one page for every launch: the scanner's first check, gates and decision, the early-money bar by tag, outcome, rug flags (price crash / creator dump / dev-rug blacklist); tabs All · New (24 h) · Checked · Passed gates · Bought (sim) · Rugged, plus launchpad poll health. `/signals`: recent tokens with winners in / loss wallets in / mixed. `/tokens/<id>`: outcome tiles, why it counts as rugged, early money by tag, a **bubble map** of the early buyers clustered by group, early buyers with their tags, contract audit summary. `/sim` (simulated wallet with simulated sell buttons), `/scans` and `/scans/<id>` (gate checks and AI reviews), `/audit` and `/audit/<account>`. `/monitor` now opens `/tokens`. |
| **NFT Collectibles** | `/nfts`, `/nfts/<contract>`: collections, mint, team mints, minter groups, market and wash trades, holders, AI analyst. |
| **Wallets & Groups** | `/groups`, `/groups/<id>`: linked groups (money only), tag, AI review, track record, tokens bought early, members, funding / money-flow graph, the linked wallets within 3 hops, why the wallets are linked, review history. `/wallets`, `/wallets/<id>`: group membership, track record, early entries, funders, funding chain, outflows. `/entities`, `/entities/<id>`: exchange wallets, services, funders and destinations. Wallet and entity pages show **What Safe Near calls it** (the ontology's class, why, what it overruled, its links). `/taggroups`: tag groups (wallets by what they do). `/creators`: token creators and their rug record. |
| **Accuracy** | `/accuracy`: how often the gates, scores, AI analyst and group verdicts were right. |
| **System** | `/logs`, `/config` (read-only settings). |

**Hidden criteria on a public dashboard.** A public deployment (hosted, no `DASHBOARD_PASSWORD`) must not teach a rugger what is checked, so the API strips thresholds, rule names and reasons before answering: which rug rule fired, the creator-exit numbers, blacklist reasons, gate ids and decision texts of the scanner, the imported scanner evaluation, rule scores / tags / link types, AI reasons and archetype, the fresh / synced / insider metrics, audit weights and passed checks (only findings are listed). Prices, trades, wallets, on-chain links, tags, scores of groups and the rug flag itself stay. With a password, or locally, everything is shown. `HIDE_CRITERIA=1` / `0` forces it either way.

Every token, wallet, group and entity has its own page at a clean path (History API, no `#`); external links go to the token's launchpad page and NearBlocks. `/` and `/overview` open `/explore`.

The UI and API are read-only except the simulated sell button (`POST /api/sim/sell`, paper positions only, same-origin + header check + Basic auth when exposed). `npm run web` serves the UI alone, `npm run worker` runs only the background loop, `npm start` runs both in one process.

## Project layout

| Folder | What is in it |
|---|---|
| `src/ai/prompts/` | **Every AI system prompt**, one Markdown file each (`incident-report.md`, `audit-code-review.md`, `token-analyst.md` …). Edit the text there; no code change is needed. `{{include:name}}` pulls in another prompt file (the token and NFT analysts share parts this way), and `{{name}}` is a value the code fills in (a config number, the list of contract roles …); a missing value is an error. `npm test` checks that every prompt loads with no slot left unfilled. |
| `src/ai/tools/` | What the AI stages share: `nearai.js` (the NEAR AI client: `chatJSON`, models, retries), `untrusted.js` (the guard for chain data, see below), `budget.js` (the daily AI call budget, `AUTO_AUDIT_AI_PER_DAY`), `verify.js` (checks on what the AI says: audit findings must cite code that exists, amounts in an incident write-up must match the evidence). |
| `src/<feature>/` | Each feature with its own AI stage next to its rules: `analysis/` (token analyst), `audit/` (contract audits, function review), `evaluate/` (group verdicts and `ai-review.js`), `firewall/`, `incident/` (hacks, deep review), `nft/`, `scanner/`. |
| `src/ontology/` | The ontology layer: `classes.js` (the class tree, source ranks), `resolve.js` (facts → one answer, pure), `index.js` (`whatIs`, `whatIsMany`, `relationsOf`, `entityView`, `assert`), `sync.js` (the in-memory snapshot the tracers, grouping and the firewall read; `ONTOLOGY_READ`), `known.js` (facts that live in code: router lists, launchpads, trusted dapps, name patterns), `backfill.js` (facts from the other collections, daily), `apply.js` (re-syncs grouping's stored kinds when its rule changes), `replay.js` (stored cases, old rules vs ontology), `shadow.js` (shadow mode and the heartbeat), `gate.js` + `golden.js` + `triage.json` (the migration gate). |
| `src/web/server.js` | The API, and the UI files below. |
| `src/web/public/` | The UI: `index.html` (the page shell), `assets/app.css`, and `assets/js/`: `core.js` (helpers, formatting, API access, state; loaded first), `pages/*.js` (one file per section: explore, tokens, wallets, scanner, creators, analysis, nfts, alerts, system, accuracy, safety, incidents, audit), `search.js`, and `app.js` (navigation and the router; loaded last). They are plain scripts sharing one scope, loaded in the order `index.html` lists, so no build step is needed. Every file is served with a version stamp (`?v=`, new on each start), so a deploy never shows a stale mix. |

## MongoDB collections

`tokens` (launches, outcome, status) · `trades` (swaps) · `transfers` (token hand-offs between wallets) · `entries` (early wallet × token, with ROI per checkpoint) · `wallets` (profile, funding chain, outflows, track record, group) · `edges` (funding and flow edges) · `audits` (contract audits) · `analyses` (token analyses and NEAR AI assessments) · `nft_collections` / `nft_events` / `nft_analyses` (NFT collectibles) · `scans` (gate checks + AI reviews) · `followups` · `sim_account` / `sim_positions` / `sim_fills` / `sim_equity` (simulated wallet) · `blacklist` · `templates` · `entities` (every funder / destination account incl. exchange wallets) · `labels` (hand-set names) · `clusters` (groups: members, links, metrics, tokens, rule + AI verdicts) · `cluster_history` · `events` (30-day log) · `alerts` · `watchlists` · `contract_deploys` / `audit_queue` / `code_audits` (automated audits) · `firewall_flags` (reported and incident accounts) · `incidents` / `incident_queue` / `incident_detections` (hacks) · `contract_state` · `token_flags` (alerts) · `analysis_runs` (every AI analyst run with its evidence) · `ground_truth` · `feedback` (accuracy) · `price_history` (hourly NEAR/USD) · `ontology_facts` / `ontology_entities` (the ontology: facts and resolved accounts) · `ontology_shadow` / `ontology_shadow_stats` (shadow-mode comparisons) · `meta` (cursors, worker heartbeat, accuracy results, `security:watch` for the live feed).

## Configuration

See `.env.example`; every threshold (early window, win ROI, rug drawdown, co-buy rule, score cut-offs, AI review frequency) is configurable. Settings added most recently:

| Setting | Default | What it does |
|---|---|---|
| `ONTOLOGY_READ` | `pass_through,tracer,grouping,firewall` | The modules that decide with the ontology; `none` puts them all back on their old rules (the rollback) |
| `ONTOLOGY_SHADOW` | `true` | Compare each module's old rule with the ontology and record it (`ontology_shadow`) |
| `ONTOLOGY_BACKFILL_EVERY_HOURS` | `24` | Re-derive the ontology's facts from the other collections (`0` = never) |
| `ONTOLOGY_HEARTBEAT` | `true` | Report this process's commit and ontology steps; `false` on a local copy that uses the production database |
| `FIREWALL_EXPLAIN_MODEL` | the analysis model | The NEAR AI model that explains a transaction check in words (the fast model missed too often in tests) |
| `INCIDENT_ALERT_MAX_AGE_DAYS` | `7` | A hack older than this when found is recorded as a past case, with no alert |
| `PRICE_AT_INCIDENT` / `PRICE_HISTORY_URL` | `true` / Binance klines | Value a case at the prices when the money moved (history of NEAR/USD); `false` = today's prices |
| `TRAIL_SEARCH` | `best_first` | The money trail search; `bfs` restores the old one. Budget: `TRAIL_FLOOR_USD` 200, `TRAIL_SHARE_FLOOR` 0.005, `TRAIL_MAX_WALLETS` 40, `TRAIL_MAX_DEPTH` 6, `TRAIL_MAX_MINUTES` 5 |
| `IDENTIFY_BUSY_NEUTRAL` | `true` | A busy account is never called an exchange hot wallet on busyness alone |
| `AI_GROUNDING_RETRY` | `true` | An AI text quoting something not in its evidence is asked again once |
| `ANALYSIS_HOLDERS_VERIFIED` | `60` | Holders checked live (traders, transfer-only holders and the creator) |
| `DATA_GAP_BLOCKS`, `DATA_CHECK_EVERY_MINUTES`, `DATA_CHECK_SAMPLE`, `DATA_CHECK_RPC_URLS`, `DATA_CHECK_RECEIPTS` | `5`, `60`, `10`, a non-FastNEAR RPC, `false` | Data health: empty block runs checked against RPC, a sample of indexer transactions cross-checked on another host |
| `WATCH_ENABLED` | `true` | Money watch: every movement of `WATCH_MIN_USD` ($100k) or more, whatever the token, opens a watch case whose money is followed until the reviewer calls it normal |
| `WATCH_MIN_USD`, `WATCH_FOLLOW_MIN_USD`, `WATCH_FOLLOW_SHARE`, `WATCH_FOLLOW_CAP_USD`, `WATCH_DUST_USD`, `WATCH_DUST_SHARE` | `100000`, `10000`, `0.1`, `100000`, `1000`, `0.05` | What opens a watch; which moves out of a watched account are followed (this much and this share of what the sending account received, and always from the cap up, so the parts of a big drain are followed; small transfers to one receiver are summed); and when an account has sent everything (all but the dust) and stops being watched |
| `WATCH_RECORD_MIN_USD` | `100` | Smaller moves out of a watched account are ignored; from this size they count toward what the account has sent on, even when too small to follow |
| `WATCH_ESCALATE` | `false` | A suspicious verdict opens an incident (the public incident path: trace, deep review, possible alerts and flags). Off: marked suspicious on the private Money watch page only |
| `WATCH_MAX_ACCOUNTS`, `WATCH_MAX_DEPTH`, `WATCH_MAX_IDLE_DAYS` | `40`, `6`, `30` | Limits of one watch: accounts, hops, and days with no move before it is closed as normal (kept) |
| `WATCH_AI`, `WATCH_AI_PER_DAY`, `WATCH_REVIEW_GAP_MINUTES`, `WATCH_REVIEW_MIN_USD` | `true`, `100`, `60`, `10000` | NEAR AI review of watches: its own daily budget, at most one review an hour per watch, and only after this much new money moved or a new exit |
| `WATCH_LINK_HOPS` | `3` | A reported address is looked back this many large payments to find a watch or incident it was funded from |

