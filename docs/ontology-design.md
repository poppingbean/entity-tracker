# Ontology layer: design

**Status:** live since 2026-11-09. The tracer, live drain detection, wallet grouping and the firewall decide with the ontology (PRs #72–#75). Step G (writers assert facts directly, the old lists go) is planned for after the hackathon (14/11). Section 6 records how the migration actually went; it differs from the original plan.

**Goal:** every part of Safe Near asks **one place** what an account is and how accounts relate, instead of each module deciding on its own.

## Why

On 2026-11-04 a false "$38.5M exchange drain" was confirmed. The incident tracer called two NEAR Intents solvers (`solver-priv-liq.near`, `51e8f94d…`) exchange hot wallets, only because they were busy. Other parts of Safe Near would have classed them differently, or not at all. PR #66 fixed it in one place (`intentsSolver()` in `src/incident/origin.js`). The graph still calls the same account a "hub". The cause is structural: account types are decided in many places, with different words and different rules.

## 1. What existed before the migration

Kept as the record of what the migration replaced. The router lists and `classifyAccount`'s rules are still in the code, as the fallback and for shadow mode, until step G.

| Where | Function / data | What it decides | Its words | Used by |
|---|---|---|---|---|
| `src/labels.js` | `builtinLabel()`, `describe()`, `labels` collection | a name for well-known accounts, from **name patterns** or by hand | exchange, service, bridge, fund, other | entities, firewall, incidents, UI |
| `src/graph/profile.js` | `classifyAccount()` | the kind of every funder / destination of an early wallet | intents, protocol, relayer, **hub** (≥ HUB_TX_COUNT transactions), wallet | wallet grouping (`clusters`, `edges`), `wallets.kind` |
| `src/graph/services.js` | `SERVICE_NAME`, `SERVICE_TYPES`, `isService()` | accounts that must not link wallets into groups | service, exchange, bridge, fund + name patterns (factory, reward, treasury…) | grouping |
| `src/evaluate/entities.js` | `buildEntities()`, `entities` collection | every funder / destination as an entity, with its label | exchange, service, bridge, fund, wallet | Entities page, scanner entity gate |
| `src/incident/origin.js` | `identify()`, `intentsSolver()` | who paid a case's account | exchange (hot/cold), **service** (NEAR Intents solver), contract, wallet | incident tracer (upstream, drain rule) |
| `src/incident/exchanges.js` | `refreshExchangeRegistry()`, `exchangeWalletMap()`, `exchange_wallets` | exchange hot and cold wallets, with normal withdrawal sizes | hot, cold, named exchange | live drain detection, tracer |
| `src/incident/detect.js` | `ROUTERS` | accounts that only pass money through | 11 accounts | live drain detection |
| `src/incident/origin.js` | `ROUTERS` | same | **7** accounts | upstream tracing |
| `src/incident/trace.js` | `PASS_THROUGH`, `isRouter()`, `destKind()`, `isContract()` | same, plus where money ends (exchange, bridge, DEX, contract, wallet) | **9** accounts; exchange, bridge, DEX, contract, wallet | downstream tracing |
| incidents | `accounts[].role` | an account's role in one case | attacker, accomplice, sub_account, intents_account, cash_out_wallet, funder, fake_token, contract | flags, live follow, firewall, bot |
| `src/firewall/rules.js` | `TRUSTED` | accounts the firewall does not question | 29 accounts | transaction firewall, Safety Check |
| `src/analysis/prompt.js` | `accountRole()`, `KNOWN_ACTORS` | "looks like an actor but is not" and known actors from past investigations | wallet-app user, Telegram-wallet user, platform fee bot, launchpad contract, infrastructure | token analyst, firewall context |
| `src/audit/` | `classify.js`, `control.js`, `powers.js` | a contract's type, who controls it, its powers | token, nft, amm, lending, farm, dao, multisig, account…; controller kinds dao, multisig, locked, contract, wallet | audits, Safety Check, scanner gates |
| `firewall_flags` | flags | accounts known to be bad, and why | critical / high / medium + reason + source | firewall, Safety Check, Agent Guard |

## 2. Where they disagreed

1. **Pass-through accounts: three lists.**

   | account | detect | origin | trace | firewall `TRUSTED` |
   |---|---|---|---|---|
   | aggregatedex.near, dclv2.ref-labs.near, intents.near, near, v2.ref-finance.near, wrap.near | ✓ | ✓ | ✓ | ✓ |
   | dex.intear.near | ✓ | – | ✓ | ✓ |
   | meteor-relayer.near, relay.aurora | ✓ | – | ✓ | – |
   | aurora | ✓ | – | – | ✓ |
   | system | ✓ | ✓ | – | – |

   Money traced **out** passes through `dex.intear.near`; money traced **in** treats it as a counterparty.
2. **Busy accounts.** The tracer calls a busy account an exchange hot wallet unless it is a solver. The graph calls the same account a "hub". `solver-priv-liq.near` is a service in one and a hub in the other.
3. **Intear:** a *service* in `labels.js`, a *relayer* in the graph, *infrastructure* (and its user accounts *wallet-app users*) in `accountRole()`.
4. **Launchpads:** *protocol* in the graph, *launchpad contract* in `accountRole()`; only some are in `TRUSTED`.
5. **NEAR Intents:** the *intents* kind in the graph, a *service* in labels, a router in the tracers.
6. **No memory across modules.** What the audit learns about a contract (its controller), what a case learns (an attacker's accounts), and what a public report says (`confirm-incident`) stay inside their own collections. The grouping graph never sees that an account is a known attacker; the firewall sees flags but not the case structure.

## 3. The model

Two layers: **facts** (what we know, with where it came from) and **the resolved entity** (one answer per account, computed from its facts).

### 3.1 Entity classes

One primary class per account, in a small tree. Every module maps onto it.

```
account
├── person
│   ├── wallet                 an ordinary named or implicit account
│   ├── smart_wallet           an account contract (role "account" in the audit)
│   └── app_user               an account made by a wallet app (*.user.intear.near, *.tg)
├── exchange
│   ├── hot_wallet             pays users; operator = the exchange
│   ├── cold_wallet            holds reserves (binancecold3.near …)
│   └── deposit_address        sweeps to a hot or cold wallet
├── service
│   ├── intents_solver         fills NEAR Intents / 1Click swaps
│   ├── relayer                pays gas or creates accounts for users (meteor-relayer.near …)
│   ├── bridge                 omni.bridge.near, Rainbow …
│   ├── router                 passes money through (wrap.near, aggregatedex.near, intents.near …)
│   ├── launchpad              nearly.trade, justhoot, meme.cooking …
│   ├── treasury_or_reward     pays many accounts by design (reward-distribute…, airdrops)
│   └── factory                creates other contracts
├── contract
│   ├── token | nft | amm | lending | vault_farm | dao | multisig | staking | other   (from the audit's role)
└── system                     near, system
```

**Pass-through** stops being a list: it is the classes `service/router`, `service/relayer` and `system`, plus any account with an explicit `pass_through` fact.

### 3.2 Facts

Collection `ontology_facts`, one document per assertion:

| field | meaning |
|---|---|
| `subject` | the account (later: chain-qualified ids such as `eth:0x…`) |
| `predicate` | `is_a`, `operated_by`, `label`, `controls`, `deployed`, `created_by`, `funded`, `swept_to`, `solver_for`, `member_of` (a wallet group), `role_in` (a case, with the role), `flagged`, `pass_through`, `trusted` (a dapp users interact with every day) |
| `object` | a class, an account, a case id, a label … |
| `source` | `manual`, `public_report`, `registry` (exchange sweeps), `audit` (code and control), `trace` (an investigation), `behaviour` (transaction patterns), `name_pattern` |
| `evidence` | one line a person can read: "sends its reserves to binancecold3.near", "40 of its latest 40 transactions settle through intents.near", "rekt.news/rhea-finance-rekt" |
| `confidence` | 0..1 |
| `by` | the module that asserted it |
| `observed_ts`, `valid_from`, `valid_to` | when it was seen, and when it holds (an exchange can rotate a hot wallet; a case can be cleared) |

### 3.3 Resolution

`whatIs(account)` takes all live facts for the account and resolves its class by **source rank**, then confidence:

`manual` > `public_report` > `registry` > `audit` > `trace` > `behaviour` > `name_pattern`

The answer always carries **why** (the winning fact's evidence) and any **conflicts** (lower-ranked facts that disagree). This is what the 2026-11-04 bug lacked. A "busy" behaviour fact (`exchange/hot_wallet`, confidence 0.4) loses to a behaviour fact with stronger evidence (`service/intents_solver`, 0.8). It loses to a registry fact even more clearly. Every module would see the same answer.

Two refinements came from the first runs on production data:

- **Subclasses refine, they don't compete.** The strongest `is_a` sets the class; a weaker fact that refines it (`exchange` → `exchange/hot_wallet`) gives the subclass, and `why` carries both facts' evidence. Only facts that contradict the winner become conflicts.
- **"Confident" answers.** Grouping's fallback "wallet" only meant "nothing marks it as special". It is stored as the weakest fact there is (`name_pattern`, 0.2), below any name pattern. A module treats the ontology's answer as decisive only when it is **confident**: the class is not `unknown`, and it does not rest on that weakest fact alone. Otherwise the module keeps its old rule for that account.

**Code-level facts.** Facts that live in code (the known routers, launchpads, relayers, the firewall's trusted dapps, `KNOWN_ACTORS`, account-name patterns) are computed on the fly for each account (`src/ontology/known.js`) and never stored. So an account no collection has seen still gets an answer.

The resolved result is cached in `ontology_entities`, one document per account, rebuilt by every backfill.

## 4. The API

`src/ontology/index.js`, the only place modules read from:

```js
whatIs(account)                    // { class, top, label, operator, pass_through, cuts_links, trusted, flagged, roles, groups, confidence, source, why, conflicts }
whatIsMany(accounts)               // the same, one query, cached for 60 s
is(account, 'exchange'), isPassThrough(account)
relationsOf(account, { predicate, direction })   // the account's edges: controls, funded, swept_to, role_in, member_of …
entityView(account)                // what the API, the UI card and the what_is tool show: the class in words, why, overruled, edges
assert(facts), retire(filter)      // writers only
```

**For code that cannot wait** (`src/ontology/sync.js`): the tracers and grouping ask "is this a router?" or "does it link owners?" inside tight loops. So they read a synchronous **snapshot** of `ontology_entities`, kept in memory and refreshed every 10 minutes and after each backfill. Accounts not in the snapshot are resolved from code-level facts only. The snapshot API:
- `classOf(id)`, `passThrough(id)`, `confident(c)`;
- `groupingKind(id, txCount)`: grouping's words, `wallet | hub | intents | relayer | protocol`.

On the firewall's path this makes an ontology read cost nothing.

**The switch:** `ONTOLOGY_READ` lists the modules that decide with the ontology: `pass_through`, `tracer`, `grouping`, `firewall` (the default is all four). `ONTOLOGY_READ=none` puts every module back on its old rules **without deploying old code**. This is the rollback.

**Writers, today:** a daily, idempotent **backfill** (`src/ontology/backfill.js`) derives facts from:
- `labels`, `exchange_wallets` (registry sweeps; wallets found only by being busy get a weak behaviour fact);
- `entities` (the transaction count only; see 6.3), the audits (class, controllers), incidents (case roles; public reports outrank traces), `firewall_flags`, groups;
- an intents-solver check of busy accounts.

Each run re-asserts what it sees and closes the facts it no longer sees. Step G replaces this with each module asserting as it learns.

**Readers, today:**

| Reader | What it reads |
|---|---|
| live drain detection, the upstream trace, the money trail | one pass-through rule |
| the tracer's `identify()` and `destKind()` | named exchanges, solvers, bridges |
| grouping | `classifyAccount`, `isService`, the entity table's generic labels |
| the firewall context and its NEAR AI explanation | names, classes, "known dapp" |
| account pages | the "What Safe Near calls it" card |
| the public API and the Agent Guard | `GET /api/v1/entity`, the `what_is` tool |

**CLI:**

| Command | What it does |
|---|---|
| `what-is <account>` | the ontology's answer for one account |
| `ontology-backfill [--dry]` | derive facts from today's data (`--dry`: check them and the golden set, write nothing) |
| `ontology-replay` | trace every stored case with the old rules and with the ontology, and compare |
| `ontology-apply [--dry]` | re-sync grouping's stored kinds, then regroup |
| `ontology-gate` | what production runs, and what the shadow log shows |

## 5. The knowledge graph

The facts **are** the graph: every fact whose object is an account, a case or a group is an edge; every account is a node whose
type is its resolved class. No graph database: the edge list is `ontology_facts`, the node table is `ontology_entities`.

### 5.1 Nodes

| node | id | type comes from |
|---|---|---|
| account | `bob.near`, `51e8f94d…`; later `eth:0x…`, `zec:t1…` | `whatIs()`: the class tree (3.1) |
| class | `exchange/hot_wallet`, `service/intents_solver` … | the class tree; target of `is_a` |
| operator | `org:binance`, `org:near-intents`, `org:rhea` | a named organisation behind accounts |
| case | `inc:31ac7a27…` | the `incidents` collection |
| group | `grp:<id>`; `grp:known:<n>` for a `KNOWN_ACTORS` group | wallet grouping (`clusters`), `KNOWN_ACTORS` |

### 5.2 Edges (schema)

"Written by" is what writes the edge **today**: the backfill writers (`backfill/<collection>`) or the code-level facts (`known.js`, computed, never stored). Step G moves the writing into the modules themselves.

| predicate | from → to | written by (today) | example |
|---|---|---|---|
| `is_a` | account → class | every writer, `known.js` | `binancecold3.near` is_a `exchange/cold_wallet` |
| `label` | account → text | `labels`, `known.js`, entity hand labels | `intents.near` → "NEAR Intents" |
| `operated_by` | account → operator | `exchange_wallets`, `labels`, `known.js` | the Binance hot wallets → `org:binance` |
| `swept_to` | account → account | `exchange_wallets` | hot → `binancecold3.near` |
| `funded` | account → account | `entities` (the early wallets each entity funded); `case-add/<name>` (an analyst's or an approved ring's case edges, with tx evidence) | the edge carries the NEAR amount, tx and time |
| `solver_for` | account → account | the solver check in the backfill (`intentsSolver()`) | a busy account settling through `intents.near` |
| `controls` | account → account | audits | owner / DAO / multisig → contract |
| `deployed`, `created_by` | account → account | **not written yet** (step G: the tracer and the deploy watcher) | attacker → fake token |
| `member_of` | account → group | `clusters`, `KNOWN_ACTORS`, `case-add/<name>` (`grp:<name>`) | early wallets of one buyer |
| `role_in` | account → case | incidents (`public_report` when confirmed by a report, else `trace`); `case-add/<name>` for **suspected** roles only (linked by trading, never flagged) | attacker / accomplice / victim / target / cash_out_wallet / fake_token |
| `flagged` | account → severity | `firewall_flags` | `critical`, with the reason as evidence |
| `pass_through` | account → `true` | `known.js` (plus the router, relayer and system classes) | `wrap.near`, `aurora` |
| `trusted` | account → `true` | `known.js` (the firewall's trusted dapps) | `contract.main.burrow.near` |

Every edge keeps the fact fields: `source`, `confidence`, `evidence`, `by`, `valid_from` / `valid_to`. A query can ask for "edges a
person would accept" (`source ≥ trace`, `confidence ≥ 0.7`, still valid) and get a smaller, trusted graph.

### 5.3 What the graph must not do

The 2026-11-04 false drain was a **graph error**: money from two solvers was read as money from an exchange. So:

- **Hubs cut paths.** A walk (`funded`, `swept_to`, a case trail) does not cross an account whose class is `exchange`,
  `service/*` or `system`, or that has `pass_through`. It records the hub as an endpoint ("cashed out at Binance", "swapped
  through NEAR Intents") and stops. Two wallets paid by the same solver are **not** linked.
- **Labels do not spread along `funded`.** Being paid by an attacker does not make an account an attacker. Only `role_in` with
  a role, written by the tracer or a public report, does.
- **Derived facts can be undone.** Today this holds through the backfill: each run closes every fact it did not see again, so a dropped exchange wallet's facts close within a day, and a cleared case's `role_in` facts close at the next run, dated to the clear time. Explicit `derived_from: [fact ids]` links, for facts made from other facts, are not built yet; they come with step G, when facts are no longer re-derived daily.
- **The ontology's own output is never evidence** (6.3). Kinds and labels that modules computed by reading the ontology must not come back as facts.

### 5.4 Storage and queries

Indexes on `ontology_facts`: `{subject, predicate, valid_to}`, `{object, predicate, valid_to}`, `{predicate, source}`.

| question | how |
|---|---|
| question | how | built? |
|---|---|---|
| what is X and why | `whatIs(X)`: one indexed query on the facts plus the code-level facts, cached 60 s; `classOf(X)` from the in-memory snapshot for tight loops | yes |
| X's neighbours | `relationsOf(X, {predicate, direction})`: one indexed query each way | yes (the account card, `/api/v1/entity`, `what_is`) |
| who is behind this contract | `controls` in, then `operated_by` / `member_of` of the controller | the edges exist; no query uses them yet |
| the whole case | every `role_in` → `inc:…`, plus the `funded` / `swept_to` edges between those accounts | the edges exist; the case page still reads `incidents` |
| where did the money go | walk `funded` out from the case accounts, ≤ 6 hops, stop at hubs (5.3) | no: the tracer's own `followMoney` follows the chain, and asks the ontology only where to stop |
| is this receiver close to a known bad account | 2-hop walk, hubs cut, any `flagged` or attacker `role_in` (the firewall, within its 2.5 s budget) | no: the firewall checks the account itself (`firewall_flags`), not its neighbours |

Walks, when they are built, run in JS (breadth first, one batched query per hop, the snapshot to cut hubs), not `$graphLookup`, because the stop rule needs the resolved class of each account.

## 6. Migration: what was planned, what was done

### 6.1 The plan

Eight steps, each in its own PR, each module moving only after **a week of shadow log** with every disagreement explained. An automatic gate (`ontology-gate`) would open the next PR when production showed:
- the step was running (a heartbeat from each process);
- the shadow window was long enough, with enough decisions per module;
- the golden set was correct;
- the firewall's latency was within budget.

In the gate and the PRs the steps have letters: A = 1 + 2, B = 8, C = 3, D = 4, E = 5, F = 6, G = 7.

| # | Step | Risk | Check before merging |
|---|---|---|---|
| 1 | Add `src/ontology/`: the class tree, `ontology_facts`, `whatIs`, and a **backfill** that turns today's data into facts (labels, `exchange_wallets`, `entities`, audit roles and controllers, incident roles, `firewall_flags`, `KNOWN_ACTORS`, the router lists). Nothing reads it yet. | none | a **golden set** test: Binance's 3 hot wallets and `binancecold3.near` → exchange; `solver-priv-liq.near`, `51e8f94d…` → service/intents_solver; `intents.near`, `wrap.near` → router; launchpads → service/launchpad; `meteor-relayer.near` → relayer; `*.tg` → app_user; `contract.main.burrow.near` → contract/lending |
| 2 | **Shadow mode:** each module keeps deciding as today, and also asks `whatIs`, logging every disagreement. | none | a week of disagreement logs; each one is either a bug in the old code or a missing fact |
| 3 | One pass-through definition: replace the three router lists with `isPassThrough()`. | low | replay the stored cases (`efd224…` Binance, `31ac7a27…` Rhea, the watched ones): same status and kind |
| 4 | **Incident tracer** (`origin.identify`, `destKind`, the drain rule) reads `whatIs`. | **high**: decides what is called a hack | replay every stored case; no case changes status without a written reason |
| 5 | **Grouping** (`classifyAccount`, `isService`) reads `whatIs`. | medium: groups and scanner gates move | rebuild groups in shadow; compare membership and the scanner's entity gate on recent launches |
| 6 | **Firewall and Safety Check** read `whatIsMany` (labels, roles, trusted). | **high**: verdicts, and the 2.5 s budget | replay the transaction tests; p95 latency within budget |
| 7 | Writers assert facts directly (the backfill becomes the normal path); the old collections become views or go away. | medium | the golden set and the replays again |
| 8 | Show it: "why we call this an exchange" on account pages, `GET /api/v1/entity?id=`, and a `what_is` Agent Guard tool. | low | — |

### 6.2 What was done, and why it changed

The hackathon ends on 14/11, which left no room for weekly windows. So the shadow window was replaced, step by step, by **direct checks on production data**, run before the merge and recorded in the PR.

| PR | Steps | Check that replaced the shadow week |
|---|---|---|
| #72 | 1 + 2: the layer, the backfill, shadow mode, the heartbeat and the gate | dry-run backfill on production data (9,762 facts, 0 rejected); golden set 15 of 15 |
| #73 | 8: the account-page card, `GET /api/v1/entity`, the `what_is` tool | the gate (B ready once A ran); checked live on the site and over MCP |
| #74 | 3, 4, 5, 6 **together**: one pass-through rule, the tracer, grouping, the firewall, behind `ONTOLOGY_READ` | see below |
| #75 | fixes found in production (6.3) | the gate and live checks |

The checks for #74:
- **Stored-case replay** (`ontology-replay`): every stored case traced twice in one process, with the old rules and with the ontology. **None of the 24 changed status or kind.** The 6 differences were intended: a Binance hot wallet no longer listed as an attacker's cash-out wallet; trails ending at named exchanges and solvers.
- **Groups rebuilt in memory** under both rules: 831 of 850 identical; no wallet joined or left grouping; 87 wallets in merged groups of app users with real money links.
- **Firewall transactions, old vs new:** the same verdicts, including the demo case. One warning is stricter, as intended (a deposit to a `*.tg` user).

What made one PR acceptable is the **switch** (`ONTOLOGY_READ=none` is a rollback without a deploy) and the **automatic re-sync** of stored data (6.4).

### 6.3 Rules learned in production

- **Never read the ontology's own output back as evidence.** After #74, grouping's `entities.kind` came from the ontology. The backfill read it back, and a treasury that grouping calls a "hub" returned as "busy, so an exchange", outranking its name (15 accounts, fixed in #75). Facts may only come from **evidence**: transaction counts, sweeps, code, reports, names. Outputs of modules that read the ontology never count as evidence. Step G must keep this rule.
- **Known-dapp only from strong evidence.** In the firewall, "known dapp" softens warnings. It now comes only from the trusted list, hand labels, the registry or a low-risk audit, never from an account name. An app user (`*.tg`) is a person, not an app.
- **App users are people.** `*.tg`, `*.user.intear.near`, `*.racerbot.near` and `*.trade.unrlzd.near` link wallets in grouping, as people do. Before, they were relayers and linked nothing.
- **Aurora is pass-through everywhere.** Money sent to the Aurora engine leaves NEAR, and drain detection must never treat an exchange's bridge deposit as a drain.
- **Only a named exchange ends a money trail.** An account known only as "busy" is still followed.
- **A local copy must not fool the gate.** A local run pointed at the production database sets `ONTOLOGY_HEARTBEAT=false`.

### 6.4 Existing data

Grouping stores the kind of every account it saw on each wallet, so a rule change does not reach old data by itself. On the first start with a new grouping rule, the worker re-syncs those kinds:
- it is local (stored transaction counts, no network);
- 654 of 10,156 wallets changed on 2026-11-09;
- it then rebuilds groups and the entity table, and records the rule in `meta.ontology_grouping_mode`.

Flipping `ONTOLOGY_READ` re-syncs in the other direction. Stored hack cases are not rewritten: they change only when re-traced (a follow-up or a deep review). Facts refresh with the daily backfill.

### 6.5 Still to do: step G (after 14/11)

- **Writers assert facts as they learn them:**
  - the registry when it finds a hot wallet;
  - the tracer when it confirms a case and its roles;
  - the audit when it classifies a contract;
  - `confirm-incident` for public reports.

  `case-add` (docs/incidents.md) already writes this way: an analyst's case accounts, `funded` edges and suspected roles are asserted at once, and the ring detector's approvals go through it.

  The backfill then goes away, and so does the drift between a change and the next daily run.
- **Remove the old rules:** the three router lists, `classifyAccount`'s rules, `TRUSTED` as a separate list, the entity table's own labels. Shadow mode, the gate, `triage.json` and the heartbeat steps then have nothing left to compare, and go too.
- **Close the remaining gap:** an account no collection has seen and no name explains still falls back to the old on-chain checks, so a never-seen busy account can still be called an exchange hot wallet unless the solver check fires.

Checks before G merges: the golden set, the stored-case replay, and the group comparison, as in #74.

## 7. Not in scope

- RDF / OWL / a graph database: MongoDB documents and one resolver give the benefit without a new system.
- Accounts on other chains: the fact shape allows chain-qualified ids later (the 1Click recipients, the attacker's ETH wallet in the Rhea case).
- Automatic discovery of new classes: the tree changes by hand, in this file and `src/ontology/classes.js`.
