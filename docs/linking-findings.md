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

## Part B, first signal: exchange deposit addresses (2026-11-20, branch `ontology-coverage`)

Grouping already links early wallets that sent NEAR to the same non-generic destination (`shared_destination`). Of the 49 destinations behind such links today, 40 are implicit accounts; **13 of them pass the deposit-address rule** (they receive from outside and pass everything on to one exchange's wallets, repeatedly; `src/ontology/deposits.js`). How many accounts pay each one decides what it is:

| Depositors | Addresses | Read as |
|---|---|---|
| 2, 2, 2 | 3 | one customer's address |
| 3, 4, 4, 5, 6, 6 | 6 | one customer's address: in 4 of these 6, the wallets it links stay together through other links in their group (funding or transfers between them) |
| 14, 16, 18, 18 | 4 | a shared collection account: different people |

So the line is drawn at **six depositors** (`DEPOSIT.oneCustomerMax`): up to six, `exchange/deposit_address` ("CEX user wallet"), which keeps the link; seven or more, plain `exchange` ("Unidentified exchange wallet"), which cuts it like any exchange wallet.

**Effect on today's groups once the facts are written and grouping reads them:** the four shared collection accounts stop linking. Two groups rest on one of them alone (`c_efe96249`, 2 wallets, neutral; `c_5c728c75`, 2 wallets, unknown): two strangers who deposited to the same Binance collection account; they would be dissolved. In `c_0c06ef76` (4 wallets, bad) the wallets linked only through the address would leave the group; `c_d09b9b60` (29 wallets) stays together through other ties. That is a precision gain on four links, not a recall gain: the one-customer addresses were already linking (grouping treats an unknown account like a person).

**What this does not settle:** the threshold comes from 13 addresses; there is still no hand-confirmed pair set, so precision and recall cannot be scored (Part A). A group that loses members should be checked with the existing group replay before the change is turned on.

**Group replay** (2026-11-20, read-only: the groups rebuilt the way `evaluateGroups` does, with today's ontology and again with the shared collection accounts cutting links). Of 77 destinations paid by two or more early wallets, 18 pass the deposit-address rule: 9 one-customer addresses (kept) and 9 shared collection accounts (cut). Result: **183 groups become 180; 739 grouped wallets become 731; 4 groups change**: three small groups dissolve (3 wallets neutral, 2 neutral, 2 unknown: their only tie was a shared collection account) and one group of 4 rated bad loses one wallet and stays bad (3 wallets). No other group and no other verdict moves. The verdicts in the replay leave out the insider entries, the same way on both sides; the baseline itself differs a little from the stored groups (wallets profiled since the last regroup), so only the before/after difference is the measurement.
