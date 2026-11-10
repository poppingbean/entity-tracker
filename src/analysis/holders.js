// Holder candidates for a token analysis (WP-15): traders AND every account in the token's stored transfers (both sides) AND the creator, with
// balance = net trades + net transfers. A wallet that received a large transfer and never traded is no longer invisible: that is the hidden-dump
// pattern the transfer trails look for. Pure: no database, no network.

/**
 * traders: Map(account → { buy_tokens, sell_tokens }); transfers: [{ from, to, tokens }]; skip(account) → true for routers / the token itself.
 * Returns [{ account, est_tokens, via: 'trades' | 'transfers' | 'both' }], largest estimated balance first (only balances above 1 token).
 */
export function holderCandidates(traders, transfers, { creator = null, skip = () => false } = {}) {
  const est = new Map();
  const get = (a) => est.get(a) || est.set(a, { account: a, trade: 0, xfer: 0, traded: false, moved: false }).get(a);
  for (const x of traders.values()) { if (skip(x.account)) continue; const e = get(x.account); e.trade += (x.buy_tokens || 0) - (x.sell_tokens || 0); e.traded = true; }
  for (const t of transfers || []) {
    const n = Number(t.tokens) || 0; if (!(n > 0)) continue;
    if (t.to && !skip(t.to)) { const e = get(t.to); e.xfer += n; e.moved = true; }
    if (t.from && !skip(t.from)) { const e = get(t.from); e.xfer -= n; e.moved = true; }
  }
  if (creator && !skip(creator)) get(creator);
  return [...est.values()].map((e) => ({ account: e.account, est_tokens: e.trade + e.xfer, via: e.traded && e.moved ? 'both' : e.moved ? 'transfers' : 'trades' }))
    .filter((x) => x.est_tokens > 1 || x.account === creator).sort((a, b) => b.est_tokens - a.est_tokens);
}

/** A top-10 holder that never traded and got its tokens only by transfer from the creator or an early buyer: a risk note, or null. */
export function transferOnlyNote(rows, transfers, { creator = null, earlyBuyers = new Set() } = {}) {
  const sources = new Set([...(creator ? [creator] : []), ...earlyBuyers]);
  const hits = rows.slice(0, 10).filter((h) => h.via === 'transfers' && (transfers || []).some((t) => t.to === h.account && sources.has(t.from)));
  return hits.length ? `${hits.length} of the 10 largest holders never traded: they received their tokens by transfer from the creator or an early buyer.` : null;
}
