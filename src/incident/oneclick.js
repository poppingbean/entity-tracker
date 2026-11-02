// NEAR Intents 1Click: a one-time deposit address (an implicit account run by bridge-mng.near) swaps what it receives into another asset,
// often on another chain. Its public status says where the swap went: the destination asset and chain, the recipient address, the amounts
// and the transaction on the destination chain. That is the next hop of a loot trail after NEAR. Answers cached an hour.
const API = 'https://1click.chaindefuser.com/v0/status';
const cache = new Map();

const CHAIN = { eth: 'Ethereum', btc: 'Bitcoin', sol: 'Solana', base: 'Base', arb: 'Arbitrum', bsc: 'BNB Chain', pol: 'Polygon', tron: 'Tron', ton: 'TON', doge: 'Dogecoin', xrp: 'XRP Ledger', zec: 'Zcash', sui: 'Sui',
  gnosis: 'Gnosis', bera: 'Berachain', avax: 'Avalanche', op: 'Optimism', stellar: 'Stellar', ltc: 'Litecoin', bch: 'Bitcoin Cash', ada: 'Cardano', aptos: 'Aptos', monad: 'Monad' };
/** "nep141:eth.omft.near" -> { chain: 'Ethereum', asset: 'ETH' }; a plain NEAR token stays on NEAR. */
export function assetChain(asset) {
  const id = String(asset || '').replace(/^nep\d+:/, '');
  const m = id.match(/^(?:([a-z]+)-)?(0x[0-9a-f]+|[a-z0-9]+)\.omft\.near$/i) || id.match(/^([a-z]+)\.omft\.near$/i);
  if (m) { const chain = (m[1] || m[2] || '').toLowerCase(); return { chain: CHAIN[chain] || chain.toUpperCase(), asset: m[1] ? m[2] : chain.toUpperCase() }; }
  const b = id.match(/^([a-z]+)-0x[0-9a-f]+\.omft\.near$/i);
  if (b) return { chain: CHAIN[b[1].toLowerCase()] || b[1], asset: id };
  return { chain: 'NEAR', asset: id };
}

/** The 1Click swap behind a deposit address, or null when it is not one. */
export async function oneClickSwap(depositAddress) {
  if (!/^[0-9a-f]{64}$/.test(depositAddress)) return null;
  const c = cache.get(depositAddress);
  if (c && Date.now() - c.ts < 3600e3) return c.value;
  let value = null, definite = false;
  for (let attempt = 0; attempt < 3 && !definite; attempt++) {
  if (attempt) await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  try {
    const r = await fetch(`${API}?depositAddress=${depositAddress}`, { signal: AbortSignal.timeout(15000) });
    if (r.status === 404) definite = true; // not a 1Click deposit address
    if (r.ok) {
      definite = true;
      const j = await r.json(), q = j.quoteResponse?.quoteRequest || {}, d = j.swapDetails || {}, dest = assetChain(q.destinationAsset);
      value = { status: j.status, deposit_address: depositAddress, origin_asset: q.originAsset || null, destination_asset: q.destinationAsset || null, chain: dest.chain, asset: dest.asset,
        recipient: q.recipient || null, recipient_type: q.recipientType || null, refund_to: q.refundTo || null, amount_in: d.amountInFormatted ?? d.depositedAmountFormatted ?? null,
        amount_in_usd: Number(d.amountInUsd ?? d.depositedAmountUsd) || null, amount_out: d.amountOutFormatted ?? null, amount_out_usd: Number(d.amountOutUsd) || null,
        refunded_usd: Number(d.refundedAmountUsd) || 0, dest_txs: (d.destinationChainTxHashes || []).map((x) => x.hash), near_txs: d.nearTxHashes || [], referral: q.referral || null, updated: j.updatedAt || null };
    }
  } catch {}
  }
  // only a definite answer is remembered: a rate limit or a timeout must not turn a swap into "not a swap" for an hour
  if (definite) cache.set(depositAddress, { ts: Date.now(), value });
  return value;
}
