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

The verdict always comes from deterministic rules; the AI explanation can never change it. `context.complete: false` means some lookups (RPC, database) didn't answer within the 2.5 s budget. The verdict is then based on what was known; treat a missing fact as unknown, not safe.

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

## `GET /api/v1/account?id=<account>`

Reputation of one account, e.g. on a "send to" screen:

```json
{ "account": "animateui.near", "exists": true, "contract": false, "risk": "high",
  "flags": [{ "severity": "high", "reason": "a token creator on the dev-rug blacklist", "detail": "…" }],
  "label": null, "token": null, "audit": null, "complete": true }
```

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
