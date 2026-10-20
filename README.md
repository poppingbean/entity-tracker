# NEAR Entity Tracker

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
| Outcome | Price at 1 h / 6 h / 24 h, peak, drawdown, rug flag (price down `RUG_DRAWDOWN` from the peak), creator buys / sells. |
| Profile | For each early wallet: who **really** funded it, the funder's own funder up to `FUNDING_DEPTH` hops, kind of every account (exchange/hub, relayer, intents, protocol, ordinary wallet), and where it sent NEAR recently. Wallets created by a relayer (meteor, Intear, HERE) all share the relayer as creator, which proves nothing, so the tracker reads the oldest 30 transactions, collects every NEAR inflow (including contract-originated ones and NEAR Intents `native_withdraw` events, which name the intents account that ordered the withdrawal), drops gas top-ups and takes the earliest sender of at least 1 NEAR as the funder (other large senders are kept as extra funders). |
| Group | Wallets are linked through non-generic funders, flows between members or into a shared destination (at least 2 NEAR each), repeated co-buying, creator funding, and "hub twins" (an exchange wallet paying two wallets the same odd amount within an hour). Exchanges, relayers, intents and "distributor" wallets that fund dozens of unrelated buyers link nothing. |
| Evaluate | Per group: win rate, weighted ROI, rug share, win rate inside rugs, creator-linked share, fresh-wallet share, synchronised-buy share… → score 0-100, tags and a rule verdict. |
| NEAR AI | A compact evidence packet goes to NEAR AI Cloud; it answers with verdict, confidence, a short label, archetype, summary, reasons, red flags and follow/watch/avoid advice. The AI verdict is used when its confidence is at least 0.55, otherwise the rule verdict. |

**Good** = early money that makes money in tokens that hold up, with no insider links. **Bad** = insiders (funded by or paying the creator), rug farmers (profit mostly from tokens that collapsed), coordinated sybil snipers, bots or consistent losers. **Unknown** = fewer than `MIN_TOKENS_FOR_VERDICT` judged tokens. ROI figures are mark-to-market estimates from on-chain swap prices (fees ignored); a wallet's later buys and transfers to other wallets are not tracked, so treat verdicts as evidence, not proof.

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

## Entities (exchange wallets included)

A **group** is a set of early investors; an **entity** is any account in their funding and money-flow graph: exchange hot wallets, NEAR Intents accounts, relayers / wallet services, ordinary funder wallets and the destinations their NEAR goes to. The `entities` collection (and the **Entities** tab) records for each one: its kind and label, how many early wallets it funded and how much, which tokens those wallets bought, how they performed, which good / bad groups they belong to, and how much early-investor NEAR it received. An exchange wallet is shown like any other entity, with a note that funding from it links nothing by itself.

Names come from built-in patterns (Binance, OKX, Bybit, Meteor, Intear ...), then from hand-set labels, otherwise a generic "unlabelled exchange / hub wallet": `node src/cli.js label <account> "Binance" exchange` names an account and rebuilds the table. `node src/cli.js entities` rebuilds it without changing anything else.

## Web UI

Tabs: **Overview** (counts, top good / bad groups, latest launches) · **Signals** (recent tokens where known good or bad groups were among the early buyers, with a bullish / warning / mixed assessment) · **Groups** (filter, sort, open one for the AI review, metrics, funding / money-flow graph, wallets, tokens and verdict history) · **Entities** (exchange wallets, services, funders, destinations) · **Wallets** · **Tokens** (early buyers with their group verdicts) · **Logs**.

The UI and API are GET-only. `npm run web` serves the UI alone, `npm run worker` runs only the background loop, `npm start` runs both in one process.

## Deploying online (e.g. Railway)

1. Create a service from this folder (root directory `entity-tracker`), start command `npm start`.
2. Variables: `MONGODB_URI`, `MONGODB_DB`, `NEAR_AI_API_KEY`, `FASTNEAR_API_KEY`, `DASHBOARD_PASSWORD` (required: when the host sets `PORT` the UI listens publicly and demands HTTP Basic auth, any username).
3. In MongoDB Atlas allow the service's IP under Network Access.
4. Run **one** worker only (two workers would duplicate work). The web UI can be scaled separately with `npm run web` if needed.

## MongoDB collections

`tokens` (launches, outcome, status) · `trades` (swaps) · `transfers` (token hand-offs between wallets) · `entries` (early wallet × token, with ROI per checkpoint) · `wallets` (profile, funding chain, outflows, track record, group) · `edges` (funding and flow edges) · `entities` (every funder / destination account incl. exchange wallets) · `labels` (hand-set names) · `clusters` (groups: members, links, metrics, tokens, rule + AI verdicts) · `cluster_history` · `events` (30-day log) · `meta` (cursors, worker heartbeat).

## Configuration

See `.env.example`; every threshold (early window, win ROI, rug drawdown, co-buy rule, score cut-offs, AI review frequency) is configurable.
