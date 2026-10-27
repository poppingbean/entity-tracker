// Accounts that serve many unrelated users: account factories, trading bots that open sub-accounts for their users, reward / treasury /
// airdrop contracts, and anything the entity table already labels a service, exchange or bridge. Being funded by one, or paying into one,
// says nothing about who owns a wallet, so groups never link wallets through them.

export const SERVICE_NAME = /(^|\.)factory\.|(^|\.)unrlzd\.near$|(^|\.)racerbot\.near$|reward|treasury|airdrop|faucet|payout/i;
export const SERVICE_TYPES = new Set(['service', 'exchange', 'bridge', 'fund']);

/** The labelled services, from entity docs ({ _id, type }). */
export const serviceSet = (entities) => new Set((entities || []).filter((e) => SERVICE_TYPES.has(e.type)).map((e) => e._id));

export const isService = (account, services = null) => !!account && (SERVICE_NAME.test(account) || !!services?.has(account));

/** A platform that creates its users' accounts: most of the wallets it funds are its own sub-accounts (x.trade.unrlzd.near <- trade.unrlzd.near). */
export const fundsOwnSubaccounts = (anchor, wallets) => {
  const ws = [...wallets];
  return ws.length >= 2 && ws.filter((w) => w.endsWith('.' + anchor)).length * 2 >= ws.length;
};
