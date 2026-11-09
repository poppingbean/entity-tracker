# Ontology layer: design

**Status:** proposal, for review. Nothing here changes behaviour yet.

**Goal:** every part of Safe Near asks **one place** what an account is and how accounts relate, instead of each module deciding on its own.

## Why

On 2026-11-04 a false "$38.5M exchange drain" was confirmed. The incident tracer called two NEAR Intents solvers (`solver-priv-liq.near`, `51e8f94d…`) exchange hot wallets, only because they were busy. Other parts of Safe Near would have classed them differently, or not at all. PR #66 fixed it in one place (`intentsSolver()` in `src/incident/origin.js`). The graph still calls the same account a "hub". The cause is structural: account types are decided in many places, with different words and different rules.

## 1. What exists today

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

## 2. Where they disagree

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
| `predicate` | `is_a`, `operated_by`, `label`, `controls`, `deployed`, `created_by`, `funded`, `swept_to`, `solver_for`, `member_of` (a wallet group), `role_in` (a case, with the role), `flagged`, `pass_through` |
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

The resolved result is cached in `ontology_entities` (one document per account, rebuilt when its facts change), so reads are one lookup.

## 4. The API

`src/ontology/index.js`, the only place modules read from:

```js
whatIs(account)                    // { account, class, subclass, label, operator, contract, confidence, why, conflicts }
whatIsMany(accounts)               // the same, batched and cached (the firewall's 2.5 s budget)
is(account, 'exchange')            // class checks; also isPassThrough(), isService(), isSolver()
relationsOf(account, { predicate, direction })   // controls, funded, swept_to, role_in, member_of …
assert({ subject, predicate, object, source, evidence, confidence, by, valid_from })   // writers only
```

**Writers** (they assert facts; nothing else writes): `labels` (manual names), the exchange registry, the audits (contract class, controllers), the incident tracer (case roles, solvers, attackers), `confirm-incident` (public reports), the graph profiler (behaviour), `KNOWN_ACTORS`.

**Readers** (they call `whatIs`, never their own lists): the tracers, live detection, grouping, entities, the firewall, Safety Check, the analysts' evidence packets, the Agent Guard (a new `what_is` MCP tool).

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
| group | `grp:<id>` | wallet grouping (`clusters`) |

### 5.2 Edges (schema)

| predicate | from → to | written by | example |
|---|---|---|---|
| `is_a` | account → class | every writer | `binancecold3.near` is_a `exchange/cold_wallet` |
| `operated_by` | account → operator | registry, labels | the 3 Binance hot wallets → `org:binance` |
| `swept_to` | account → account | exchange registry | hot / deposit → `binancecold3.near` |
| `funded` | account → account | trace, graph profiler | first payer of a new wallet (edge carries amount, token, tx, time) |
| `solver_for` | account → account | `intentsSolver()` | `solver-priv-liq.near` → `intents.near` |
| `controls` | account → account | audit | owner / DAO / multisig → contract |
| `deployed`, `created_by` | account → account | audit, trace | attacker → fake token |
| `member_of` | account → group | grouping | early wallets of one buyer |
| `role_in` | account → case | tracer, `confirm-incident` | attacker / accomplice / victim / cash_out_wallet / fake_token / contract |
| `flagged` | account → severity | firewall flags, cases | `critical`, with the reason as evidence |
| `pass_through` | account → `true` | manual, class rule | `wrap.near` |

Every edge keeps the fact fields: `source`, `confidence`, `evidence`, `by`, `valid_from` / `valid_to`. A query can ask for "edges a
person would accept" (`source ≥ trace`, `confidence ≥ 0.7`, still valid) and get a smaller, trusted graph.

### 5.3 What the graph must not do

The 2026-11-04 false drain was a **graph error**: money from two solvers was read as money from an exchange. So:

- **Hubs cut paths.** A walk (`funded`, `swept_to`, a case trail) does not cross an account whose class is `exchange`,
  `service/*` or `system`, or that has `pass_through`. It records the hub as an endpoint ("cashed out at Binance", "swapped
  through NEAR Intents") and stops. Two wallets paid by the same solver are **not** linked.
- **Labels do not spread along `funded`.** Being paid by an attacker does not make an account an attacker. Only `role_in` with
  a role, written by the tracer or a public report, does.
- **Derived facts can be undone.** A fact made from other facts stores `derived_from: [fact ids]`, `source` = the weakest source
  it used. When a case is cleared (`valid_to` set), everything derived from it closes too.

### 5.4 Storage and queries

Indexes on `ontology_facts`: `{subject, predicate, valid_to}`, `{object, predicate, valid_to}`, `{predicate, source}`.

| question | how |
|---|---|
| what is X and why | `whatIs(X)`: one lookup in `ontology_entities` |
| X's neighbours | `relationsOf(X, {predicate, direction})`: one indexed query each way |
| who is behind this contract | `controls` in, then `operated_by` / `member_of` of the controller |
| the whole case | every `role_in` → `inc:…`, plus the `funded` / `swept_to` edges between those accounts |
| where did the money go | walk `funded` out from the case accounts, ≤ 6 hops, stop at hubs (5.3) |
| is this receiver close to a known bad account | 2-hop walk, hubs cut, any `flagged` or attacker `role_in` (the firewall; within its 2.5 s budget, so batched with `whatIsMany`) |

Walks run in JS (breadth first, one batched query per hop, `whatIsMany` to cut hubs), not `$graphLookup`, because the stop rule
needs the resolved class of each account.

## 6. Migration, in small PRs

Each step keeps behaviour unless it says otherwise, and each has a check before it lands.

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

**The riskiest consumers** are the incident tracer (step 4: false hacks), the firewall (step 6: verdicts and latency), and the scanner gates (step 5: what the simulated wallet buys). Each moves only after its shadow comparison is clean.

## 7. Not in scope

- RDF / OWL / a graph database: MongoDB documents and one resolver give the benefit without a new system.
- Accounts on other chains: the fact shape allows chain-qualified ids later (the 1Click recipients, the attacker's ETH wallet in the Rhea case).
- Automatic discovery of new classes: the tree changes by hand, in this file and `src/ontology/classes.js`.
