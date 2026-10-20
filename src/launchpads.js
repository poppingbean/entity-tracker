// Launchpad adapters: turn a decoded launchpad transaction into "token went live" records.
// Only what the tracker needs: the token, who launched it, and the pool its early buyers traded in.
import { DCL } from './near/quotes.js';

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
        out.push({ token: d.token, launchpad: 'nearlytrade', creator: d.creator || null, name: d.name, symbol: d.symbol, pool: { dex: 'dcl', poolId: d.pool_id, quote: otherSide(d.pool_id, d.token) } });
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
        out.push({ token, launchpad: 'justhoot', creator: d.creator_id || null, name: args.name, symbol: args.symbol, pool: { dex: 'dcl', poolId, quote: d.quote_token_id } });
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
        out.push({ token: d.token_id, launchpad: 'memecooking', creator: null, name: null, symbol: null, memeId: d.meme_id, pool: { dex: 'refv2', poolId: d.pool_id, quote: 'wrap.near' } });
      }
      return out;
    },
  },
};
