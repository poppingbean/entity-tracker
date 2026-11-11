# TRON Funding Trace: `TVAmAYoZGBsUAwyvJgp7jwzrXgoCGatUmY`

**Network:** TRON
**Starting transaction:** [`0f4fa80c…722c`](https://tronscan.org/#/transaction/0f4fa80c2d5232d0ee821f3fec6ec33a68a209829cc1524cfdfb18c63c52722c)
**Goal:** Find the root of the funding line for the wallet that sent that transaction.
**Data source:** TronGrid public API (`api.trongrid.io`). All times are UTC.

## Result

The funding line ends at the TRON **genesis block (block 0)**. The wallet `TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm` was credited with **99,000,000,000 TRX** at genesis by a null placeholder sender (`0x000…000`), so nothing funded it. Chain data does not say who owns it.

## Funding path (newest → oldest)

At each hop, the funder is the sender of the wallet's earliest inbound transfer (TRX, TRC10 or TRC20).

| # | Time (UTC) | From → To | Amount | Transaction |
|---|---|---|---|---|
| 0 | 2026-11-05 12:04:20 | `TVAmAYoZGBsUAwyvJgp7jwzrXgoCGatUmY` → `TEAoW8AF2TMPzmhgiT49TzkRR2cSeEPWpn` (the starting transaction, a USDT `transfer` call) | 2,136.6 USDT | [`0f4fa80c2d5232d0ee821f3fec6ec33a68a209829cc1524cfdfb18c63c52722c`](https://tronscan.org/#/transaction/0f4fa80c2d5232d0ee821f3fec6ec33a68a209829cc1524cfdfb18c63c52722c) |
| 1 | 2026-05-25 15:22:15 | `TLaEy2f8TgabWL6wa36AoXKv4CewbazoGQ` → `TVAmAYoZGBsUAwyvJgp7jwzrXgoCGatUmY` | 300 USDT | [`6c911acf2ab4d3ddc0e7fa62a3628480a29e2ba7ffd8d5ccaccee5a3de8915ad`](https://tronscan.org/#/transaction/6c911acf2ab4d3ddc0e7fa62a3628480a29e2ba7ffd8d5ccaccee5a3de8915ad) |
| 2 | 2026-05-24 15:05:42 | `TQ6v4ZJck9AyRNBLRnRUQiwzrc95sm7FdX` → `TLaEy2f8TgabWL6wa36AoXKv4CewbazoGQ` | 10 USDT | [`6e5ce09618af6579c4f12e2bc6b36f8e0ab83556c1cd5640a221b55ce1f6b4ee`](https://tronscan.org/#/transaction/6e5ce09618af6579c4f12e2bc6b36f8e0ab83556c1cd5640a221b55ce1f6b4ee) |
| 3 | 2025-09-10 15:02:06 | `THD6JAhWj6EscpF2TR544VCHSUAi9qpZok` → `TQ6v4ZJck9AyRNBLRnRUQiwzrc95sm7FdX` | 10 TRX | [`eae033c89b84f759139c54c04105dec0ed9b10224157203f93299ced9d130897`](https://tronscan.org/#/transaction/eae033c89b84f759139c54c04105dec0ed9b10224157203f93299ced9d130897) |
| 4 | 2025-04-23 19:10:24 | `TS75DZw8Hwi7g92XsjUPdwN7xty47xW63Y` → `THD6JAhWj6EscpF2TR544VCHSUAi9qpZok` | 176 USDT | [`65d16dd71da1318a9f8377722ee53cdd92c5d14806e50ab49fc4224479fbf074`](https://tronscan.org/#/transaction/65d16dd71da1318a9f8377722ee53cdd92c5d14806e50ab49fc4224479fbf074) |
| 5 | 2024-12-13 06:24:12 | `TGUjZAuZogLTSkbtAaR3BxyyAjueSCxCzF` → `TS75DZw8Hwi7g92XsjUPdwN7xty47xW63Y` | 250 USDT | [`0156932a38ee994b82f94c1f857ab07ff3f70188ff37679d83c80f41d0d0498b`](https://tronscan.org/#/transaction/0156932a38ee994b82f94c1f857ab07ff3f70188ff37679d83c80f41d0d0498b) |
| 6 | 2024-07-12 01:14:45 | `TJ9itsSCsY4daQ3pRtEAEVpx2T14JJ24gy` → `TGUjZAuZogLTSkbtAaR3BxyyAjueSCxCzF` | 150 TRX | [`dbe64f7de84b97b140c9a6e7ed644bdca27cb9ed77afc06c5584bf16c5df8573`](https://tronscan.org/#/transaction/dbe64f7de84b97b140c9a6e7ed644bdca27cb9ed77afc06c5584bf16c5df8573) |
| 7 | 2024-04-23 20:18:06 | `TJbHp48Shg4tTD5x6fKkU7PodggL5mjcJP` → `TJ9itsSCsY4daQ3pRtEAEVpx2T14JJ24gy` | 89.8 USDT | [`d247dcda9ac241b16a55d346ba6e3e48fbc8e3e9e8b0e826d3b7d89d598b9c82`](https://tronscan.org/#/transaction/d247dcda9ac241b16a55d346ba6e3e48fbc8e3e9e8b0e826d3b7d89d598b9c82) |
| 8 | 2022-11-03 12:30:06 | `TM1zzNDZD2DPASbKcgdVoTYhfmYgtfwx9R` → `TJbHp48Shg4tTD5x6fKkU7PodggL5mjcJP` | 20 TRX | [`345c470fa912d0732b19e4a555e4a5258bdf5e91e23956074e9d72841903442f`](https://tronscan.org/#/transaction/345c470fa912d0732b19e4a555e4a5258bdf5e91e23956074e9d72841903442f) |
| 9 | 2018-08-29 08:56:12 | `TUrypQFdQNqCaaPYvE1Mo6ea6hwQh15qD5` → `TM1zzNDZD2DPASbKcgdVoTYhfmYgtfwx9R` | 1 TRX | [`bc885bc4810f4bdd558ee449a212274db1d4239a48f176774adcccc88e7eb952`](https://tronscan.org/#/transaction/bc885bc4810f4bdd558ee449a212274db1d4239a48f176774adcccc88e7eb952) |
| 10 | 2018-08-22 04:20:48 | `TMdDoWAAMdMooANGn97KA1Jp5gN1BmfxJv` → `TUrypQFdQNqCaaPYvE1Mo6ea6hwQh15qD5` | 5 TRX | [`1022dc4b4bc426e0c6eec7de0cd348a97212375183e9f0511b0e8828a91d1127`](https://tronscan.org/#/transaction/1022dc4b4bc426e0c6eec7de0cd348a97212375183e9f0511b0e8828a91d1127) |
| 11 | 2018-07-23 11:38:15 | `TMhCAJm7TXwXpDecjmLc6xTxyUGnBaCDCn` → `TMdDoWAAMdMooANGn97KA1Jp5gN1BmfxJv` | 1 TRX | [`21fc2783da341aee497de2a4050f1934ab07461fdc8127a8212dbaefe5df649e`](https://tronscan.org/#/transaction/21fc2783da341aee497de2a4050f1934ab07461fdc8127a8212dbaefe5df649e) |
| 12 | 2018-06-28 08:20:57 | `TYNhjDxQnZojBkaVdHeXLfswjyjC8LD3dy` → `TMhCAJm7TXwXpDecjmLc6xTxyUGnBaCDCn` | 1 TRX | [`c1fbc5e1372971245132c9f417c06ab7b08b6d6d2e6368039ed816729c0ba701`](https://tronscan.org/#/transaction/c1fbc5e1372971245132c9f417c06ab7b08b6d6d2e6368039ed816729c0ba701) |
| 13 | 2018-06-25 08:09:12 | `TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm` → `TYNhjDxQnZojBkaVdHeXLfswjyjC8LD3dy` | 1,000,000 TRX | [`b5e00062f46d67919ab8e7272ba326f6cafec44675875baa65cb4effb6ac5e43`](https://tronscan.org/#/transaction/b5e00062f46d67919ab8e7272ba326f6cafec44675875baa65cb4effb6ac5e43) |
| 14 | 2018-06-25 02:09:24 | `TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm` → `TSnjgPDQfuxx72iaPy82v3T8HrsN4GVJzW` (its first outgoing transaction) | 33,251,807,524 TRX | [`5281eb99b3cab6b3cb4777e6b070df936f2cb068163fb8f3959a1cd88733a4c2`](https://tronscan.org/#/transaction/5281eb99b3cab6b3cb4777e6b070df936f2cb068163fb8f3959a1cd88733a4c2) |
| **15 (root)** | **Block 0 (genesis)** | **null placeholder (`0x000…000`) → `TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm`** | **99,000,000,000 TRX** | [`788b4d0ca432b3d07f895dffe80429bf58398d0e86222460b07f9db38e238803`](https://tronscan.org/#/transaction/788b4d0ca432b3d07f895dffe80429bf58398d0e86222460b07f9db38e238803) |

## Notes

- **Root:** `TLLM21wt…` has no `create_time` in TronGrid. It is credited in the genesis block, so it has no funder. Chain data does not name the owner. The 99-billion-TRX genesis wallet is widely believed to be the TRON Foundation (Justin Sun) allocation, but I did not confirm that. Check Tronscan's address tag.
- **The loop I first hit:** my automated trace looped back to `TLLM21wt…` through `TB16q6kp…` → `TMeWat4Y…` → `TWsm8HtU…`. Those transfers (500,000 TRX out, then 100, 50 and 0.001 TRX back) all happened on 2018-06-25 to 06-29, after the genesis credit. They are not funding sources.
- **Weak links:** hops 9–12 are 1–5 TRX transfers. They could be dust or test transfers rather than real funding. Hops 1–8 carry meaningful amounts, 10 TRX to 300 USDT.
- **Not checked:** I did not look for exchange or entity labels on any address, and I did not check TRC20 internal transfers. The Tronscan API refused my requests.
- **Method:** each hop takes the earliest inbound transfer by timestamp across TRX, TRC10 and TRC20. A wallet funded by several parties at once could have a different "first" funder under another definition.

## Funding summary for `TVAmAYoZ…` (2026-05-25 to 2026-11-05)

| Funder | USDT transfers | USDT | TRX transfers (≥1 TRX) | TRX |
|---|---|---|---|---|
| `TN3CUfRt6jPQDDtXuLiFoudmTyMdGg5Cuh` | 44 | 514,980 | 23 | 11,950 |
| `TLaEy2f8TgabWL6wa36AoXKv4CewbazoGQ` | 1 | 300 | 2 | 180 |
| `TPkwniakmWv2LraH1q8Ts1KU9zaCMzERzY` | 1 | 180.19 | 1 | 443.17 |
| **Total** | **46** | **515,460.19** | **26** | **12,573.17** |

- The wallet also received about 832 dust TRX transfers under 1 TRX and 148 TRC10 token transfers. I did not tally them.
- It sent 1,306 USDT transfers out, totalling 489,146.47 USDT.
- **Gas:** it sends transactions using rented energy rather than its own TRX. It had 905 `DelegateResource` (ENERGY) transactions, each reversed by an `UnDelegateResource`. The delegators are `TTvP2t9Z7Vb5CupNF2DWMU2mZuCtSxZzau` (897) and `TNynLkCQmdVQ3kC9cFHWprEcDHiKQdoWaw` (8), each lending roughly 13,600–14,300 TRX worth of energy. The first was on 2026-06-05, the latest on 2026-11-06. I did not identify these wallets.

## Second branch: main funder `TN3CUfRt6jPQDDtXuLiFoudmTyMdGg5Cuh` (newest → oldest)

`TN3CUfRt…` supplied about 99.9% of the USDT and almost all the TRX, so I traced it with the same method. It reaches the same genesis root.

| # | Time (UTC) | From → To | Amount | Transaction |
|---|---|---|---|---|
| B1 | 2026-05-24 15:26:57 | `TNjTm5bAEz4FY4N2Yw8WTqN4ve1C9JbC4L` → `TN3CUfRt6jPQDDtXuLiFoudmTyMdGg5Cuh` | 5 TRX | [`91a7523e…ac4a`](https://tronscan.org/#/transaction/91a7523eb9565a079be356d977a8037fbc4d569991bfd40edbb15b51b645ac4a) |
| B2 | 2025-12-04 12:03:33 | `TJqwA7SoZnERE4zW5uDEiPkbz4B66h9TFj` → `TNjTm5bAEz4FY4N2Yw8WTqN4ve1C9JbC4L` | 9 USDT | [`2ce2582d…8123d`](https://tronscan.org/#/transaction/2ce2582de13b0f3b0e2b5d20d6d6e84d6f3984eb2968b832f9f6f9f965d8123d) |
| B3 | 2024-04-17 10:20:30 | `TDqSquXBgUCLYvYC4XZgrprLK589dkhSCf` → `TJqwA7SoZnERE4zW5uDEiPkbz4B66h9TFj` | 69,375,250 USDT | [`b799abb1…ee9c`](https://tronscan.org/#/transaction/b799abb1722e62292894e4787bd2bf2e1a286fbad1e1aaec0be9fd842242ee9c) |
| B4 | 2023-10-18 07:50:03 | `TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb` → `TDqSquXBgUCLYvYC4XZgrprLK589dkhSCf` | 1,000 TRX | [`fb4974c6…aa26`](https://tronscan.org/#/transaction/fb4974c6e9e12409f2c1b7e3fd668dc52882efd28918cb75792162ea86b4aa26) |
| B5 | 2018-11-15 09:43:03 | `TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9` → `TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb` | 8,888 TRX | [`0399c505…5be8`](https://tronscan.org/#/transaction/0399c505a92006b2b05427884e6850bde7bbccf7840746d5c55b400ef9b15be8) |
| B6 | 2018-08-10 09:01:45 | `TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX` → `TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9` | 1 TRX | [`74bab4e3…dfb8`](https://tronscan.org/#/transaction/74bab4e3e53ce6e9dfcf7d2d1148c2bd1ecf2e7e93a7c7662c111c8101e8dfb8) |
| B7 | 2018-06-29 09:50:30 | `TYNhjDxQnZojBkaVdHeXLfswjyjC8LD3dy` → `TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX` | 1 TRX | [`19af816a…798c`](https://tronscan.org/#/transaction/19af816a2842031d277eb1e2ea428f01b41de07850749b494938a47729a4798c) |
| B8 | 2018-06-25 08:09:12 | `TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm` → `TYNhjDxQnZojBkaVdHeXLfswjyjC8LD3dy` | 1,000,000 TRX | [`b5e00062…5e43`](https://tronscan.org/#/transaction/b5e00062f46d67919ab8e7272ba326f6cafec44675875baa65cb4effb6ac5e43) |
| root | Block 0 (genesis) | null placeholder → `TLLM21wteSPs4hKjbxgmH1L6poyMjeTbHm` | 99,000,000,000 TRX | [`788b4d0c…8803`](https://tronscan.org/#/transaction/788b4d0ca432b3d07f895dffe80429bf58398d0e86222460b07f9db38e238803) |

- **Same root:** both branches pass through `TYNhjDxQ…` (hop 12 in the first table, B7 here) and end at `TLLM21wt…`.
- **Large amount at B3:** `TDqSquXB…` sent 69 million USDT to `TJqwA7So…`. That size suggests an exchange hot wallet or an institutional wallet at or near that hop. I did not check labels, so this is only a pointer for where to look.
- **Weak links:** B6 and B7 are 1 TRX transfers, which may be dust or test transfers. B4 and B5 carry meaningful amounts.
- **Older funder:** `TN3CUfRt…` was funded on 2026-05-24, a day before `TLaEy2f8…` funded the wallet you started with. The two branches were set up around the same time.

## Third funder: `TPkwniakmWv2LraH1q8Ts1KU9zaCMzERzY`

`TPkwniak…` sent `TVAmAYoZ…` 180.19 USDT and 443.17 TRX (on 2026-09-12 12:03 UTC, tx [`9380c4fb…50e8`](https://tronscan.org/#/transaction/9380c4fbea40573a2202e4acb98cc1cd8b9c1ea88a22b4285061ab1c2c9f50e8) for the TRX). Its first funder is `TN3CUfRt…`, so it is not an independent source.

| # | Time (UTC) | From → To | Amount | Transaction |
|---|---|---|---|---|
| C1 | 2026-08-09 08:04:39 | `TN3CUfRt6jPQDDtXuLiFoudmTyMdGg5Cuh` → `TPkwniakmWv2LraH1q8Ts1KU9zaCMzERzY` | 500 USDT | [`88e3a8fa…18d4`](https://tronscan.org/#/transaction/88e3a8faa348cc48250f836c9ba29ee2b79c868b0ad31da49cc2def0d1dd18d4) |

From C1 the chain is identical to the second branch above (B1–B8, then genesis): `TN3CUfRt…` ← `TNjTm5bA…` ← `TJqwA7So…` ← `TDqSquXB…` ← `TWd4WrZ9…` ← `TMuA6Yqf…` ← `TAUN6Fwr…` ← `TYNhjDxQ…` ← `TLLM21wt…` ← genesis block.

Taken together, all three funders of `TVAmAYoZ…` trace back to the genesis wallet, and two of them (`TN3CUfRt…`, `TPkwniak…`) share one upstream path. Only `TLaEy2f8…` has its own path, via `TQ6v4ZJc…` and `THD6JAhW…`.

## All TRX transfers of 1 TRX or more received by `TVAmAYoZ…` (26)

| # | Time (UTC) | From | TRX | Transaction |
|---|---|---|---|---|
| 1 | 2026-05-26 12:46 | `TLaEy2f8…` | 150 | `d5511105fb3cf9ef2413336227b6d53e9cc8b93aed538da5b92a97c0b68a30f5` |
| 2 | 2026-06-05 13:11 | `TN3CUfRt…` | 200 | `09f098ca2bbd16d794ff502b3d4351b03fb2557c82501feb27184dec1482f06b` |
| 3 | 2026-06-11 14:34 | `TN3CUfRt…` | 200 | `ae628702ef77ae67c974c2f5681f17c84d093e8a59935beb7a77e864f5ecab5f` |
| 4 | 2026-07-02 13:41 | `TN3CUfRt…` | 100 | `04c9562b31160b2d74a14c7b1db756ec5d6f7cb1cc425e3a4f238ecb0e2714b9` |
| 5 | 2026-07-03 12:38 | `TN3CUfRt…` | 300 | `bbc0b7585d1621fa699e8d7de27d639c478f49caa800a05d45438d8211686110` |
| 6 | 2026-07-04 00:23 | `TN3CUfRt…` | 150 | `9055e0cbeeed89fdd59888cc1d775da4ccd03b8bac3046988469e0958dba61e4` |
| 7 | 2026-07-04 13:29 | `TN3CUfRt…` | 300 | `e4ecbbd786ac5cd48871c0c25dd37c270b5e232bd349ece57468b2c2f3612b1c` |
| 8 | 2026-07-08 17:40 | `TN3CUfRt…` | 200 | `8edfb8aa6a31619974e29776fde8b87eb10686364f81e3624338d0ecfad3d35f` |
| 9 | 2026-07-12 13:06 | `TN3CUfRt…` | 300 | `d0c6610ae0e43d312619f5e0e142ceb2203bd5efdd82d0a4b0d5faa156673945` |
| 10 | 2026-07-16 13:47 | `TN3CUfRt…` | 300 | `92189232bffbb37e6a1be8ae30a53784562bf9d751efdbc61133e610f07dfe1a` |
| 11 | 2026-07-25 13:53 | `TN3CUfRt…` | 50 | `7954f9200b614d97e2af4968c4c7e5e876a53da64708f0ca43cb0f85dee231ee` |
| 12 | 2026-07-25 14:13 | `TN3CUfRt…` | 100 | `4684d9c00fb93625d04503a0eaedc28b488a53ae05118d56b670942a2f417071` |
| 13 | 2026-07-26 13:10 | `TN3CUfRt…` | 300 | `f2c9754d39f72056ca7794ad7d53c4ad81677c55a3a278a75911a2f8aee3c684` |
| 14 | 2026-07-29 16:08 | `TN3CUfRt…` | 200 | `86ae1acde880b2256e6d51f5461b24b851a3161b3c1945cd5fb66598cdc62c0a` |
| 15 | 2026-07-31 04:59 | `TN3CUfRt…` | 100 | `a2e4c97c41b22d169c2f5e387ecb7bfde23f33d99ec624698850abe9354e2866` |
| 16 | 2026-07-31 08:42 | `TLaEy2f8…` | 30 | `71a65cea35cb3b24c07f7e40f5198575e9cb425625c87a3228fcdd1a9763b901` |
| 17 | 2026-07-31 09:17 | `TN3CUfRt…` | 200 | `4a3d3c0a13361ff39bdcf217664af79be9cbecf7ff9657d173ea8ddcbd7171d4` |
| 18 | 2026-08-01 13:09 | `TN3CUfRt…` | 200 | `32ee37e76312d4ce9f83fbd6e2aaf571bbd586500a26939d51c32ac190d2e392` |
| 19 | 2026-08-01 14:11 | `TN3CUfRt…` | 200 | `3e8b1cf102844763abc8728a172d2081f968dcb11a78b8492a20d25ee65eaa56` |
| 20 | 2026-08-03 13:20 | `TN3CUfRt…` | 400 | `31762d65d53f5b0be9b163406d29cc8466bf13304e9626a81cc84a8215dce2ce` |
| 21 | 2026-09-02 16:25 | `TN3CUfRt…` | 150 | `967bdfafa11792deb722a00168303bfbf1a9ff3383a1d9beaf4a63af222990ea` |
| 22 | 2026-09-12 12:03 | `TPkwniak…` | 443.17 | `9380c4fbea40573a2202e4acb98cc1cd8b9c1ea88a22b4285061ab1c2c9f50e8` |
| 23 | 2026-10-25 00:36 | `TN3CUfRt…` | 1,000 | `56610dda0cf0fb92c8e4858e0b7d5435682523d8e626bff71723e1d2e7dbccec` |
| 24 | 2026-10-28 22:52 | `TN3CUfRt…` | 2,000 | `392a4382c2b62fd31ec6842dcfb82afe69e8100c61ac5bbb15ceec2d44a1338d` |
| 25 | 2026-11-03 14:00 | `TN3CUfRt…` | 2,000 | `3d11912a00c04c01f35399923f98b2f4e8bf24dde8d2a996431db308b250dbbd` |
| 26 | 2026-11-05 12:40 | `TN3CUfRt…` | 3,000 | `94735cd83ac84350a7d125fa362f5a7d2335b55d194cfa728c92e9f73aa8fdd4` |

Total: 12,573.18 TRX. Seen in the TRX column, `TN3CUfRt…` also sent TRX on 2026-06-05 13:11, two minutes before the first energy delegation to the wallet at 13:13.
