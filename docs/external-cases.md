# Hacks on other chains: the addresses Safe Near keeps, and what it does when one touches NEAR

Safe Near follows money on NEAR. Big hacks happen elsewhere (Bybit on Ethereum, Bitget on seven chains, Binance on ten), and their money is laundered through swap services and bridges, some of them on NEAR (NEAR Intents, the Omni bridge). Safe Near cannot trace those hacks, but it can **remember the addresses public reports named, with the source of each, and notice when one shows up on a NEAR route**. Nothing here is traced by Safe Near and nothing is invented: a case is only what the sources say.

## What is stored

One JSON file per hack in `src/incident/external/`:

| File | Addresses | Source |
|---|---|---|
| `bybit-2025-02-21.json` | 55: the attacker, two attack contracts, the victim's cold wallet, and the **51 the FBI listed** | FBI alert I-022625-PSA (read directly), DFNS |
| `bitget-2026-09-24.json` | 6: Bitget's four published attacker addresses (EVM, XRP, ZEC, TRON), the XRP address that deposited into NEAR Intents, and the BTC address it asked to be paid | Bitget's incident page, BlockSec, the public 1Click status API |
| `binance-2026-10-29.json` | 628: the FBI's list (608 Ethereum, 19 Bitcoin, 1 Solana) | the FBI alert (its page blocks automated reads: two community copies agree on the 608 Ethereum addresses) |

Each file says what was checked on NEAR Intents (`intents.checked`, also when nothing was found) and, for Bitget, what the Intents team did: SHIELD blocked more than $50M of attempted transfers, about $166K got through, about $503K was frozen, and the order the attacker did place was refunded.

`node src/cli.js external-case all --dry` validates the files and says what would change; without `--dry` it loads them:
- the case, in its own collection `external_cases` (apart from `incidents`: the tracer, the live follow and the Accuracy page score cases Safe Near detected, and a case it only read about would count as a miss);
- one ontology fact per address: `role_in` the case (attacker, laundering wallet, victim ...) and, for the attacker's side, `flagged` (critical; high for an address only named as a swap's destination). Reloading a changed file closes the facts it no longer contains. Ids are `eth:0x…`, `btc:…`, `sol:…`, `xrp:r…`, `tron:T…`, `zec:t…`.

`node src/cli.js external-list` lists the loaded cases.

## What Safe Near does with them

- **Safety Check, `what_is`, the agent tools:** paste any of these addresses (an XRP, Tron or Zcash address too; Solana needs `sol:`). The answer is *danger* when it is the attacker's or held the stolen money, *caution* when it was only the destination of a swap the attacker ordered, a plain note for a victim's wallet, with the case, the amount and the sources. An address in no case is "nothing known", never "safe".
- **When a NEAR Intents swap touches one (`src/incident/screen.js`):** every time Safe Near resolves a 1Click swap (the tracer's exits, the live follow of stolen funds, the money watch), the swap's addresses on the other chains (where the money came from, where it goes) are looked up. If one is on a hack's list, a `listed_address_swap` alert is raised once for that swap, saying which address, which hack and the swap's status. It is a lead, not proof about the whole swap.

## What it does not do

- It does not watch every NEAR Intents deposit or every bridge transfer. It sees the swaps Safe Near already resolves. Watching all of them needs the NEAR Intents explorer's API key (its public pages block bulk searches) or reading every 1Click status; that is a separate decision.
- Bridges: an Omni bridge transfer to an address on this list is not screened yet (the trail ends at a bridge exit).
- The FBI lists are a perimeter, not a map: the attackers used thousands of addresses. Elliptic's broader Binance blocklist (about 25,000 addresses) is not loaded.
- A source that could not be read directly is said so in the file (`notes`).

## Adding a hack

Copy a file in `src/incident/external/`, fill the sources first (id, publisher, link, what it says), then each address with its role, one sentence of evidence, the source id and a confidence between 0.3 and 0.95. `validateExternal` refuses a file without sources, a start time, a chain that Safe Near knows, an Intents note, or with an address listed twice. Only confirmed public cases are loaded: an unconfirmed claim belongs in a watch (`docs/money-watch-design.md`).
