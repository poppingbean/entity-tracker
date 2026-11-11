# Safe Near transaction firewall

Check a NEAR transaction **before the user signs it**. A wallet or dApp sends the transaction it is about to ask the user to sign. The firewall answers with:

- a **verdict** (`ok`, `caution`, `warn` or `block`);
- a plain-language line for every action ("Give FULL ACCESS to your account to key …", "Swap 5 wNEAR for ANIMATE on v2.ref-finance.near");
- the **findings** behind the verdict.

It is free, read-only (it never signs or sends anything) and needs no account.

- Base URL: `https://app.safe-near.org/api/v1`
- Cross-origin: allowed from any origin (`Access-Control-Allow-Origin: *`).
- Rate limit: 300 requests per 10 minutes per IP. Ask for an API key (`x-api-key` header) for server-side use at higher volume.
- Privacy: nothing about the transaction is stored. Only counters per verdict and finding type are kept.

## `POST /api/v1/tx/check`

Send **one** of these fields:

| Field | What it is |
|---|---|
| `transaction` | One transaction as JSON, in the wallet-selector shape (`{ signerId, receiverId, actions: [{ type, params }] }`) or the near-api-js / RPC shape (`{ signer_id, receiver_id, actions: [{ FunctionCall: {...} }, 'CreateAccount'] }`) |
| `transactions` | An array of the above (a batch the user will sign together; up to 20) |
| `transaction_base64` | Borsh bytes of an unsigned `Transaction`, base64 |
| `signed_transaction_base64` | Borsh bytes of a `SignedTransaction`, base64 |
| `delegate_base64` | Borsh bytes of a `SignedDelegateAction` (NEP-366 meta transaction, as sent to a relayer), base64 |

Optional fields:

- `signer_id`: the signer, when the JSON doesn't include it (wallet-selector leaves it to the wallet).
- `explain` (`true`): add a plain-language explanation written by the AI. This adds about 3–10 s; leave it off for the fast path.

Meta transactions are unpacked: the actions inside a `Delegate` are checked as their **sender**, because that is whose account they act on.

### Response

```json
{
  "version": "1.0",
  "verdict": "block",
  "risk": "critical",
  "summary": "Gives full control of your account.",
  "findings": [
    { "severity": "critical", "code": "full_access_key", "title": "Gives full control of your account",
      "detail": "Whoever holds key ed25519:6E8s… can move all your NEAR and tokens …", "tx": 0, "action": 0 }
  ],
  "transactions": [
    { "signer": "alice.near", "receiver": "alice.near",
      "actions": [{ "index": 0, "kind": "add_key", "text": "Give FULL ACCESS to your account to key ed25519:6E8s…" }],
      "findings": [] }
  ],
  "explanation": { "headline": "…", "explanation": "…", "advice": ["…"] },
  "context": { "complete": true, "accounts_checked": 1 },
  "value": { "near_usd": 3.58, "moves": [] },
  "checked_ts": 1793250000000,
  "took_ms": 220
}
```

**Verdicts** (from the worst finding):

| Verdict | Severity | What the wallet should do |
|---|---|---|
| `block` | critical | Show a full-screen warning; make the user type or hold to continue (or refuse). |
| `warn` | high | Show the findings prominently before the sign button. |
| `caution` | medium | Show the findings next to the sign button. |
| `ok` | info / none | Sign as usual (still show the action lines). |

The verdict always comes from deterministic rules; the AI explanation can never change it. `context.complete: false` means some lookups (RPC, database) didn't answer within the 2.5 s budget. The verdict is then based on what was known; treat a missing fact as unknown, not safe (the Agent Guard answers `ask_human` then).

**What it sends out (`value`).** Besides attached NEAR, a transaction can move tokens and NEAR Intents balances. `value.moves` lists them, valued at today's prices: `ft_transfer` / `ft_transfer_call` (any NEP-141 token, wNEAR included) and Intents `ft_withdraw`, `mt_transfer`, `mt_batch_transfer`, each as `{ tx, action, token, raw, to, via, symbol, amount, usd }` (`usd: null` when the token has no price). `value.near_usd` is NEAR's price, to value attached NEAR. A wallet can show "you are sending ≈ $500 of USDC"; the Agent Guard's USD limits count them.

### What it catches

| Code | Severity | When |
|---|---|---|
| `full_access_key` | critical | `AddKey` with full access on the signer's own account (the classic drainer) |
| `key_swap`, `lockout` | critical | Removing the signer's full-access keys (and adding someone else's) |
| `delete_account` | critical | `DeleteAccount` sending the balance to another account |
| `deploy_to_account` | critical / high | Code deployed on the signer's own wallet (critical if it had none) |
| `lookalike_receiver`, `lookalike_account` | critical | A name imitating a well-known contract (`wrap.nera`, `v2.ref-flnance.near`, `v2.ref-finance.near.claim.near`) |
| `flagged_receiver`, `flagged_account` | per flag | Accounts reported by hand, token creators on the dev-rug blacklist, creators with several rugged tokens, contracts whose audit found malicious code |
| `risky_contract` | high | The receiver's contract audit is high risk |
| `risky_token` | high / medium | The transaction trades or touches a token that rugged, whose creator dumped before, or whose audit is high risk (tokens inside swap messages included) |
| `nft_approval` | high | `nft_approve` to an account that is not a known marketplace |
| `grants_rights` | high | A method that grants spending, ownership or admin rights on an unknown contract |
| `drains_near`, `drains_token` | medium | Sending (almost) all of the signer's NEAR or a token |
| `tokens_to_unknown_contract` | medium | `ft_transfer_call` to a contract that is not a known DEX or app |
| `deposit_to_unknown` | medium | 1+ NEAR attached to an unknown contract |
| `unlimited_key` | medium | A login key with no fee allowance limit for an unknown contract |
| `no_such_account` | medium | The receiver doesn't exist (typo) |
| `ai_manipulation` | medium | The call data contains text aimed at AI or automated reviewers |
| `meta_transaction`, `new_account_key`, `binary_args` | info | Context only |

**The explanation.** The verdict and findings come from rules. The words (`explanation`) come from NEAR AI (`FIREWALL_EXPLAIN_MODEL`, default the analysis model), which is told what each other account is (its name, and the ontology's class, e.g. "a NEAR Intents solver") and can never soften the verdict.

**A known DEX or app** (which turns some of these warnings off): a contract users interact with every day (the built-in trusted list), one the [ontology](ontology-design.md) knows as a service from strong evidence (a hand label, the exchange registry, the contract audit), or a contract whose automated audit is low risk. An account name alone never makes it known: the account of a wallet-app user (`*.tg`, `*.user.intear.near`) is a person, so attaching NEAR to it is `deposit_to_unknown`.

**Addresses on other chains.** `GET /api/v1/inspect?q=0x…` (or `eth:0x…`, `btc:…`, `sol:…`) answers from the NEAR cases whose money was swapped out to that address: *danger* when a confirmed case sent money there, *caution* for a case being watched, otherwise "nothing known" (never "safe": Safe Near follows money on NEAR only).

## `GET /api/v1/entity?id=<account>`

What Safe Near calls an account (its [ontology](ontology-design.md)): the class, in words, why, what weaker evidence was overruled, and the account's edges in the knowledge graph (operator, sweeps, funding, cases it played a role in, groups):

```json
{ "account": "9c484fa5d2d0…c5c1", "class": "exchange/hot_wallet", "is": "an exchange hot wallet", "operator": "org:binance",
  "why": "sends its reserves to binancecold3.near", "source": "registry", "pass_through": false, "links_owners": false,
  "cases": [{ "case": "inc:efd224…", "role": "victim", "status": "confirmed" }], "overruled": [],
  "edges": [{ "from": "9c484fa5d2d0…c5c1", "predicate": "swept_to", "to": "binancecold3.near", "source": "registry", "evidence": "sends its reserves to binancecold3.near" }] }
```

`links_owners: false` means sharing this account (being paid by it, paying into it) says nothing about who owns two wallets.

## `GET /api/v1/account?id=<account>`

Reputation of one account, e.g. on a "send to" screen:

```json
{ "account": "animateui.near", "exists": true, "contract": false, "risk": "high",
  "flags": [{ "severity": "high", "reason": "a token creator on the dev-rug blacklist", "detail": "…" }],
  "label": null, "token": null, "audit": null, "complete": true }
```

## `GET /api/v1/inspect?q=<anything>`

The answer the **Safety Check** page gives, for whatever a user pastes: a wallet, a contract (any type), a token name or `$SYMBOL`, an NFT (`contract:token_id` or a marketplace link), a transaction hash, a NearBlocks / Pikespeak / Mintbase / Paras link, a website, a public key, or a transaction to sign (JSON or base64). Seed phrases and private keys are refused without being read.

```json
{ "input_kind": "website", "kind": "website", "verdict": "danger",
  "headline": "Do not use ref-flnance.com: it looks like a phishing site.",
  "points": [{ "level": "bad", "text": "The address imitates app.ref.finance, but it is a different site." }],
  "actions": ["Never type your seed phrase or private key into a website."], "facts": { "host": "ref-flnance.com" } }
```

`verdict` is `safe`, `caution`, `danger`, `unknown`, or `pending` (a contract seen for the first time is being audited: ask again in a minute). `points[].level` is `bad`, `warn`, `info` or `good`. Kinds: `wallet` (keys, connected apps, risky tokens held), `token`, `nft_collection`, `nft`, `contract`, `tx`, `unsigned_tx`, `website` (judged by its name, never fetched), `public_key`, `missing`, `secret`, `unknown`. Owner powers that are normal for a well-known contract (a stablecoin's freeze) give `caution`, not `danger`.

Two more fields when they apply:

- `incidents`: the hacks the input is linked to (from the incident tracer, see [incidents.md](incidents.md)). Each has `id`, `role`, `status`, `kind`, `attacker`, `target`, `stolen_usd`, `held_usd`, `when`, `headline`, `attack_type` and `exits` (USD per way the money left).
  - `role` is `attack_tx`, `attacker`, `fake_token`, `sub_account`, `contract`, `intents_account`, `cash_out_wallet`, `funder` or `target`.
  - A confirmed incident on the attacker's side makes the verdict `danger`.
- `investigate`: on a transaction where one account paid another at least `INCIDENT_MIN_USD` (net), `{ q, payout }`. Passing `q` to the incident tracer investigates it as a hack.

```json
{ "kind": "tx", "verdict": "danger", "headline": "This transaction is part of a hack: veax.near lost ~$62,379.",
  "incidents": [{ "id": "inc:realkingdom9695.near", "role": "attack_tx", "status": "confirmed", "target": "veax.near", "stolen_usd": 62379,
    "attack_type": "fake-token pool exploit", "exits": { "swapped to Ethereum": 53371 } }] }
```

The accounts of a confirmed incident are also in `firewall_flags`, so `POST /api/v1/tx/check` and `GET /api/v1/account` flag any transaction or account that touches them.

## The blocklist feed: `GET /api/v1/flags`, `GET /api/v1/flags/check`

For the services that can still stop stolen money (swap services such as NEAR Intents / 1Click, bridges, exchanges, wallets):

```
GET /api/v1/flags?since=0&min=high
→ { "updated_ts": 1793603180408, "count": 10, "next": "/api/v1/flags?since=1793603180408",
    "flags": [{ "account": "efd2242565…", "severity": "critical", "reason": "received the money drained from Binance's hot wallets on 2026-10-29 …",
                "incident": "inc:efd2242565…", "source": "incident", "ts": 1793603180408 }] }
```

- **Syncing.** Keep the last `updated_ts` and ask for `since` it. The response has an ETag; an unchanged list answers 304.
- **Severity.** `min` is `critical`, `high` (the default) or `medium`.
- **Quick check.** `GET /api/v1/flags/check?ids=a.near,b.near` (up to 100) answers `{ checked, flagged: { "<account>": { severity, reason, incident, ts } } }` before a swap or withdrawal goes through.

Accounts are flagged only by confirmed incidents (and accounts that receive money from them, as it moves) and by operator reports, never by a public report alone.

## `GET /api/v1/incidents`, `GET /api/v1/incident?id=<id>`, `GET /api/v1/incident?q=<anything>`

Confirmed hacks, newest first, and one incident in full: attacker accounts, target, losses, victims, the money trail and the NEAR AI write-up. `?q=` takes an account, a transaction hash, a NearBlocks link or a case id and answers with the confirmed case it belongs to and its role in it (`{ incident, role }`), `{ checked: true }` when it was looked at and nothing was confirmed, or `{}`; unconfirmed suspicions are never returned as hacks. See [incidents.md](incidents.md).

## Integrating

### A dApp or wallet using wallet-selector

```js
const FIREWALL = 'https://app.safe-near.org/api/v1/tx/check';

async function checkBeforeSigning(transactions, signerId) {
  try {
    const r = await fetch(FIREWALL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactions, signer_id: signerId }),
      signal: AbortSignal.timeout(4000),
    });
    return await r.json();
  } catch {
    return null; // the firewall is unreachable: fall back to the wallet's own confirmation screen
  }
}

// before wallet.signAndSendTransactions({ transactions }):
const check = await checkBeforeSigning(transactions, accountId);
if (check?.verdict === 'block' && !confirm(`Blocked: ${check.summary}\n\n${check.findings.map((f) => '• ' + f.title).join('\n')}\n\nSign anyway?`)) return;
```

### A wallet holding the borsh bytes

```js
const body = { transaction_base64: Buffer.from(transaction.encode()).toString('base64') }; // near-api-js Transaction
```

### curl

```bash
curl -s https://app.safe-near.org/api/v1/tx/check -H 'content-type: application/json' -d '{
  "transaction": { "signerId": "alice.near", "receiverId": "alice.near",
    "actions": [{ "type": "AddKey", "params": { "publicKey": "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", "accessKey": { "permission": "FullAccess" } } }] } }'
```

## Reporting an account

Operators add drainers and phishing contracts with:

```bash
node src/cli.js flag <account> critical "<reason>" "<detail>"
```

Every later check that touches that account carries the flag. Remove it with `node src/cli.js unflag <account>`.

## Limits and operator commands

Lookups run in parallel under a 2.5 s budget (`context.complete: false` when some didn't answer). Open to any origin, no password; 300 checks per 10 minutes per IP (`FIREWALL_PER_IP_10MIN`), unlimited with a key from `FIREWALL_API_KEYS` (`x-api-key`); bodies up to 2 MB (`FIREWALL_MAX_BODY_BYTES`). Nothing about a transaction is stored, only counters per verdict. `GET /api/v1/account?id=` gives one account's reputation for "send to" screens. Operators report accounts with `node src/cli.js flag <account> critical|high|medium "<reason>"` (`firewall_flags`; `unflag` undoes it), and `node src/cli.js check-tx '<json>'` runs a check from the command line.
