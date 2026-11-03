# Automated contract audits: review and design

Goal: **every contract deployed on NEAR mainnet is audited automatically, soon after it lands**, and the audit understands what kind of contract it is (token, liquidity pool, liquid staking, lending, DAO, bridge, NFT, launchpad, wallet contract …). It reports what can go wrong *for that kind of contract*, instead of applying token checks to everything.

## 1. What we have today

The audit (`src/audit/`, ported from our earlier backend) runs **on demand** for one account. It is triggered by the scanner (each launch it checks), the Contract audit page, on-demand token fetches and `node src/cli.js audit`. Results are cached for an hour in `audits`.

| Part | What it does | Limit for other contract types |
|---|---|---|
| Access keys (`nearFactors`) | Full-access keys = can redeploy or drain; no full-access key = locked (trust) | Universal and correct. But "locked" says nothing about an owner *account* (`set_owner`, `upgrade` guarded by an owner check), which is how real protocols are run. |
| Code (`staticAnalysis`) | WASM exports: fake NEP-145 `storage_*` (honeypot backdoor), privileged names, owner guards, non-standard methods | **Privileged-method and fake-storage detection only run for tokens** (`isToken ? … : []`; read-only `storage_*` views such as a DEX's `storage_constants` are not fake storage). The "standard" list is NEP-141 + storage only, so a DEX, staking or lending contract is entirely "non-standard". |
| Behaviour (`behaviourAnalysis`) | Do holders' sells into DEXs succeed; is a privileged account calling non-standard methods on holders' accounts | Token-only: it knows sells, nothing about withdrawals, unstaking, liquidations. |
| Tax | Launchpad `get_tax` | Token-only. |
| Scoring | One additive risk score + trust score | A flat score can't express "Ref Finance: the owner can upgrade, pause and take the protocol fee, but is a DAO; users can always withdraw". |

Two more gaps the review found:

- **Global contracts.** JustHoot v2 tokens (and more and more factories) deploy *shared* code once (`DeployGlobalContract`) and every new account just points at it (`UseGlobalContract`). The audit must read the code behind that pointer and audit it **once per code**, not once per account.
- **No source verification.** Only 7 of 18 well-known contracts publish NEP-330 metadata (`contract_source_metadata`: version and source link). LiNEAR, intents, omni bridge, SWEAT, the JustHoot and nearly.trade launchpads do; Ref, Burrow, Meta Pool, wrap.near, USDT, Sputnik DAOs, the oracle and staking pools don't. It is a useful trust signal (public code at an exact commit), but almost nobody lists their standards in it, so it can't be used to tell types apart.

## 2. Evidence: what real contracts look like

Exports read from mainnet code (`viewCode` + `WebAssembly.Module.exports`):

| Type | Sampled | Signature methods (what identifies it) | "Admin power" methods that are **normal** for it |
|---|---|---|---|
| AMM / liquidity pool | v2.ref-finance.near (170 fn), dclv2.ref-labs.near (138), veax.near (61) | `get_pool(s)`, `add_liquidity` / `remove_liquidity`, `swap*`, `mft_transfer`, `ft_on_transfer`, `withdraw` | `upgrade`, `set_owner`, `modify_total_fee`, `withdraw_owner_token`, `pause_contract`, `extend_guardians`, `create_pool_with_tax` |
| Liquid staking | meta-pool.near (95), linear-protocol.near (76) | `deposit_and_stake`, `unstake`, `withdraw_unstaked`, `ft_transfer` (stNEAR / LiNEAR), `get_st_near_price` / `ft_price`, `epoch_*`, staking-pool lists | `set_owner*`, `set_operator_account_id`, `add/remove_staking_pool`, `pause_staking`, `upgrade`, `migrate` |
| Validator staking pool | astro-stakers / epic.poolv1.near (28, identical code) | `deposit_and_stake`, `unstake`, `get_reward_fee_fraction`, `on_stake_action`, `vote` | `update_reward_fee_fraction`, `pause_staking` |
| Lending | contract.main.burrow.near (150) | `execute`, `margin_execute`, `oracle_on_call`, `get_asset_farm*`, liquidation callbacks | `update_price_oracle_config`, `update_asset_*`, `pause_contract`, `claim_prot_fee`, `upgrade` |
| Fungible token | wrap.near (15), usdt.tether-token.near (38), token.sweat (60), a JustHoot v2 token (69, global) | `ft_transfer`, `ft_total_supply`, `ft_metadata` | USDT: `mint`, `pause`, `upgrade`; SWEAT: ACL admins, `pause_features`, `set_restricted`; JustHoot: `set_transfer_fee`, `platform_upgrade` |
| NFT | nearnauts.near (11) | `nft_transfer`, `nft_token`, `nft_tokens_for_owner` | `nft_mint` by the owner |
| DAO | marmaj.sputnik-dao.near (33), sputnik-dao.near factory (20) | `add_proposal`, `act_proposal`, `delegate` | none: changes go through proposals |
| Bridge | factory.bridge.near (59), omni.bridge.near (127) | `finish_deposit` / `finish_withdraw*`, `deploy_bridge_token`, `get_bridged_token` | `force_withdraw`, `pa_pause_feature`, ACL admins, `set_locked_tokens` |
| Oracle | priceoracle.near (24) | `report_prices`, `get_price_data`, `add_oracle` | `add/remove_oracle`, `update_owner_id`, `upgrade` |
| Intents / router | intents.near (96), aggregatedex.near (38) | `execute_intents`, `mt_*`; `callback_swap`, `withdraw_from_amm` | intents: `force_lock_account`, `ft_force_withdraw`, `set_fee`; router: `withdraw_lost_fund` |
| Launchpad / factory | v2-launchpad.justhoot.near (115), nearlytrade.near (180), meme-cooking.near (49) | `on_pool_created`, `create_locker`, `claim_creator_fees`, `get_meme_stakes` | fee settings, upgraders, lockers |
| Perp / order book | asset-manager.orderly-network.near (94), spot.spin-fi.near (29) | `deposit_and_create_order`, `operator_execute_action`, `user_request_withdraw`, `swap_near` | operators, fee collectors, `set_root_state` |
| Lockup / vesting | lockup.near (6, factory) | `on_lockup_create` (the lockups themselves: `transfer`, `terminate_vesting`) | foundation `terminate_vesting` |
| Account contract (smart wallet) | `….craft.tg` accounts (HOT Craft), via the global contract `trading-zone-gc.tg` (3 exports, 115 KB) | `add_public_key` (adds an access key to the account itself), few exports, created in bulk by an app factory | `add_public_key`: whoever may call it can take over the account. **Account control** is the power that matters here. |
| JS / proxy contracts | x.paras.near, marketplace.paras.near (**1 export**) | can't be read from exports | — |

What this means for the design:

1. **The same method name means different things per type.** `force_withdraw` is a documented emergency path on a bridge, a rug tool on a meme token. `withdraw_owner_token` is Ref's way to recover stuck tokens. A multi-type audit must judge **who holds which power over users' funds, and what limits it** (a DAO or multisig owner, a timelock, no full-access key, pause-only), not flag scary names.
2. **Classification by exports works** for Rust contracts: each type has distinctive method sets. It doesn't work for JS contracts (one export) or proxies, which must stay "unknown", say why, and fall back to behaviour checks.
3. **A contract has standards and a role.** Meta Pool and LiNEAR *are* fungible tokens (stNEAR, LiNEAR) *and* liquid-staking protocols; Ref DCL is an AMM that also implements NFT positions and limit orders. The classifier must report the **standards it implements** (NEP-141, NEP-171, NEP-245, NEP-145) separately from its **role** (liquid staking, AMM, lending …), and the role decides the audit profile.
4. **The same code is deployed many times.** Staking pools (`poolv1` factory, identical code), Sputnik DAOs, lockups, launchpad tokens, wallet contracts and global-contract users all share code. Auditing **per code hash** makes most new deploys a cheap lookup.

**Classifier prototype.** A scorer over these method sets (required methods + supporting methods per type, role over standard) put **22 of the 29** sampled contracts in their type on the first pass. Of the 7 misses:

- 2 are factories (`sputnik-dao.near`, `lockup.near`) placed as "factory", which is correct: they create DAOs and lockups rather than being one.
- 2 are Paras JS contracts and 1 is `social.near`, expected to stay `unknown`.
- 2 looked like misses: Ref DCL as "order book" (that signature was too loose; fixed) and `nearnauts.near` as "multisig", which it actually is (the sample label was wrong).

After tightening (a role needs *all* its required method groups; protocol roles win over the token / NFT standards), the implemented classifier places every one of the 29 sampled contracts correctly; the 3 "unknown" are the 2 Paras JS contracts and `social.near`.

## 3. How many deployments

Measured on mainnet through FastNEAR neardata (with the API key). The chain makes ~1 block per second (~86,000 a day). Blocks older than ~11 h are served from an archive (1.5-8 s each); the live tip answers in under a second, and the key allows a catch-up of ~35 blocks per second before throttling.

- Block samples: 3 deploys in ~9,400 blocks (≈ 30 a day), all HOT Craft smart wallets (`….craft.tg` → global contract `trading-zone-gc.tg`).
- The tracker's own data: 279 launchpad tokens in 7 days (≈ 40 a day), each one a deploy; nearly.trade and JustHoot both deploy through **global contracts** now (`UseGlobalContract`).
- So NEAR sees **tens of new contracts a day**, mostly shared code. Auditing every one is cheap; most are a code-family lookup plus a few views.

## 4. Design

```
neardata blocks (tip, with API key)
   │  DeployContract / DeployGlobalContract / UseGlobalContract in successful receipts
   ▼
deploy watcher ──► contract_deploys (account, code hash, deployer, block, kind)  ── cursor in meta
   │
   ▼
audit queue (priority) ──► code audit: once per code hash (code_audits)
                         │   classify type · exports · privileged-power inventory · known families · NEP-330 source
                         └► account audit: per account (audits v2)
                             keys · owner & admins (from views / STATE) · type-specific reads (fees, oracle, pools, staking params)
                             deployer reputation (tracker: ruggers, blacklist, fresh account, funding) · behaviour
   ▼
findings + "admin powers" matrix + risk  ──► alerts · Contract audit pages · New contracts feed · transaction firewall · API
```

### 4.1 Deploy watcher

- Follows the chain tip through neardata with the FastNEAR key. Tip blocks are fast (~1 s); blocks older than ~11 h come from an archive (1.5–8 s each), so the watcher must keep up rather than catch up. It saves its height in `meta` and after downtime reads at most N hours back.
- Takes `DeployContract`, `DeployGlobalContract` and `UseGlobalContract` from **successful** action receipts and records the account, deployer (predecessor and signer), code hash, whether the account was created in the same receipt, and the block and time.
- Code hash: for `DeployContract`, from `view_account` after the block (the action carries the code itself); for `UseGlobalContract`, the hash or account it points to.
- Re-audit triggers that already exist for alerts (`contract_state`: code hash and full-access keys of watched contracts) move here, so a redeploy of *any* contract is caught, not only watched ones.

### 4.2 Code audit: once per code hash (`code_audits`)

- **Exports and classification.** A type scorer over the method sets in §2: each type has required and supporting methods. The best score wins if it is clear enough; otherwise `unknown`. NEP-330 `standards` are used when present, and a known code hash (staking pool, Sputnik DAO, lockup, launchpad token template) decides directly.
- **Families.** Same code hash = same family. The first audit is the expensive one; every later deploy of that code inherits it ("1,284 accounts run this code; 3 of them rugged").
- **Power inventory.** Every non-view export is mapped to a *power*: `upgrade` (replace code), `account_control` (add or remove access keys on the account itself: `add_public_key`, `add_full_access_key`), `move_user_funds` (force_withdraw, seize, burn_from, set_balance, fake storage), `freeze` (pause, blacklist, lock_account), `mint`, `set_fees`, `set_oracle`, `set_admins`, `emergency_withdraw` … The table is per type: the same name maps differently on a bridge and a meme token, and type-normal powers are noted, not flagged.
- **Honeypot and backdoor patterns** stay critical everywhere: fake NEP-145 storage methods, privileged calls on holders, owner-only guards on non-standard methods.

### 4.3 Account audit (`audits` v2)

- **Control:** full-access keys, the owner / admin / guardian accounts the contract names (common views: `get_owner(_id)`, `owner`, `acl_get_admins`, `get_guardians`, `get_operator_account_id`, and STATE as today), and **what those owners are**: a Sputnik DAO, a multisig, a locked account, or a single wallet (and that wallet's reputation in the tracker).
- **Type checks** (reads through views, no transactions):
  - AMM / pools: fee ranges, pool count, owner-only pool creation with tax, guardians.
  - Liquid staking: share price vs staked NEAR, operator and treasury owners, validator list, paused.
  - Validator pool: reward fee, paused, owner.
  - Lending: oracle configured (and fresh), asset limits, pause operator.
  - Token: supply, mint power, transfer fee or tax, holders concentration (existing).
  - Bridge: paused features, admins.
  - DAO: policy (who can do what, quorum).
  - NFT: mint power, approvals.
- **Deployer reputation**, from what the tracker already knows: creator on the dev-rug blacklist, creators with rugged launches, fresh account, funding chain, earlier contracts by the same deployer, same code family.
- **Behaviour,** a light first version per type: recent failed user withdrawals or unstakes (the honeypot test, generalised), admin calls on users' accounts, recent upgrades and owner changes.

### 4.4 Result shape

One audit per account: `type` (+ confidence), `family` (code hash and how many accounts share it), `control` (keys, owners and what they are), `powers` (each with who holds it and how it is limited), `findings` (severity, title, detail, evidence), `risk` (low … critical) and `trust`, `source` (NEP-330 link). The existing risk / trust scores keep working for tokens; for other types the verdict comes from the findings, so a DAO-governed upgradeable AMM is not "critical".

### 4.5 Where it is used

- **Alerts:**
  - a new contract deployed by a known rugger or blacklisted creator;
  - a new contract with a backdoor;
  - a redeploy that adds a dangerous power;
  - a watched contract's owner changing.
- **Transaction firewall:** the receiver's audit is already there when a user is about to sign, so new, unseen contracts get a real verdict instead of "unknown".
- **Contract audit pages:** the type, control and power matrix; a **New contracts** feed (latest deploys, filter by type and risk).
- **API:** `GET /api/v1/contract?id=` for wallets and dApps, next to the firewall.

### 4.6 Cost control

- Classification and power inventory happen once per code hash; repeat deploys are a lookup plus a few views.
- Priority queue: contracts that hold or receive value first (tokens with pools, contracts users call); idle one-off deploys later. Behaviour reads are skipped for contracts with no transactions.
- AI is optional and only for contracts the rules can't place (unknown type, high-risk findings): a short plain-language summary with the untrusted-data guard and rule floor already used elsewhere.

### 4.7 Where the AI works

Rules do the screening: they are fast, cheap, explainable and can't be talked out of a finding. The AI goes where rules run out: **unfamiliar code, unfamiliar names, and writing**. Because audits are per code hash and only a handful of *new* codes appear a day (launchpad tokens share templates), even deep AI reviews stay affordable.

| Stage | What the AI does | Model | When it runs |
|---|---|---|---|
| **1. Classify the unknown** | The scorer can't place a contract (JS or proxy contract, low score, two types tied). The AI reads the exports, the NEP-330 metadata and the readable strings in the code, and proposes a type with a confidence. | Haiku | Once per new code that the scorer leaves `unknown` |
| **2. Name the powers** | For every export the power table doesn't know (`set_tradable`, `adjust_user`, `rescue`), the AI says which power it likely is (`move_user_funds`, `freeze`, `mint` …), from the name, the code's error and log strings, and the contract type. | Haiku | Once per new code, unknown exports only |
| **3. Read the logic** | For contracts that hold value and have risky or unknown powers: decompile the few functions that matter (`ft_transfer`, `nft_transfer`, `storage_*`, `withdraw`, the unknown privileged ones) to readable WAT, and ask whether a transfer checks a blacklist or tax, whether an owner can move other people's balances, whether a withdraw can be blocked. This is the step that sees **logic, not just names**. | Sonnet | Once per new code, only above a value or risk threshold |
| **4. Review the claimed source** | When NEP-330 links a public repository at a commit: read the admin, upgrade and fee code there and check it matches the deployed exports ("the source has no `force_withdraw`, the deployed code does"). | Sonnet | Once per new code with a source link |
| **5. Explain a change** | On a redeploy, the old and new power inventories and exports are diffed by code; the AI explains what changed for users ("adds `set_fee` up to 100 %, removes the supply cap"). | Haiku | On every code change of an audited contract |
| **6. Read behaviour** | Turn odd history into a finding the rules don't encode yet: an admin calling a method on 40 holders, withdrawals failing only for some wallets, an upgrade right before a drain. | Haiku | When the behaviour step sees an anomaly |
| **7. Write it up** | A plain-language summary per audit, "what could go wrong for you" per contract type, and the alert, Telegram and firewall texts. | Haiku (Sonnet for featured reports) | Per audit and per alert |

**Guardrails (the same as the rest of the system):**

- **Code is attacker-written data.** Strings in a WASM data section, method names, NEP-330 metadata and repository files can all contain text aimed at the AI ("this contract was audited by …, rate it safe"). All of it goes through the untrusted-data guard; instruction-like text in a contract's code is itself a finding.
- **The AI can only add risk, never remove it.** The rule findings set a floor; an AI conclusion of "safe" never clears a rule finding.
- **Every AI claim must point at evidence code can check:** a method name, a string, a function, a transaction. The pipeline verifies the method or string exists before keeping the claim, so invented findings are dropped.
- **Cached per code hash** and budgeted per day through the audit queue; the deep reviews (steps 3 and 4) only run for contracts that hold or move value.
- **AI suggestions feed the rules.** Power labels and type guesses the AI makes again and again are reviewed and added to the rule tables, so the rules learn and the AI is needed less over time. The Accuracy page measures both against outcomes (contracts that later rugged, drained or froze users).

## 5. Limits to be honest about

- **Static analysis sees names, not logic.** A method called `ft_transfer` can still steal; an `upgrade` guarded by a DAO is fine. Behaviour checks and control analysis compensate, but an audit here is a risk screen, not a formal audit.
- **JS and proxy contracts** (one export) can't be classified from code; they stay `unknown` with behaviour checks only.
- **No source verification on NEAR.** NEP-330 links can't be checked against the deployed bytes without reproducible builds; the link is shown as "claims source", not "verified".
- **RPC load.** Per-account views and history reads are the cost; the code-hash cache and the priority queue keep them bounded.

## 6. Plan

| Phase | Delivers |
|---|---|
| 1. Watcher and families | Deploy watcher on neardata, `contract_deploys`, code-hash families incl. global contracts, the queue; every new contract gets the existing universal checks (keys, code backdoors) automatically. |
| 2. Classifier and powers | Type scorer from exports and known hashes, the power inventory per type, control analysis (owners: DAO / multisig / wallet), the new result shape; token audits keep working. |
| 3. Type checks | Views per type: AMM, liquid staking, validator pools, lending, bridge, DAO, NFT, launchpad. Deployer reputation from the tracker. |
| 4. Behaviour and AI | Failed withdrawals and unstakes, admin calls on users, upgrade and owner-change history; the AI stages from §4.7 (unknown types and powers first, then logic and source reviews for contracts holding value). |
| 5. Product | New contracts feed, audit page v2, alerts, firewall integration, `/api/v1/contract`. |

Each phase is useful on its own: after phase 1 every new contract is screened for the patterns we already catch.

## 7. What is implemented

| Part | Where | Notes |
|---|---|---|
| Deploy watcher and queue | `src/audit/watcher.js` | Follows the tip every `AUTO_AUDIT_EVERY_SECONDS` (15) beside the worker loop; `contract_deploys`, `audit_queue` (new code first, 3 retries); catches up at most `AUTO_AUDIT_MAX_BEHIND_BLOCKS` after downtime. |
| Classifier | `src/audit/classify.js` | Standards (NEP-141/148/171/178/199/245/145/330) and role (16 roles incl. account contracts, NFT marketplaces, farms, lockups). |
| Power inventory | `src/audit/powers.js` | 10 powers, severity per role (`normal_for_role`), unknown write methods listed for the AI. |
| What the code can do | `src/audit/wasm.js` | Decompiles with `wabt` and walks each export's call graph to the NEAR host functions it reaches; near-sdk's generic promise runner is recorded, not entered. Gives the *hidden power* (a harmless-sounding method that deploys code, adds keys, deletes the account) and *unguarded power* (a power method that provably never reads the caller) findings. |
| Control | `src/audit/control.js` | Keys, owner / admin / guardian views (incl. paged near-plugins ACLs and config structs), DAO policies, STATE; each controller typed (DAO, multisig, locked contract, wallet) with its tracker record. The owner decides: a DAO or multisig owner governs the contract even with wallet guardians. |
| Type checks and behaviour | `src/audit/checks.js` | NFT (media on a mutable server, owner's share, royalties, no supply cap), validator pools, liquid staking (share price), DAO (council size), bridge (paused); admin calls on users and withdrawals failing for many wallets. |
| Claimed source | `src/audit/source.js` | Fetches the NEP-330 repository at its commit; deployed methods missing from it (macro-made ones excused) are a finding; admin-function excerpts go to the AI. |
| Findings | `src/audit/findings.js` | Powers adjusted by who holds them; flagged owners / deployers; backdoors; one level. |
| AI | `src/audit/ai.js` | Code review (Haiku: type, labels for unknown methods, needs confidence ≥ 0.6, capped at medium), deep review (Sonnet: capability map, source excerpts, behaviour; only cited evidence kept, never critical), redeploy explanation, write-up; daily budget `AUTO_AUDIT_AI_PER_DAY` (`src/ai/tools/budget.js`). The prompts are `src/ai/prompts/audit-*.md`. |
| Orchestration | `src/audit/auto.js` | Code audits per code (`code_audits`, `AUTO_AUDIT_V`), account audits in `audits.auto`; the token audit still runs and is kept. |
| Uses | alerts, firewall, API, pages | `contract_risk` and `contract_power_added` alerts; strong findings become firewall flags and unknown contracts are queued; `GET /api/v1/contract`; New contracts feed, audit page v2, NFT contract-safety card. |

Measured on real contracts: Ref, DCL, Veax, Meta Pool, LiNEAR, two staking pools, Burrow, wrap, USDT, SWEAT, a JustHoot token, a Sputnik DAO and its factory, two bridges, the oracle, intents, the aggregator, launchpads, Orderly and Spin, a multisig, NFT collections (Cosmic Kats, Khugati AI) and HOT Craft smart wallets. 20-90 s per new contract with the AI stages; a repeat of known code is a lookup plus a few views.
