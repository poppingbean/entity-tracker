// NFT events from a decoded transaction (near/indexer.js decodeTx): NEP-171 mint / transfer / burn logs emitted by one collection, with the
// money around them. Pure (unit-tested).
//
//   mint      the NEAR the signer attached to its calls pays for the tokens minted (price = total / count); where the money went
//             (proceeds) is every NEAR payment the contracts made in the transaction, except refunds to the signer
//   sale      a transfer the new owner paid for (a call with a deposit, e.g. a marketplace "buy"), or one that paid the old owner
//             (an accepted offer): price = what the buyer attached, or the seller's proceeds plus fees
//   transfer  a free transfer (gift, move between own wallets, airdrop)
//   burn

const sum = (a) => a.reduce((s, x) => s + x, 0);
const round = (x, d = 6) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** NFT events of `collection` in transaction `tx`. Each: { idx, kind, from, to, token_ids, count, price_near, pay_near, market, seller_near, fees, proceeds }. */
export function nftEventsOf(tx, collection) {
  const out = [];
  const evs = (tx.events || []).filter((e) => e.executor === collection && (e.standard === 'nep171' || e.standard === 'nep178'));
  if (!evs.length) return out;
  const paid = sum((tx.calls || []).map((c) => c.depositNear || 0));                         // what the signer attached
  const inflows = (tx.inflows || []).filter((f) => f.near > 0);
  const market = tx.receiver !== collection ? tx.receiver : null;                          // a marketplace / minter the signer called
  let idx = 0;
  for (const e of evs) {
    for (const d of e.data || []) {
      const ids = (d.token_ids || []).map(String), count = ids.length || 1;
      if (e.event === 'nft_mint') {
        const proceeds = inflows.filter((f) => f.to !== tx.signer && f.to !== d.owner_id).map((f) => ({ from: f.from, to: f.to, near: round(f.near) }));
        out.push({ idx: idx++, kind: 'mint', from: null, to: d.owner_id, token_ids: ids, count, signer: tx.signer, market, pay_near: round(paid), price_near: paid ? round(paid / count) : null, proceeds });
      } else if (e.event === 'nft_burn') {
        out.push({ idx: idx++, kind: 'burn', from: d.owner_id, to: null, token_ids: ids, count, signer: tx.signer });
      } else if (e.event === 'nft_transfer') {
        const from = d.old_owner_id, to = d.new_owner_id;
        const sellerNear = sum(inflows.filter((f) => f.to === from).map((f) => f.near));
        const fees = inflows.filter((f) => f.to !== from && f.to !== tx.signer && f.from !== tx.signer).map((f) => ({ to: f.to, near: round(f.near) }));
        const buyerPaid = tx.signer === to && paid > 0;
        const sale = (buyerPaid || sellerNear > 0) && from !== to; // a move to itself (escrow / market bookkeeping) is never a sale
        const total = buyerPaid ? paid : sellerNear + sum(fees.map((f) => f.near));
        out.push({ idx: idx++, kind: sale ? 'sale' : 'transfer', from, to, token_ids: ids, count, signer: tx.signer, market: sale ? market || collection : null,
          ...(sale ? { pay_near: round(total), price_near: round(total / count), seller_near: round(sellerNear), fees } : {}) });
      }
    }
  }
  return out;
}

/** Owner of every token after `events` (oldest first): Map(token_id -> owner), burned tokens removed. */
export function ownersOf(events) {
  const owner = new Map();
  for (const e of events) for (const id of e.token_ids || []) {
    if (e.kind === 'burn') owner.delete(id); else if (e.to) owner.set(id, e.to);
  }
  return owner;
}

/** NFT spam: mass airdrops (gift cards, claim / reward / voucher drops) that put tokens in thousands of wallets nobody chose. */
export const SPAM_NAME = /airdrop|gift ?card|claim|reward|voucher|bonus|free ?mint|ticket to|you won|winner/i;
export const isSpamCollection = (c) => SPAM_NAME.test(`${c.name || ''} ${c.symbol || ''}`) || (Number(c.holders) || 0) > 50000;
