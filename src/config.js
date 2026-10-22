// Configuration. Everything comes from .env / the environment. There is no wallet and no private key anywhere in this project.
import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(String(v)));
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);
const nums = (v, d) => list(v, d.map(String)).map(Number).filter((x) => x > 0).sort((a, b) => a - b);

export const config = {
  mongo: { uri: process.env.MONGODB_URI || '', dbName: process.env.MONGODB_DB || 'near_entity_tracker' },

  ai: {
    key: process.env.NEAR_AI_API_KEY || '',
    baseUrl: (process.env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/+$/, ''),
    // scanner analyst and group reviews: Claude Haiku 5.5 served by NEAR AI (fast, many calls); the token analysis write-up uses analysisModel
    model: process.env.NEAR_AI_MODEL || 'anthropic/claude-haiku-5-5',
    timeoutMs: num(process.env.NEAR_AI_TIMEOUT_SECONDS, 120) * 1000,
    // token analysis write-ups: Claude Sonnet 5.5 served by NEAR AI (group reviews keep `model`); streamed, so a long answer is not cut at 300 s
    analysisModel: process.env.NEAR_AI_ANALYSIS_MODEL || 'anthropic/claude-sonnet-5-5',
    analysisTimeoutMs: num(process.env.NEAR_AI_ANALYSIS_TIMEOUT_SECONDS, 600) * 1000,
    maxTokens: num(process.env.NEAR_AI_MAX_TOKENS, 4000),
  },

  rpcUrls: list(process.env.NEAR_RPC_URLS, ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com', 'https://near.lava.build']),
  txIndexerUrl: process.env.FASTNEAR_TX_URL || 'https://tx.main.fastnear.com',
  fastnearApiUrl: process.env.FASTNEAR_API_URL || 'https://api.fastnear.com',
  fastnearApiKey: process.env.FASTNEAR_API_KEY || '',

  launchpads: list(process.env.LAUNCHPADS, ['nearlytrade', 'justhoot', 'memecooking']),
  pollSeconds: num(process.env.POLL_SECONDS, 20),

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
    creatorSellRugNear: num(process.env.CREATOR_SELL_RUG_NEAR, 0), // any creator sale above this many NEAR makes the token a rug (creator sold)
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
  },

  graph: {
    fundingDepth: num(process.env.FUNDING_DEPTH, 3),
    flowLookbackTxs: num(process.env.FLOW_LOOKBACK_TXS, 60),
    cobuyMinTokens: num(process.env.COBUY_MIN_TOKENS, 4),
    cobuySeconds: num(process.env.COBUY_SECONDS, 15),
    profileConcurrency: num(process.env.PROFILE_CONCURRENCY, 4),
    deepDepth: num(process.env.DEEP_DEPTH, 3),                     // hops of funding / flow followed from each early wallet to find shared accounts
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
    observeSeconds: num(process.env.OBSERVE_SECONDS, 120),           // wait this long after the pool opens before the first check
    justhootMinAgeSeconds: num(process.env.JUSTHOOT_MIN_AGE_SECONDS, 240), // justhoot taxes buys in the first ~2 minutes
    maxTokenAgeMinutes: num(process.env.MAX_TOKEN_AGE_MINUTES, 60),  // a launch not checked within this long is skipped as stale
  },
  rules: {
    minPoolNear: num(process.env.MIN_POOL_NEAR, 50),
    minUniqueBuyers: num(process.env.MIN_UNIQUE_BUYERS, 11),
    minMcapUsd: num(process.env.MIN_MCAP_USD, 8500),
    maxTaxBps: num(process.env.MAX_TAX_BPS, 1000),
    maxLinkedBuyerShare: num(process.env.MAX_LINKED_BUYER_SHARE, 0.4),
    maxBadGroupShare: num(process.env.MAX_BAD_GROUP_SHARE, 0.4),
    maxNetworkRuggers: num(process.env.CREATOR_NETWORK_MAX_RUGGERS, 0), // other creators tied to this one (funding / payments) allowed to have rugged; -1 = no gate
    auditMaxRisk: num(process.env.AUDIT_MAX_RISK, 70),
    maxPriceMultipleSinceLaunch: num(process.env.MAX_PRICE_MULTIPLE, 8),
    ignoreRunupBelowMcapUsd: num(process.env.IGNORE_RUNUP_BELOW_MCAP_USD, 10000),
    minScore: num(process.env.MIN_RULE_SCORE, 55),
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
  // contract audit (ported from the TrustFlow backend): access keys, code, tax and sell behaviour of the token contract
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
