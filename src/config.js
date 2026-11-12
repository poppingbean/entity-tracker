// Configuration. Everything comes from .env / the environment. There is no wallet and no private key anywhere in this project.
import 'dotenv/config';
import { readFileSync } from 'node:fs';

/**
 * The Academy's business rules (academy-business.json: prices, the revenue split, limits; docs/academy-business.md). Accounts may be set
 * from the environment instead (ACADEMY_TREASURY …); the agent's signing key only ever comes from the environment (ACADEMY_AGENT_KEY).
 */
function academyBusiness() {
  let r = {};
  try { r = JSON.parse(readFileSync(new URL('../academy-business.json', import.meta.url), 'utf8')); } catch {}
  const e = process.env, list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
  return {
    ...r,
    enabled: e.ACADEMY_BUSINESS != null ? e.ACADEMY_BUSINESS === 'true' : !!r.enabled,
    treasury: e.ACADEMY_TREASURY || r.treasury || '',
    agent_account: e.ACADEMY_AGENT_ACCOUNT || r.agent_account || '',
    reserve_account: e.ACADEMY_RESERVE_ACCOUNT || r.reserve_account || '',
    contributors: e.ACADEMY_CONTRIBUTORS ? list(e.ACADEMY_CONTRIBUTORS) : r.contributors || [],
    agent_key: e.ACADEMY_AGENT_KEY || '',
    oneclick_jwt: e.ACADEMY_ONECLICK_JWT || '',
  };
}

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(String(v)));
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);
const nums = (v, d) => list(v, d.map(String)).map(Number).filter((x) => x > 0).sort((a, b) => a - b);

export const config = {
  mongo: { uri: process.env.MONGODB_URI || '', dbName: process.env.MONGODB_DB || 'near_entity_tracker' },

  ai: {
    // one key, or several separated by ';' or ',': a key out of credits or refused is set aside and the next one is used (ai/tools/nearai.js)
    keys: String(process.env.NEAR_AI_API_KEY || '').split(/[;,]/).map((k) => k.trim()).filter(Boolean),
    get key() { return this.keys[0] || ''; },
    baseUrl: (process.env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/+$/, ''),
    // scanner analyst and group reviews: Claude Haiku 5.5 served by NEAR AI (fast, many calls); the token analysis write-up uses analysisModel
    model: process.env.NEAR_AI_MODEL || 'anthropic/claude-haiku-5-5',
    timeoutMs: num(process.env.NEAR_AI_TIMEOUT_SECONDS, 120) * 1000,
    // token analysis write-ups: Claude Sonnet 5.5 served by NEAR AI (group reviews keep `model`); streamed, so a long answer is not cut at 300 s
    analysisModel: process.env.NEAR_AI_ANALYSIS_MODEL || 'anthropic/claude-sonnet-5-5',
    analysisTimeoutMs: num(process.env.NEAR_AI_ANALYSIS_TIMEOUT_SECONDS, 600) * 1000,
    maxTokens: num(process.env.NEAR_AI_MAX_TOKENS, 4000),
    analysisMaxTokens: num(process.env.ANALYSIS_MAX_TOKENS, 12000), // the token analyst writes a full report and a post
    groundingRetry: process.env.AI_GROUNDING_RETRY !== 'false', // a write-up quoting an account or number that is not in its evidence is asked again once; false = only mark it
  },

  rpcUrls: list(process.env.NEAR_RPC_URLS, ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com', 'https://near.drpc.org']),
  httpTimeoutMs: num(process.env.NEAR_HTTP_TIMEOUT_SECONDS, 30) * 1000, // one NEAR RPC / FastNEAR / indexer request; a stalled one is retried
  txIndexerUrl: process.env.FASTNEAR_TX_URL || 'https://tx.main.fastnear.com',
  fastnearApiUrl: process.env.FASTNEAR_API_URL || 'https://api.fastnear.com',
  fastnearApiKey: process.env.FASTNEAR_API_KEY || '',
  githubToken: process.env.GITHUB_TOKEN || '', // optional: raises the GitHub API limit for source reviews (60 / h without)

  launchpads: list(process.env.LAUNCHPADS, ['nearlytrade', 'justhoot', 'memecooking']),
  pollSeconds: num(process.env.POLL_SECONDS, 10),

  entry: {
    windowMinutes: num(process.env.ENTRY_WINDOW_MINUTES, 10),
    maxBuyers: num(process.env.ENTRY_MAX_BUYERS, 60),
    minNear: num(process.env.MIN_ENTRY_NEAR, 1),
  },
  outcome: {
    minutes: nums(process.env.OUTCOME_MINUTES, [60, 360, 1440]),
    rugDrawdown: num(process.env.RUG_DRAWDOWN, 0.9),
    roundTripPeak: num(process.env.ROUND_TRIP_PEAK, 3),          // a token that pumped to this multiple of its launch price ...
    roundTripBack: num(process.env.ROUND_TRIP_BACK, 1.25),       // ... and is back at or below this multiple of it counts as a rug (round trip)
    creatorExitShare: num(process.env.CREATOR_EXIT_SHARE, 0.8),  // creator sold this share of their dev buy within the first hour ...
    creatorExitBack: num(process.env.CREATOR_EXIT_BACK, 1.5),    // ... and the price is at or below this multiple of the launch price = rug (creator exit)
    softRugDrawdown: num(process.env.SOFT_RUG_DRAWDOWN, 0.7),    // a fall this deep counts as a rug when the creator also sold at least 1 NEAR
    creatorSellRugNear: num(process.env.CREATOR_SELL_RUG_NEAR, 0), // any creator sale above this many NEAR makes the token a rug (creator sold) ...
    creatorSellRugDays: num(process.env.CREATOR_SELL_RUG_DAYS, 30),  // ... within this many days of launch (a creator selling a little two years on is not a rug)
    crashDays: num(process.env.RUG_CRASH_DAYS, 7),                   // a crash is a rug only when the price got that low within this many days of its peak (not a long decline)
    winRoi: num(process.env.WIN_ROI, 0.2),
  },

  // Full ledger: after a token's first 24 h are read, keep reading its trades up to today (current price, all-time high, each early buyer's
  // current ROI). Verdicts and tags keep using the OUTCOME_MINUTES checkpoints, so groups stay comparable.
  ledger: {
    enabled: process.env.LEDGER_ENABLED !== 'false',
    activeHours: num(process.env.LEDGER_ACTIVE_HOURS, 6),     // re-read a token that still trades this often ...
    quietHours: num(process.env.LEDGER_QUIET_HOURS, 24),      // ... and one with no trade for LEDGER_QUIET_DAYS this often
    quietDays: num(process.env.LEDGER_QUIET_DAYS, 2),
    stopDays: num(process.env.LEDGER_STOP_DAYS, 14),          // stop following after this many days without a trade ("Sync now" still reads it)
    perCycle: num(process.env.LEDGER_TOKENS_PER_CYCLE, 4),    // tokens followed per worker cycle (newest launch first)
    rowsPerPass: num(process.env.LEDGER_ROWS_PER_PASS, 1000), // transactions read per token per pass; a long history is read over several passes
    syncNowMinutes: num(process.env.SYNC_NOW_MAX_MINUTES, 20), // how long "Sync now" reads a token's history; the worker reads the rest
  },

  // alerts: detectors run beside the worker loop; delivery to Telegram (public channel + each subscriber's chat), webhooks, dashboard, API
  // automated contract audits: every contract deployed on NEAR, found by following the chain tip (FastNEAR neardata)
  autoAudit: {
    enabled: process.env.AUTO_AUDIT_ENABLED !== 'false',
    neardataUrl: process.env.NEARDATA_URL || 'https://mainnet.neardata.xyz',
    everyMs: num(process.env.AUTO_AUDIT_EVERY_SECONDS, 15) * 1000,
    blocksPerTick: num(process.env.AUTO_AUDIT_BLOCKS_PER_TICK, 60),        // the chain makes ~1 block / s
    fetchConcurrency: num(process.env.AUTO_AUDIT_FETCH_CONCURRENCY, 6),
    maxBehindBlocks: num(process.env.AUTO_AUDIT_MAX_BEHIND_BLOCKS, 21600), // ~6 h: older blocks come from a slow archive
    auditsPerTick: num(process.env.AUTO_AUDIT_PER_TICK, 2),
    aiDailyBudget: num(process.env.AUTO_AUDIT_AI_PER_DAY, 200),            // AI calls per day for the audit stages
    writeUp: process.env.AUTO_AUDIT_WRITE_UP !== 'false',                  // a plain-language AI summary with every audit
  },
  // hacks and scams: live detection of protocol drains (beside the deploy watcher) and the incident tracer
  // the ontology layer (docs/ontology-design.md): shadow mode compares every module's account decisions with it, changing none
  ontology: {
    shadow: process.env.ONTOLOGY_SHADOW !== 'false',
    heartbeat: process.env.ONTOLOGY_HEARTBEAT !== 'false',
    // which modules decide with the ontology (comma list of pass_through, tracer, grouping, firewall; "none" = all back on their old rules, the rollback)
    read: process.env.ONTOLOGY_READ ?? 'pass_through,tracer,grouping,firewall', // false on a local copy pointed at the production database: the gate trusts heartbeats
    backfillEveryHours: num(process.env.ONTOLOGY_BACKFILL_EVERY_HOURS, 24), // re-derive the facts from the other collections (0 = never)
    directWriters: process.env.ONTOLOGY_DIRECT_WRITERS !== 'false', // step G1: modules write their facts when they change their data (false = backfill only)
  },
  incidents: {
    enabled: process.env.INCIDENTS_ENABLED !== 'false',
    // an account that is only busy (20,000+ transactions) is never called an exchange hot wallet: it needs a sweep to an exchange's cold wallet, a hand entry or a name. false = the old fallback
    // case valuation: USD at the time the money moved (NEAR/USD history, the tracker's own trades, the case's own swaps), today's price as the last resort; false = today's prices only
    priceAtIncident: process.env.PRICE_AT_INCIDENT !== 'false',
    priceHistoryUrl: process.env.PRICE_HISTORY_URL ?? 'https://api.binance.com/api/v3/klines', // hourly NEARUSDT klines ('' = no history: tier skipped)
    // the money trail (WP-11): best-first by the USD that reached each wallet, stopped by value, not by fixed hop caps. search: best_first | bfs (the old hop-by-hop search)
    trail: {
      search: process.env.TRAIL_SEARCH === 'bfs' ? 'bfs' : 'best_first',
      floorUsd: num(process.env.TRAIL_FLOOR_USD, 200),        // never expand a wallet that received less
      shareFloor: num(process.env.TRAIL_SHARE_FLOOR, 0.005),  // ... or less than this share of the case's loss
      maxWallets: num(process.env.TRAIL_MAX_WALLETS, 40),
      maxDepth: num(process.env.TRAIL_MAX_DEPTH, 6),
      maxMs: num(process.env.TRAIL_MAX_MINUTES, 5) * 60e3,    // stay under INCIDENT_INVESTIGATE_TIMEOUT_MINUTES
    },
    identifyBusyNeutral: process.env.IDENTIFY_BUSY_NEUTRAL !== 'false',
    minUsd: num(process.env.INCIDENT_MIN_USD, 100000),          // a receiver must take at least this from one protocol within 30 min (only >= $100k)
    alwaysUsd: num(process.env.INCIDENT_ALWAYS_USD, 250000),   // ... and is traced whatever it looks like above this
    freshHours: num(process.env.INCIDENT_FRESH_HOURS, 72),      // an account younger than this is a suspect
    aiPerDay: num(process.env.INCIDENT_AI_PER_DAY, 60),          // NEAR AI calls per day for incident reports and deep reviews (apart from the audits)
    everyMs: num(process.env.INCIDENT_EVERY_SECONDS, 60) * 1000, // investigations and deep reviews start at most this often (the chain watch keeps its own 15 s)
    investigateTimeoutMinutes: num(process.env.INCIDENT_INVESTIGATE_TIMEOUT_MINUTES, 10), // the worker moves on to the next case after this long
    alertMaxAgeDays: num(process.env.INCIDENT_ALERT_MAX_AGE_DAYS, 7), // a hack whose attack is older than this when found is history: no alert, only new moves
    reviewDelayMinutes: num(process.env.INCIDENT_REVIEW_DELAY_MINUTES, 3), // the deep review (re-trace + NEAR AI verdict) runs this long after a finding
    exchangeMinUsd: num(process.env.INCIDENT_EXCHANGE_MIN_USD, 100000), // an exchange hot-wallet outflow worth checking for a drain (only >= $100k)
    followMinUsd: num(process.env.INCIDENT_FOLLOW_MIN_USD, 100000),  // a move of stolen funds worth an alert (only >= $100k)
    liveMinUsd: num(process.env.INCIDENT_LIVE_MIN_USD, 100000),     // safety live feed / caught live threshold (only >= $100k)
    registryEveryHours: num(process.env.EXCHANGE_REGISTRY_EVERY_HOURS, 24), // rediscover exchange wallets and their baselines
    ringEveryMinutes: num(process.env.RING_EVERY_MINUTES, 360),    // laundering-ring detector, one case a pass (proposals for an operator; 0 = off)
    ringOperatorChat: process.env.RING_OPERATOR_CHAT_ID || '',      // private Telegram chat for new ring proposals (never the public channel)
    newsEveryMinutes: num(process.env.NEWS_EVERY_MINUTES, 15),     // security news feeds (0 = off)
    newsFeeds: (process.env.NEWS_FEEDS || 'https://cointelegraph.com/rss,https://www.theblock.co/rss.xml,https://decrypt.co/feed,https://rekt.news/rss/feed.xml,https://cryptoslate.com/feed/').split(',').map((s) => s.trim()).filter(Boolean),
  },
  // tokens found from the chain, not from a launchpad (src/collect/liquidity.js): a contract the deploy watcher saw deployed becomes a tracked
  // token the moment liquidity is first added for it (Ref v2 add_liquidity, Ref DCL liquidity_added) against a quote the tracker can value
  tokensFromDeploys: {
    enabled: process.env.TOKENS_FROM_DEPLOYS !== 'false',
    maxAgeDays: num(process.env.TOKENS_FROM_DEPLOYS_MAX_AGE_DAYS, 14), // a pool for a token deployed longer ago than this is not a launch
  },
  // money watch (docs/money-watch-design.md): every movement of minUsd or more opens a watch case; the money is followed until the reviewer calls it normal
  watch: {
    enabled: process.env.WATCH_ENABLED !== 'false',
    minUsd: num(process.env.WATCH_MIN_USD, 100000),               // one movement worth at least this (USD, whatever the token) opens a watch
    followMinUsd: num(process.env.WATCH_FOLLOW_MIN_USD, 10000),   // a move out of a watched account worth at least this (and followShare of what the sender received) is followed
    followShare: num(process.env.WATCH_FOLLOW_SHARE, 0.1),
    followCapUsd: num(process.env.WATCH_FOLLOW_CAP_USD, 100000),  // ... but a move this large is always followed, whatever the branch received (splits of a big drain)
    recordMinUsd: num(process.env.WATCH_RECORD_MIN_USD, 100),     // smaller moves out of a watched account are counted (sent on, splits to one receiver summed) but not listed
    escalate: process.env.WATCH_ESCALATE === 'true',             // a suspicious verdict opens an incident (public path); off = marked suspicious on the private page only
    dustUsd: num(process.env.WATCH_DUST_USD, 1000),               // an account that sent all but this (or dustShare of what it received) has sent it all: it stops being watched
    dustShare: num(process.env.WATCH_DUST_SHARE, 0.05),
    maxAccounts: num(process.env.WATCH_MAX_ACCOUNTS, 40),         // accounts watched at once in one case
    maxDepth: num(process.env.WATCH_MAX_DEPTH, 6),                // hops from the first receiver
    maxIdleDays: num(process.env.WATCH_MAX_IDLE_DAYS, 30),        // a watch with no move for this long is closed as normal (idle) and kept
    ai: process.env.WATCH_AI !== 'false',
    aiPerDay: num(process.env.WATCH_AI_PER_DAY, 100),             // NEAR AI calls per day for watch reviews (its own budget: the hack investigations keep theirs)
    everyMs: num(process.env.WATCH_EVERY_SECONDS, 30) * 1000,     // the review lane starts at most this often
    reviewGapMinutes: num(process.env.WATCH_REVIEW_GAP_MINUTES, 60), // a watch is reviewed again after new moves at most this often
    reviewMinUsd: num(process.env.WATCH_REVIEW_MIN_USD, 10000),   // ... and only when at least this much moved since the last review (or a new exit appeared)
    linkHops: num(process.env.WATCH_LINK_HOPS, 3),                // a reported address is looked back this many large movements to find a case
  },
  // transaction firewall (POST /api/v1/tx/check): open to any wallet / dApp, cross-origin
  firewall: {
    maxBodyBytes: num(process.env.FIREWALL_MAX_BODY_BYTES, 2_000_000),  // a DeployContract carries the code
    perIp10Min: num(process.env.FIREWALL_PER_IP_10MIN, 300),              // checks per client IP per 10 minutes without an API key
    apiKeys: (process.env.FIREWALL_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean), // x-api-key values with no per-IP limit
    explainTimeoutMs: num(process.env.FIREWALL_EXPLAIN_TIMEOUT_MS, 15000),
    // an account that is clean itself but sits within this many hops of a bad account in the ontology's graph (money, control, a shared
    // wallet group; exchanges and services cut the path) gets a medium finding: at most a "caution", never a block. 0 = off
    neighbourHops: num(process.env.FIREWALL_NEIGHBOUR_HOPS, 2),
    // the explanation a person reads before signing: few calls, so the stronger model (it notices an "ok" transaction that does not add up)
    explainModel: process.env.FIREWALL_EXPLAIN_MODEL || process.env.NEAR_AI_ANALYSIS_MODEL || 'anthropic/claude-sonnet-5-5',
  },
  alerts: {
    enabled: process.env.ALERTS_ENABLED !== 'false',
    everyMs: num(process.env.ALERTS_EVERY_SECONDS, 60) * 1000,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramBot: (process.env.TELEGRAM_BOT_NAME || 'safenear_bot').replace(/^@/, ''), // the bot's @name, shown on the Alerts page
    telegramChannel: process.env.TELEGRAM_CHANNEL_ID || '',          // public channel / chat for alerts at publicSeverity and above
    webhookUrl: process.env.ALERTS_WEBHOOK_URL || '',                // global webhook for the same alerts
    gatePass: process.env.ALERTS_GATE_PASS !== 'false',              // a gate-pass report when a launch passes every hard gate (scanner/gatepass.js)
    gatePassChat: process.env.TELEGRAM_GATE_PASS_CHAT_ID || '',     // optional extra chat / channel for every gate-pass report (bot chats get them anyway)
    publicSeverity: ['high', 'medium', 'info'].includes(process.env.ALERTS_PUBLIC_SEVERITY) ? process.env.ALERTS_PUBLIC_SEVERITY : 'high',
    // watched tokens: trades re-read this often, and what counts as a large sell / a fast drop
    watchSyncMinutes: num(process.env.ALERTS_WATCH_SYNC_MINUTES, 3),  // short enough that an event is read well inside maxAgeMinutes
    maxAgeMinutes: num(process.env.ALERTS_MAX_AGE_MINUTES, 10),        // activity alerts only for on-chain events this recent; older ones are never announced
    bigSellNear: num(process.env.ALERTS_BIG_SELL_NEAR, 25),
    bigBuyNear: num(process.env.ALERTS_BIG_BUY_NEAR, 25),            // a buy of a watched token this large is an alert too
    priceDrop: num(process.env.ALERTS_PRICE_DROP, 0.3),
    bigTransferNear: num(process.env.ALERTS_BIG_TRANSFER_NEAR, 250),      // a wallet-to-wallet move of a watched token worth this much ...
    bigTransferShare: num(process.env.ALERTS_BIG_TRANSFER_SHARE, 0.01),  // ... or this share of the supply is an alert
    siteUrl: (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, ''),  // links in alerts, e.g. https://safenear.example
  },
  // NFT collectibles: HOT Craft and near.cooking followed, every collection NearBlocks lists discovered, any collection added by hand
  nft: {
    enabled: process.env.NFT_ENABLED !== 'false',
    syncPerTick: num(process.env.NFT_SYNC_PER_TICK, 3),               // collections synced per worker pass
    nearblocksUrl: process.env.NEARBLOCKS_API_URL || 'https://api.nearblocks.io',
    nearblocksKey: process.env.NEARBLOCKS_API_KEY || '',
    nearblocksEveryMs: num(process.env.NFT_NEARBLOCKS_EVERY_SECONDS, 30) * 1000, // one page of the collection list per this many seconds (public API rate limit)
  },
  graph: {
    fundingDepth: num(process.env.FUNDING_DEPTH, 3),
    flowLookbackTxs: num(process.env.FLOW_LOOKBACK_TXS, 60),
    cobuyMinTokens: num(process.env.COBUY_MIN_TOKENS, 4),
    cobuySeconds: num(process.env.COBUY_SECONDS, 15),
    profileConcurrency: num(process.env.PROFILE_CONCURRENCY, 4),
    deepDepth: num(process.env.DEEP_DEPTH, 1),                     // hops of funding / flow followed from each early wallet to find shared accounts (2+ chains unrelated wallets through platforms)
    expandBatch: num(process.env.NETWORK_EXPAND_BATCH, 20),        // linked (non-early) wallets profiled per cycle; 0 turns the expansion off
    networkMaxNodes: num(process.env.NETWORK_MAX_NODES, 5000),     // cap on stored network wallets
  },

  evaluate: {
    minTokens: num(process.env.MIN_TOKENS_FOR_VERDICT, 3),
    goodScore: num(process.env.GOOD_SCORE, 68),
    badScore: num(process.env.BAD_SCORE, 38),
    reviewEveryMs: num(process.env.REVIEW_EVERY_HOURS, 6) * 3600e3,
    reviewMinWallets: num(process.env.REVIEW_MIN_WALLETS, 2),
  },

  // --- scanner mode: watch every new launch, apply the hard gates, ask the AI analyst, and invest in a SIMULATED wallet ---
  scan: {
    enabled: bool(process.env.SCAN_ENABLED, true),
    observeSeconds: num(process.env.OBSERVE_SECONDS, 130),           // wait this long after the pool opens before the first check
    justhootMinAgeSeconds: num(process.env.JUSTHOOT_MIN_AGE_SECONDS, 130), // same as observeSeconds: justhoot has no extra wait
    maxTokenAgeMinutes: num(process.env.MAX_TOKEN_AGE_MINUTES, 60),  // a launch not checked within this long is skipped as stale
  },
  rules: {
    minPoolNear: num(process.env.MIN_POOL_NEAR, 50),
    minUniqueBuyers: num(process.env.MIN_UNIQUE_BUYERS, 11),
    // market cap at the first check, in NEAR: does not drift with NEAR's price. Measured on 1,113 checks (2026-11-11): >= 1,250 NEAR keeps
    // 11 of 31 launches that later doubled while passing 11 of 479 rugs; the old $8,500 kept 3. MIN_MCAP_USD (0 = off) can add a USD floor
    minMcapNear: num(process.env.MIN_MCAP_NEAR, 1250),
    minMcapUsd: num(process.env.MIN_MCAP_USD, 0),
    maxTaxBps: num(process.env.MAX_TAX_BPS, 1000),
    maxLinkedBuyerShare: num(process.env.MAX_LINKED_BUYER_SHARE, 0.4),
    maxBadGroupShare: num(process.env.MAX_BAD_GROUP_SHARE, 0.4),
    maxNetworkRuggers: num(process.env.CREATOR_NETWORK_MAX_RUGGERS, 0), // other creators tied to this one (funding / payments) allowed to have rugged; -1 = no gate
    auditMaxRisk: num(process.env.AUDIT_MAX_RISK, 70),
    maxPriceMultipleSinceLaunch: num(process.env.MAX_PRICE_MULTIPLE, 8),
    ignoreRunupBelowMcapUsd: num(process.env.IGNORE_RUNUP_BELOW_MCAP_USD, 10000),
    minScore: num(process.env.MIN_RULE_SCORE, 55),
  },
  // ground truth for the accuracy numbers: a launch is "bad" when a buyer at the check held less than this share of the price 24 h later
  // Safe Near Academy (docs/academy-design.md): the graded tasks are rebuilt from the audits and the launch checks this often (0 = never)
  academy: { rebuildHours: num(process.env.ACADEMY_REBUILD_HOURS, 24), business: academyBusiness() },
  accuracy: { badBelow: num(process.env.ACCURACY_BAD_BELOW, 0.85), everyMs: num(process.env.ACCURACY_EVERY_MS, 3600e3) },
  // the token analysis page's AI review: it reads the latest trades first, then follows tokens moved out by transfer
  // data health (WP-16): block gaps and a sampled cross-check of the indexer against RPC on another host; nothing here changes a verdict
  data: {
    gapBlocks: num(process.env.DATA_GAP_BLOCKS, 5),                 // more empty heights in a row than this are checked against RPC
    checkEveryMinutes: num(process.env.DATA_CHECK_EVERY_MINUTES, 60), // 0 = off
    checkSample: num(process.env.DATA_CHECK_SAMPLE, 10),
    checkReceipts: process.env.DATA_CHECK_RECEIPTS === 'true',      // also compare the receipt count (calibrate on real captures first)
    rpcUrls: list(process.env.DATA_CHECK_RPC_URLS, ['https://near.drpc.org', 'https://rpc.mainnet.near.org']), // NOT FastNEAR: a second source (near.lava.build was discontinued in Nov 2026)
  },
  analysis: {
    syncMinutes: num(process.env.ANALYSIS_SYNC_MINUTES, 5),  // how long an AI review reads new trades before writing (the worker reads the rest)
    holdersVerified: num(process.env.ANALYSIS_HOLDERS_VERIFIED, 60), // the largest estimated holders checked live (ft_balance_of), ten at a time
    flowHops: num(process.env.ANALYSIS_FLOW_HOPS, 5),        // how many transfer hops to follow tokens that left the creator / early buyers
  },
  analyst: {
    minConfidence: num(process.env.AI_MIN_CONFIDENCE, 0.65),
    holdBuyMinScore: num(process.env.HOLD_BUY_MIN_SCORE, 75),        // a clean pass with this score is still bought when the AI only says HOLD
    holdBuyBlockHighRisk: bool(process.env.HOLD_BUY_BLOCK_HIGH_RISK, false),
    requireAi: bool(process.env.SIM_REQUIRE_AI, true),               // without a NEAR AI verdict nothing is bought (false = rules alone decide)
  },
  sim: {
    enabled: bool(process.env.SIM_ENABLED, true),
    startNear: num(process.env.SIM_START_NEAR, 100),
    buyNear: num(process.env.SIM_BUY_NEAR, 5),
    highRiskBuyNear: num(process.env.SIM_HIGH_RISK_BUY_NEAR, 2),     // smaller size when the AI rates the risk high
    extraSlippageBps: num(process.env.SIM_EXTRA_SLIPPAGE_BPS, 100),  // on top of the pool's own price impact, to model latency
    maxOpenCostNear: num(process.env.SIM_MAX_OPEN_COST_NEAR, 50),    // cap on NEAR tied up in open positions
    maxBuysPerDay: num(process.env.SIM_MAX_BUYS_PER_DAY, 10),
    minReserveNear: num(process.env.SIM_MIN_RESERVE_NEAR, 3),        // cash that is never spent
    takeProfitRoi: num(process.env.TAKE_PROFIT_ROI, 3),              // +300 %
    takeProfitShare: num(process.env.TAKE_PROFIT_PROFIT_SHARE, 0.5), // take out the cost plus this share of the profit, keep the rest
    positionCheckSeconds: num(process.env.POSITION_CHECK_SECONDS, 60),
    rugWatch: bool(process.env.SIM_RUG_WATCH, true),                 // creator dumps a held token: blacklist the creator, exit the position
  },
  // contract audit (ported from our earlier backend): access keys, code, tax and sell behaviour of the token contract
  audit: {
    enabled: bool(process.env.AUDIT_ENABLED, true),
    maxRisk: num(process.env.AUDIT_MAX_RISK, 70),                    // a risk score at or above this fails the gate (70 = "critical")
    timeoutSeconds: num(process.env.AUDIT_TIMEOUT_SECONDS, 60),
  },
  followUp: {
    enabled: bool(process.env.FOLLOWUP_ENABLED, true),               // re-review tokens that scored well at the first check
    minScore: num(process.env.FOLLOWUP_MIN_SCORE, 70),
    minutes: nums(process.env.FOLLOWUP_MINUTES, [15, 90, 180]),
    canSell: bool(process.env.FOLLOWUP_CAN_SELL, true),              // an AI SELL on a held token sells it (simulated)
  },

  web: {
    // On a host (Railway sets PORT / RAILWAY_*) the UI listens publicly on 8080 unless PORT says otherwise; locally it stays on 127.0.0.1:8790.
    hosted: !!(process.env.PORT || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID),
    // DASHBOARD_PORT forces one port. Hosted: 8080 plus $PORT when the host sets a different one. Local: 8790.
    ports: [...new Set((process.env.DASHBOARD_PORT ? [Number(process.env.DASHBOARD_PORT)] : (process.env.PORT || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) ? [8080, num(process.env.PORT, 8080)] : [8790]).filter((p) => p > 0))],
    get port() { return this.ports[0]; },
    host: process.env.DASHBOARD_HOST || (process.env.PORT || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID ? '0.0.0.0' : '127.0.0.1'),
    password: process.env.DASHBOARD_PASSWORD || '', // optional: when set, the UI asks for it (HTTP Basic auth, any username)
    // A public dashboard must not teach a rugger what is checked: thresholds, rule names, reasons and gate ids are removed from the API (web/redact.js).
    // Default: on for a public deployment (hosted, no password); HIDE_CRITERIA=1 / 0 forces it.
    get hideCriteria() { const v = process.env.HIDE_CRITERIA; return v != null && v !== '' ? /^(1|true|yes|on)$/i.test(v) : this.hosted && !this.password; },
  },

};

export function validateConfig({ needWeb = false } = {}) {
  const errs = [];
  if (!config.mongo.uri) errs.push('MONGODB_URI is required (MongoDB is the main database)');
  if (config.outcome.minutes.length === 0) errs.push('OUTCOME_MINUTES must list at least one age in minutes');
  return errs;
}
