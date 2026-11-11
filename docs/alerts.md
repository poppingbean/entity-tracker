# Alerts, watchlists and the Telegram bot

Back to the [README](../README.md).

## Detectors and delivery

Detectors run beside the worker loop every minute (`ALERTS_EVERY_SECONDS`) and raise each event once (`alerts`):

- **Rug in progress:** a token flagged rugged, its creator selling, the creator dumping its supply (dev-rug blacklist), a price collapse.
- **Contract changes:** code redeployed or a new full-access key (checked every 30 min for launches of the last 3 days, followed NFT collections and anything watched; state in `contract_state`).
- **Watched tokens:** large buys (`ALERTS_BIG_BUY_NEAR`, 25) and sells (`ALERTS_BIG_SELL_NEAR`, 25), the creator buying or selling, **large wallet-to-wallet transfers** (worth `ALERTS_BIG_TRANSFER_NEAR`, 250, or `ALERTS_BIG_TRANSFER_SHARE`, 1 % of supply; the creator moving tokens is high, a move to a known exchange is named), and a fast drop (`ALERTS_PRICE_DROP`, 30 % within an hour). Their trades are re-read every `ALERTS_WATCH_SYNC_MINUTES` (3). A launchpad recorded as a token's creator (nearly.trade buys back every hour) is not treated as the creator.
- **Watched wallets and groups:** buys and sells of 2+ NEAR (early buys in a new launch are said so), and a watched creator launching.
- **Ruggers launching again:** a creator that rugged before or is blacklisted launches a new token.
- **Gate pass:** a new launch passed every hard gate of the scanner (once per token, sent before the AI review): score, pool, market cap, buyers, price since the first trade, contract audit, early-buyer mix and the warnings (never a gate's threshold). It goes to every chat registered on the Telegram bot (any chat that tracks something; `/gatepass off` opts a chat out, `/gatepass on` back in), to watchlists holding the token or its creator, and to `TELEGRAM_GATE_PASS_CHAT_ID` if set (e.g. a channel; not the public alerts channel by default). `ALERTS_GATE_PASS=false` turns it off. Passing the gates is not a buy signal.
- **NFT:** the team (or wallets it funded) selling, suspected wash trades rising.

**Only fresh events are announced.** An activity alert fires only for an on-chain event of the last `ALERTS_MAX_AGE_MINUTES` (10); a rug or collapse is timed by the token's last trade. Anything older (read late, a backlog, downtime) is never sent to Telegram or webhooks and stays on the dashboard only. Watched tokens older than 3 days only alert when a rug flag turns on, never for a long-standing state (`token_flags`). Each alert carries its event time (`event_ts`, "🕒 06:41 UTC" in Telegram) and, when it is about one transaction, a link to it on NearBlocks (`tx_url`). The very first pass only records the current state, so a deploy does not flood anyone.

Anyone can keep a **watchlist** (`watchlists`) of tokens, wallets, groups, creators and NFT collections:

- **Dashboard:** ☆ Watch on any of those pages, or search on the **Monitoring** page. The search only offers what the tracker has (tokens it follows, with their current market cap so look-alike symbols are easy to tell apart; groups, wallets, creators, NFT collections), so an unknown token can't be watched. Kept with an anonymous key in the browser.
- **Telegram:** open [@safenear_bot](https://t.me/safenear_bot) (`TELEGRAM_BOT_NAME`), press Start and send `/watch <symbol or account>` (e.g. `/watch THREE`); `/unwatch`, `/list`, `/alerts`, `/check <token>`, `/gatepass off|on`, `/help`. One watchlist per chat (in a group, the whole group shares it). Long polling, no public endpoint. The Alerts page shows this guide.
- **API:** `POST /api/watch/key {"kind":"api"}` for a key, `POST /api/watch {"key","id"}`, `GET /api/alerts?key=…`, `GET /api/alerts?severity=high&group=rug` for everything, `GET /api/watch/pick?q=…` for what can be watched; POSTs need the header `x-tracker: 1`.

Delivery: alerts at `ALERTS_PUBLIC_SEVERITY` (high) go to the public Telegram channel (`TELEGRAM_CHANNEL_ID`) and the global webhook (`ALERTS_WEBHOOK_URL`); every alert goes to the Telegram chats and webhooks of the watchlists it concerns. Webhooks must be https on a public host (private, loopback, link-local, CGNAT and metadata addresses are refused, re-checked before every send, no redirects, 5 s timeout). Settings: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NAME` (default `safenear_bot`), `TELEGRAM_CHANNEL_ID`, `ALERTS_WEBHOOK_URL`, `ALERTS_PUBLIC_SEVERITY`, `PUBLIC_SITE_URL` (links in alerts), `ALERTS_ENABLED`, and the thresholds above.

