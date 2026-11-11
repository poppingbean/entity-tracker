# Wallet linking: what we measured (WP-13, Part A)

Written from `node src/cli.js link-eval` on the production data, 2026-11-11. The command reads the stored early wallets and their groups and changes nothing. **Part B (new linking signals) is not built**: there is no pair truth set to prove one would help.

## The numbers

| | |
|---|---|
| Early wallets looked at | 1,399 |
| In a group | 766 (55 %) |
| Pairs known to be one owner | **0** (two confirmed cases, but their accounts are not early wallets) |
| Pairs assumed to be different owners | 781 |
| Of those, grouped together | 50 |

So recall cannot be measured, and the precision of 0 is not a finding: see the next section.

### Early wallets in no group, by who funded them

| Funder | Wallets | In no group | Share |
|---|---|---|---|
| exchange or hub wallet | 501 | 299 | 60 % |
| relayer | 78 | 33 | 42 % |
| ordinary wallet | 768 | 267 | 35 % |
| unknown | 44 | 29 | 66 % |
| protocol | 8 | 5 | 63 % |

This is the one table to trust: it needs no truth set. A wallet funded from an exchange hub is the least likely to be linked to anything, which is the gap the README already names ("about a third of early wallets are funded from an exchange hot wallet and only link through hub twins"). Here it is 60 %, higher than a third.

## Why the precision of 0 does not mean grouping is wrong

The "different owners" set is pairs of wallets that only share an exchange hub as funder. Grouping links "hub twins" on purpose (the same odd withdrawal amount from the hub within an hour), so some of those 50 pairs may well be one owner. Two wallets sharing a hub does not make them different people. The set is too noisy to score precision.

## What a real truth set needs

1. Pairs of one owner, confirmed by hand: wallets one confirmed case lists as `sub_account` / `cash_out_wallet`, approved ring proposals, or hand labels of kind `group` (the ⚑ button).
2. Pairs of different owners from the golden set (`src/ontology/golden.json`), people with known separate identities, not "funded by the same hub".

Until there are a few dozen of each, `link-eval` prints "read as a first sign, not a measurement" and any new signal would ship unproven.

## Candidate signals (Part B, not built)

| Signal | Who it would reach | Evidence so far |
|---|---|---|
| Exchange deposit address (two wallets sending to the same per-customer deposit account) | the 60 % of hub-funded wallets in no group | none: needs the ontology class `exchange/deposit_address` to be populated first |
| Withdrawal twins, widened | hub-funded wallets | none |
| Longer look-back (60 → 300 transactions) | wallets with a long history | none |
| Deep links at 2 hops | ordinary-wallet-funded (35 % in no group) | none |

A signal ships only if pair precision holds and recall rises on a real truth set, each as its own PR with the `link-eval` output before and after.
