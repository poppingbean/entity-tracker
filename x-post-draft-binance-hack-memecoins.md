# X thread draft: Binance hot-wallet drain money moving through 6 NEAR memecoins

Status: DRAFT, not posted. Check the [brackets] before posting. Every wallet is written out in full: no address is cut or shortened.

---

**1/**
On Oct 29, three Binance hot wallets on NEAR were emptied of ~12.41M NEAR (~$45.7M) into one new account.

We followed part of that money. It ends up inside six fresh memecoins on smithii, bought almost entirely by wallets the attacker funded. 🧵

**2/**
Attacker:
efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af

sent 117,197 NEAR in 8 transfers (from Nov 6) to the hub:
d368b0079b34b0700b650eed72417b66467020fde05b8bf8a1fc8a375dc84484

**3/**
The day before, the hub was seeded with drain money through:
woxixi.near → uixii.near → hub (618 NEAR)

**4/**
The hub sent ~84,600 NEAR to five fresh accounts (1 of 2):
85f0680ac65f94793877c17b87b4b526644a4219caee3c56ee47a4570da37129 (31,716)
e907855c9f35142d29811f286a9d047ded276b6b88eea96c1a9aaa7b01a81632 (20,287)

**5/**
(2 of 2):
c74b910582db56a4d784c56c2ff63e34801a5c3b42be0b0b0f034590468c694c (13,782)
58d03c8d194b3c39e64e1e949a8a2e8ab85cb365e1bf1178ff5828f4e882adc9 (9,707)
ff137d9f9206dcf31e63a03255c0d00c0cc8dedc26174c286975971c2c65049a (9,123)

**6/**
A smaller relay went hub →
96eb4cb6d330538588d8f4781df86fcaa52eec6c97c07d6392dbb51868080603 → cdvve.near →
9c0060831c9bd843ed94277b76d8b66393d845a0eec5ccd5d0956f31deee7dc5 → normalherb1811.near

**7/**
Over Nov 6–7, the five funders paid seven more buyer wallets in round 100 NEAR transfers (~12,400 NEAR):

deepkingdom2311.near
redlemon6015.near
weirdglove364.near
soliddress8221.near
greenmuseum9245.near
sharpicon3186.near
freejacket4246.near

**8/**
Two more paths, found by our ring scan:

hub → 42a790dc8319d1487be0c0a5799165bfed7bc81cb48069e8fb60e471f37c8600 (19,720 NEAR) → weirdglove364.near (20 × 100 NEAR, Nov 7)

**9/**
attacker →
24fbd6d8cf1c5344328cfafae979062b1528018c652a72f36d8b9352370bd45e (61,006 NEAR, Nov 8) →
narrowram4672.near (10,837) →
clearurial9207.near (5,620, Nov 9)

clearurial9207.near is the ninth buyer.

**10/**
The nine buyers spent that NEAR on six tokens (contracts):

$FUK fuk-3.smithii.near
$OLCCL olccl-4.smithii.near
$MEILI meili-5.smithii.near
$MMLI mmli-6.smithii.near
$DABI dabi-7.smithii.near
$SINU sinu-8.smithii.near

**11/**
99.7% of the buying in these six tokens came from nine wallets. All nine are funded from the attacker. In practice there were no outside buyers, so this was not trading.

Buying your own token with stolen NEAR is one way to turn traced money into "token sale proceeds".

**12/**
The six token creators are funded via an exchange hot wallet, so there is no traced payment from the attacker to them. We count them as *suspected*, linked by trading only.

**13/**
What we've done:
• all 22 wallets above are flagged high
• Safety Check / tx firewall warns on transfers to them
• the six creators are blacklisted in our scanner

Check any account: [link]
Full case with tx hashes: [link]

**14/**
Exchanges and launchpads: if any of these wallets deposit with you, please hold and check against the case.

@[Binance security handle, confirm before tagging] @[NEAR handle, confirm before tagging]

---

## Notes for review (not for posting)

- No wallet in the thread is shortened. The 64-character implicit accounts make posts 2, 4, 5 and 6 long, but every post is under 280 characters (links counted as 23).
- Figures come from `_edges.json` (indexer transfers > 0.05 NEAR). Hub → five funders: 31,716 + 20,287 + 13,782 + 9,707 + 9,123 = 84,615 NEAR. Funders → seven buyers: 12,419 NEAR. normalherb1811.near got 199.8 NEAR through the relay in post 6.
- The "Binance" label comes from the case's operator confirmation (no public source attached). If Binance has not said anything publicly, consider "three hot wallets labelled as Binance's".
- The $45.7M figure is at today's NEAR price, as the case reports it.
- The 99.7% / nine-wallet figure comes from the earlier token-holder analysis. Re-check it before posting if the tokens have traded since.
- The six creator accounts are not named (post 12), and the full addresses are not printed. If you decide to name them, use the full account IDs: smoothward1740.near (FUK, fuk-3.smithii.near), toughuni8251.near (OLCCL, olccl-4.smithii.near), sourbelt7061.near (MEILI, meili-5.smithii.near), sadfield5984.near (MMLI, mmli-6.smithii.near), swiftblog5330.near (DABI, dabi-7.smithii.near), thinos1181.near (SINU, sinu-8.smithii.near).
- The ninth buyer, clearurial9207.near, **is** traced to the hack (corrected 2026-11-10). Its first funding (majorjuice6994.near ← aggregatedex.near, 23,428 NEAR from Nov 8 13:46) is not hack money. But after the attacker paid 24fbd6d8… (from Nov 8 17:33), the money went 24fbd6d8… → narrowram4672.near (10,837 NEAR, Nov 8 19:19, almost all of narrowram's funding) → clearurial9207.near (5,620 NEAR in 6 transfers, Nov 9). Its 4,600 wNEAR MMLI buy may predate the hack money, so "funded from the attacker" is true of the wallet, not proven for that one buy.
- 42a790dc… is a sixth hub-funded account, missed by the hand trace and found by the ring detector. The hub → funders total is now 104,335 NEAR (84,615 + 19,720).
- 22 wallets are flagged: the 18 from posts 2–7, plus 42a790dc…, 24fbd6d8…, narrowram4672.near and clearurial9207.near.
