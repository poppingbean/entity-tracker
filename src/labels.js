// Names for well-known accounts (exchanges, services) so exchange wallets read as entities, not hex strings.
// Built-in patterns cover accounts whose NEAR name says what they are; anything else can be named by hand with
//   node src/cli.js label <account> "<name>" [exchange|service|bridge|fund|other]
// (stored in MongoDB, `labels` collection, and applied the next time entities are rebuilt).
const PATTERNS = [
  [/binance/i, 'Binance', 'exchange'], [/okx|okex/i, 'OKX', 'exchange'], [/bybit/i, 'Bybit', 'exchange'], [/kucoin/i, 'KuCoin', 'exchange'], [/bitget/i, 'Bitget', 'exchange'],
  [/(^|[._-])gate(io)?([._-]|$)/i, 'Gate.io', 'exchange'], [/mexc/i, 'MEXC', 'exchange'], [/htx|huobi/i, 'HTX', 'exchange'], [/coinbase/i, 'Coinbase', 'exchange'], [/kraken/i, 'Kraken', 'exchange'],
  [/crypto\.com|cryptocom/i, 'Crypto.com', 'exchange'], [/bitfinex/i, 'Bitfinex', 'exchange'], [/upbit/i, 'Upbit', 'exchange'], [/bithumb/i, 'Bithumb', 'exchange'], [/coinone/i, 'Coinone', 'exchange'],
  [/^intents\.near$/, 'NEAR Intents', 'service'], [/omni.*bridge|bridge\.near|rainbow/i, 'Bridge', 'bridge'], [/meteor/i, 'Meteor Wallet', 'service'], [/herewallet/i, 'HERE Wallet', 'service'],
  [/intear/i, 'Intear', 'service'], [/nearmobile/i, 'NEAR Mobile', 'service'], [/\.tg$/i, 'Telegram wallet', 'service'], [/ref-finance|ref-labs/i, 'Ref Finance', 'service'], [/shardsmarket/i, 'Shards Market', 'service'],
];

export function builtinLabel(account) {
  for (const [re, name, type] of PATTERNS) if (re.test(account)) return { label: name, type };
  return null;
}

/** Label for an account: a hand-set one wins, then a pattern; otherwise a generic description of its kind. */
export function describe(account, kind, manual) {
  if (manual?.[account]) return { label: manual[account].label, type: manual[account].type || 'other', source: 'manual' };
  const b = builtinLabel(account);
  if (b) return { ...b, source: 'pattern' };
  const generic = { hub: ['Unlabelled exchange / hub wallet', 'exchange'], intents: ['NEAR Intents account', 'service'], relayer: ['Relayer / wallet service', 'service'], protocol: ['Protocol / launchpad account', 'service'] }[kind];
  return generic ? { label: generic[0], type: generic[1], source: 'kind' } : { label: null, type: kind === 'wallet' ? 'wallet' : 'unknown', source: null };
}
