// Configuration. Everything comes from .env / the environment. There is no wallet and no private key anywhere in this project.
import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);
const nums = (v, d) => list(v, d.map(String)).map(Number).filter((x) => x > 0).sort((a, b) => a - b);

export const config = {
  mongo: { uri: process.env.MONGODB_URI || '', dbName: process.env.MONGODB_DB || 'near_entity_tracker' },

  ai: {
    key: process.env.NEAR_AI_API_KEY || '',
    baseUrl: (process.env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/+$/, ''),
    model: process.env.NEAR_AI_MODEL || 'z-ai/glm-5.3-flash',
    timeoutMs: num(process.env.NEAR_AI_TIMEOUT_SECONDS, 120) * 1000,
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
    winRoi: num(process.env.WIN_ROI, 0.2),
  },

  graph: {
    fundingDepth: num(process.env.FUNDING_DEPTH, 3),
    flowLookbackTxs: num(process.env.FLOW_LOOKBACK_TXS, 60),
    cobuyMinTokens: num(process.env.COBUY_MIN_TOKENS, 4),
    cobuySeconds: num(process.env.COBUY_SECONDS, 15),
    profileConcurrency: num(process.env.PROFILE_CONCURRENCY, 4),
  },

  evaluate: {
    minTokens: num(process.env.MIN_TOKENS_FOR_VERDICT, 3),
    goodScore: num(process.env.GOOD_SCORE, 68),
    badScore: num(process.env.BAD_SCORE, 38),
    reviewEveryMs: num(process.env.REVIEW_EVERY_HOURS, 6) * 3600e3,
    reviewMinWallets: num(process.env.REVIEW_MIN_WALLETS, 2),
  },

  web: {
    port: num(process.env.DASHBOARD_PORT, num(process.env.PORT, 8790)),
    host: process.env.DASHBOARD_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1'),
    password: process.env.DASHBOARD_PASSWORD || '',
  },
};

export function validateConfig({ needWeb = false } = {}) {
  const errs = [];
  if (!config.mongo.uri) errs.push('MONGODB_URI is required (MongoDB is the main database)');
  if (needWeb && !['127.0.0.1', 'localhost', '::1'].includes(config.web.host) && !config.web.password) errs.push(`DASHBOARD_PASSWORD is required when the UI listens on ${config.web.host}`);
  if (config.outcome.minutes.length === 0) errs.push('OUTCOME_MINUTES must list at least one age in minutes');
  return errs;
}
