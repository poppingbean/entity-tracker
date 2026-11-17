# The ontology layer of NEAR: standards and databases we could build on

Status: research and recommendation, written 2026-11-17 (code freeze). **Stage 0 is built on the local branch `ontology-stage0`** (see section 9 of `ontology-design.md`); Stages 1 and 2 are not. Web claims were read from search results and a few pages; where a claim is unverified or sources disagree it says so. The question: Safe Near's ontology (`docs/ontology-design.md`) answers "what is this account?" for its own security work. What would make it a *real* layer that wallets, explorers, indexers and AI agents on NEAR can build on, and which standards and database should it sit on?

## 1. Where we are

A **fact** is a statement with its context: `subject`, `predicate`, `object`, `source` (ranked: manual > public_report > registry > audit > trace > behaviour > name_pattern), `confidence`, `evidence` (one readable line), `by` (the writer), `observed_ts`, `valid_from`, `valid_to`. Facts live in MongoDB (`ontology_facts`, about 26,000 with history), one resolved answer per account is cached (`ontology_entities`), and a graph of the live edges is kept in memory for live checks. The class tree has 5 top classes and 22 subclasses. ids are bare NEAR accounts, plus `eth:0x…`, `btc:…`, `xrp:r…` for other chains. Open to the world through `GET /api/v1/entity` and the MCP tool `what_is`.

This is already a *property graph of annotated statements with a resolution rule*. That is the shape the semantic-web world calls a reified statement with provenance. So the work is less "replace it" than "name things the way others do, so others can plug in".

## 2. What a shared layer needs, and what we lack

| Need | Today | Gap |
|---|---|---|
| **A global id for an account** | bare `alice.near`; `eth:0x…` | no canonical, chain-agnostic id; `eth:` is ambiguous (an EOA is the same on every EVM chain, a contract is not) |
| **A published vocabulary** | the class tree in code and a markdown doc | not machine-readable; no mapping to other label sets |
| **Statements with provenance a stranger can check** | `source`, `evidence`, `by` | free text evidence, no signature, no stable statement id others can cite |
| **Validation** | `invalid()` in code | rules not published; others cannot check their submissions |
| **Other people can add facts** | writers inside our code only | no public submission path; no trust model for outside attesters |
| **Bulk access and graph queries** | one account at a time (API), in-memory graph per process | no export, no query language, no way for an indexer to take the whole layer |
| **Coverage** | about 7,600 accounts (what Safe Near touches) | NEAR has millions; most classes could be read straight from chain state |

## 3. Standards: what to adopt, align with, or leave

| Standard | What it is | Fit | Use |
|---|---|---|---|
| **[CAIP-2 / CAIP-10](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-10.md)** | chain-agnostic chain and account ids. NEAR is `near:mainnet`, so `near:mainnet:alice.near`; Ethereum `eip155:1:0x…` | **adopt** as the canonical id | Keep our short ids internally, expose the CAIP-10 form beside them. A NEAR-specific namespace profile was not found in the CASA repository: we would propose one (account-id rules, the 64-hex implicit form, the `.near` suffix) |
| **[Open Labels Initiative (OLI)](https://github.com/openlabelsinitiative/OLI)** | a data model and public pool of address labels (`chain_id` as a CAIP-2 id, `address`, `tag_id`, `tag_value`), attested on Base through the Ethereum Attestation Service, with a trust model; about 170M labels mirrored by growthepie; EVM only | **align** and interoperate | Map our classes to OLI tag ids (`is_eoa`, `owner_project`, `contract_name`, `usage_category` and so on) and publish our NEAR labels in its format; NEAR is a gap in the pool. Their labels are community-made and "untrusted until weighted": our source ranking is the weighting |
| **[FollowTheMoney (OpenSanctions)](https://followthemoney.tech/explorer/schemata/CryptoWallet/)** | entity schemata used for sanctions data; `CryptoWallet` has `publicKey`, `blockchain`, `managingExchange`, `holder` (a LegalEntity), `custodyType`; 14,116 wallets listed in OpenSanctions | **align** for organisations and sanctions | Our `operated_by` is their `holder` / `managingExchange`; our `org:` nodes map to `LegalEntity`. Lets a compliance tool take the layer next to sanctions data |
| **[STIX 2.1](https://docs.oasis-open.org/cti/stix/v2.1/os/stix-v2.1-os.html)** | threat-intelligence exchange; `cryptocurrency-wallet`, an Indicator wrapping it with `confidence` (0 to 100) and `valid_from` / `valid_until` | **export target** | Our flagged facts and hack lists (`docs/external-cases.md`) export as Indicators for SOC tools. The validity window and confidence sit on the Indicator, which matches our fact fields |
| **[EthOn](https://github.com/ConsenSys/EthOn) and [BLONDiE](https://arxiv.org/abs/2008.09518)** | OWL ontologies of Ethereum (Account, Block, Transaction) and of several chains | **reference only** | They describe the chain's structure, not who owns an account. EthOn's account classes (EOA, contract) are the base for the `is_eoa` split; neither covers NEAR. Both are research-grade and slow-moving |
| **RDF 1.2 and [PROV-O](https://www.w3.org/TR/rdf12-semantics/)** | RDF 1.2 adds triple terms and a *reifier*, a node that carries annotations about a statement (provenance, confidence, time); PROV-O supplies the vocabulary (`prov:wasAttributedTo`, `prov:generatedAtTime`, `prov:invalidatedAtTime`) | **adopt as the data model for interchange** | Our fact maps one to one: the triple is (subject, predicate, object); the reifier holds source, confidence, evidence, writer, valid time. Status: sources disagree on whether RDF 1.2 is final or still a Candidate Recommendation (the W3C pages say Candidate Recommendation, September 2026); treat the details as still moving |
| **SKOS and OWL 2 (RL profile)** | SKOS for a class tree with `broader` and mappings (`exactMatch`, `closeMatch`) to other vocabularies; OWL RL for simple rule-based inference (subclass, disjoint classes) | **adopt for the class tree** | Publish the tree as SKOS with mappings to OLI, FtM and STIX; add OWL `disjointWith` (a person is not an exchange) so conflicts are detectable by a reasoner, not only by our code |
| **SHACL** | shapes that validate a graph | **adopt for validation** | Publish our `invalid()` rules and per-predicate constraints as shapes; SHACL 1.2 adds shapes for reifiers ("every annotated statement needs a source and a confidence"), which is exactly our rule. Status of 1.2 not confirmed |
| **JSON-LD** | JSON with a `@context` that gives the keys global meaning | **adopt for the API** | Add a `@context` to `/api/v1/entity` so each answer is already linked data, with no change for today's readers |
| **EAS attestations and NEP-413 signed messages** | signed claims (EAS on EVM, used by OLI); NEAR's message-signing standard for a NEAR account to sign a claim | **adopt for outside submissions** | An exchange signs "these are my hot wallets" with its own NEAR account; the source ranking treats a signed claim by the account's own operator as `manual`-grade. NEP-413 is a real NEAR standard (not re-checked here) |
| **Wikidata** | public identity of organisations | **link, do not copy** | An `org:binance` node carries a `owl:sameAs` to its Wikidata item so others can join on it |

**Not recommended:** inventing our own interchange format; copying EthOn wholesale; making Wikidata the store (no NEAR coverage, edit model unfit).

## 4. Databases

What we need from the store: millions of nodes and tens of millions of annotated statements, point lookups under 10 ms (live checks), multi-hop walks, history (`valid_to`), a way to export and publish, and a team that can run it. Safe Near today runs MongoDB Atlas and Node.

| Option | What it is | For | Against |
|---|---|---|---|
| **MongoDB (what we have)** | documents; indexed; `$graphLookup` for walks | already running, shared, we know it; fine for point lookups and moderate walks | no SPARQL or reasoning; deep walks are done in memory by our code; not a standard other tools read |
| **[Oxigraph](https://github.com/oxigraph/oxigraph)** | RDF triple store in Rust on RocksDB; SPARQL 1.1; RDF 1.2 triple terms behind a feature (the 0.5 line dropped RDF-star); latest 0.5.13 (22 Oct 2026); one binary or library | the lightest real triple store: a single process, no JVM; speaks the standards in section 3; good as a read model | the npm package is an in-memory WASM store (per its page), so on-disk use means running its server binary and calling it over HTTP; no built-in reasoning; project is small |
| **[TypeDB 3](https://en.wikipedia.org/wiki/TypeDB)** | a database whose schema is a type system with subtyping and inference; rewritten in Rust (3.0, Dec 2024); MPL-2.0 for the community edition; releases through Sept 2026 | closest to "ontology with rules": our class tree, role/relation types and rules like "a receiver paid only by a solver is not linked" become schema | TypeQL is its own language; not RDF or SPARQL, so no direct interchange with section 3; smaller ecosystem; adoption means a rewrite of the writers |
| **Property-graph servers: Neo4j, Memgraph, FalkorDB, ArcadeDB** | Cypher-style graph databases | strongest traversal speed and tooling; Neo4j's neosemantics plugin imports RDF | no ontology semantics; licences differ (Memgraph BSL 1.1, FalkorDB SSPL, Neo4j GPL or commercial); an extra server to run |
| **Embedded graph DBs** | Kuzu (archived 10 Oct 2025 after Apple bought it; community fork LadybugDB) | would fit a Node process | avoid for a new layer: the original is archived, the fork is community-run |
| **Large triple stores: Apache Jena Fuseki, GraphDB, Virtuoso, QLever** | mature RDF stores, some with OWL reasoning | most complete standards support, reasoning (GraphDB), speed on huge graphs (QLever) | JVM and operations weight; overkill at our size |
| **PostgreSQL (+ Apache AGE, or recursive queries)** | relational with optional graph extension | one well-known engine; SQL for everything; good for analytics and bulk export | graph and semantics bolted on; we would move off Atlas |

## 5. Recommendation: three stages, each useful alone

**Stage 0: name things the standard way (no database change).** Files and small code, all additive:
1. a **canonical id**: every answer carries `caip10` (`near:mainnet:alice.near`, `eip155:1:0x…`) beside today's id; split `eth:` into EOA-on-any-EVM-chain and per-chain contract ids;
2. the **class tree as SKOS/OWL** (a file in the repository) with mappings to OLI tag ids, FtM schemata and STIX types, and disjointness axioms;
3. **SHACL shapes** for facts, generated from the rules `invalid()` already enforces;
4. a **JSON-LD `@context`** on `/api/v1/entity`, and a bulk export: N-Quads (RDF 1.2 reifier form) plus a flat CSV or Parquet of facts, and an **OLI-format export** of our NEAR labels;
5. an **`is_eoa` / contract split** and an **`org:`** node with `owl:sameAs` to Wikidata.

**Stage 1: a real triple store as a read model (spike, then decide).** Run Oxigraph as a sidecar: a job projects `ontology_facts` into RDF 1.2 and loads it; Mongo stays the system of record, the in-memory graph keeps serving live checks. This proves the model against real SPARQL, gives indexers and AI agents a query endpoint, and costs nothing if dropped (the projection is rebuildable). Spike acceptance: load all facts and the external-case addresses; run ten real questions ("accounts within 2 hops of a flagged address", "all wallets of an exchange and what each swept to", "everything flagged critical in a case with its sources"); answer each in under a second; compare to Mongo plus our code on expressiveness and lines of code.

**Stage 2: only if Stage 1 shows a need.** Promote the triple store to system of record, or evaluate TypeDB if rules in code outgrow what SPARQL and SHACL express. Decide with the Stage 1 numbers, not before.

**In parallel, coverage and trust** (this is what makes it a layer, whichever store): writers on every block for classes readable from chain state (staking pools, factory children, DAOs, multisigs, tokens); the **NEAR Catalog API** (a third-party project reports it needs no key; not checked against NEAR Catalog's own docs) as a source of project to contract mapping; **signed submissions** (NEP-413) from exchanges and protocols for their own accounts; a public **submission API with evidence**; and a trust table of who may speak for whom, the equivalent of OLI's trust schema.

## 6. Findings that change today's code

- `eth:` ids conflate EOAs and per-chain contracts; fix when CAIP-10 ids are added.
- Our `evidence` is free text; give the common cases a structured field (source URL, transaction hash, block) so a stranger can follow it.
- The NEAR Intents explorer API is `GET /api/v0/transactions`, needs a partner JWT, and allows **one request every 5 seconds per partner** (per its documentation). A bulk screen of 25,046 addresses would take about 35 hours: so a layer that watches Intents must read the chain itself, not the explorer.
- OLI is EVM-only today: a NEAR label set in its format would be new to that pool.

## 7. Decisions for the owner

1. Stage 0 first, then the Stage 1 spike? (recommended: nothing in Stage 0 changes behaviour)
2. Is the aim to **publish** the layer (open export, submission API, OLI/STIX formats), or to keep it Safe Near's own with a better internal model? The first needs the trust and governance work in section 5.
3. Who may sign for an exchange or a protocol: only the account's own key, or also a named third party such as an investigator?
4. Should NEAR-specific vocabulary be proposed upstream (a CAIP-10 NEAR profile, OLI tags for NEAR classes)?

## 8. Stage 1 spike: first results (2026-11-17)

**Files checked by real engines.** Oxigraph 0.5.13 (npm, in memory) parsed `near-ontology.ttl`, `near-shapes.ttl` and an N-Quads export of sample facts without errors; a transitive query for the classes below `account` returned all 28; a closed fact was absent from the `live` graph; the organisations' Wikidata links read back. pyshacl 0.40.2 ran our shapes over the facts graph plus the vocabulary: **the 5 good facts conform; each of 7 deliberately bad facts is caught with the right message** (confidence above 1, an unknown source, a severity that is not one, a `role_in` with no role, an end before the start, an `is_a` that is not a class, a fact with no writer).

**Scale test on synthetic data** (a random graph shaped like ours: 40 % `funded` edges, 25 % `is_a`, a few flags; not our data; the npm package is an in-memory WebAssembly store, not the on-disk server):

| | 30,000 facts (about today) | 300,000 facts |
|---|---|---|
| quads (reified facts plus the plain `live` triples) | 285 thousand | 2.8 million |
| load time | **2.8 s** | **241 s** |
| process memory | 300 MB | 1.1 GB |
| point lookups (everything about one account, its facts with sources, a case's members, a class tree walk) | 0.1 to 0.2 ms | 0.1 to 1 ms |
| flagged accounts with their evidence | 0.6 ms | 2.2 ms |
| a join over a whole class and its flagged neighbours (Q9) | 3.7 ms | 84 ms |
| a filter over every fact by source and confidence (Q8) | 34 ms | 425 ms |

What this says: **queries are fast at our size and still fast at ten times it, except full scans, which grow with the data.** What it does not say is the load time at scale: ten times the facts took 86 times as long, so the in-process route is fine for a spike and not for production. The on-disk server (RocksDB, with its bulk loader) was **not measured**; that is the number that matters for the Railway service, and it needs the server binary. Question Q3 (two hops from a flagged account) returned no rows because the random graph has no such path; it was not tested.

**Not done:** the same questions on our real facts (the database was unreachable: the Atlas IP allow-list has lapsed again), and a comparison against Mongo plus our in-memory graph on the same questions.
