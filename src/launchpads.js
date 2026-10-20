// Launchpad adapters: turn a decoded launchpad transaction into "token went live" records.
// Only what the tracker needs: the token, who launched it, and the pool its early buyers traded in.
import { DCL } from './near/quotes.js';
import { yoctoToNear } from './near/rpc.js';

const poolHasToken = (poolId, token) => !!poolId && poolId.split('|').slice(0, 2).includes(token);
const otherSide = (poolId, token) => poolId.split('|').slice(0, 2).find((x) => x !== token);

function dclPoolId(tx, token) {
  const e = tx.events.find((x) => x.executor === DCL && (x.event === 'create_pool' || x.event === 'liquidity_added') && poolHasToken(x.data?.[0]?.pool_id, token));
  return e?.data[0].pool_id || null;
}

export const adapters = {
  // nearly.trade ("nearpad" events): single-sided DCL pool, quote is whatever the other side of the pool id is
  nearlytrade: {
    account: 'nearlytrade.near',
    parse(tx) {
      const out = [];
      for (const e of tx.events.filter((x) => x.executor === 'nearlytrade.near' && x.standard === 'nearpad' && x.event === 'launch')) {
        const d = e.data?.[0]; if (!d?.token || !d.pool_id) continue;
        const quote = otherSide(d.pool_id, d.token);
        const taxEv = tx.events.filter((x) => x.executor === 'nearlytrade.near' && x.standard === 'nearpad' && x.event === 'tax_opts').map((x) => x.data?.[0]).find((x) => x?.id === d.id);
        const devBuy = tx.events.find((x) => x.event === 'first_buy_done' && x.data?.[0]?.id === d.id);
        out.push({ token: d.token, launchpad: 'nearlytrade', creator: d.creator || null, name: d.name, symbol: d.symbol, pool: { dex: 'dcl', poolId: d.pool_id, quote },
          devBuyNear: quote === 'wrap.near' ? (devBuy ? yoctoToNear(devBuy.data[0].used || '0') : (d.dev_buy_near ? yoctoToNear(d.dev_buy_near) : 0)) : null, devBuyQuoteRaw: quote !== 'wrap.near' && devBuy ? devBuy.data[0].used || '0' : null,
          lp: { owner: 'lock2.nearlytrade.near', locked: true },
          tax: taxEv ? { buyBps: taxEv.buy_bps, sellBps: taxEv.sell_bps, creatorBps: taxEv.creator_bps, burnBps: taxEv.burn_bps, holdersBps: taxEv.holders_bps } : null });
      }
      return out;
    },
  },

  // justhoot ("hoot_launcher" events)
  justhoot: {
    account: 'launchpad.justhoot.near',
    parse(tx) {
      const out = [];
      for (const e of tx.events.filter((x) => x.standard === 'hoot_launcher' && x.event === 'meme_launched')) {
        const d = e.data, token = d.token_id; if (!token) continue;
        const args = tx.calls.find((c) => c.method === 'launch_meme')?.args?.args || {};
        const poolId = dclPoolId(tx, token) || `${[token, d.quote_token_id].sort().join('|')}|10000`;
        const owners = [...new Set(tx.events.filter((x) => x.executor === DCL && x.event === 'liquidity_added' && poolHasToken(x.data?.[0]?.pool_id, token)).map((x) => x.data[0].owner_id))];
        const q = d.quote_token_id;
        out.push({ token, launchpad: 'justhoot', creator: d.creator_id || null, name: args.name, symbol: args.symbol, pool: { dex: 'dcl', poolId, quote: q },
          devBuyNear: q === 'wrap.near' ? yoctoToNear(d.dev_buy_quote || '0') : (d.dev_buy_quote && d.dev_buy_quote !== '0' ? null : 0), devBuyQuoteRaw: q !== 'wrap.near' && d.dev_buy_quote && d.dev_buy_quote !== '0' ? d.dev_buy_quote : null,
          lp: { owner: owners.join(','), locked: owners.length ? owners.every((o) => o === token) : null }, tax: args.transfer_fee_pips ? { transferFeePips: args.transfer_fee_pips } : null });
      }
      return out;
    },
  },

  // meme.cooking: raise, then a Ref v2 pool paired with wNEAR once the token is created
  memecooking: {
    account: 'meme-cooking.near',
    parse(tx) {
      const out = [];
      for (const e of tx.events.filter((x) => x.executor === 'meme-cooking.near' && x.standard === 'meme-cooking' && x.event === 'create_token')) {
        const d = e.data; if (!d?.token_id) continue;
        let liquidityNear = 0;
        for (const l of tx.logs) { const m = l.text.match(/^Liquidity added \["\d+ [^"]+", "(\d+) wrap\.near"\]/); if (l.executor === 'v2.ref-finance.near' && m) liquidityNear = yoctoToNear(m[1]); }
        const locked = tx.logs.some((l) => /to token-locker\.ref-labs\.near/.test(l.text));
        out.push({ token: d.token_id, launchpad: 'memecooking', creator: null, name: null, symbol: null, memeId: d.meme_id, pool: { dex: 'refv2', poolId: d.pool_id, quote: 'wrap.near' }, devBuyNear: 0, liquidityNear, lp: { owner: 'meme-cooking.near', locked }, tax: null });
      }
      return out;
    },
  },
};
