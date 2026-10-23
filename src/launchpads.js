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

// Launchpads that are tracked for their early investors only: no gates, AI analyst or simulated buys (no standard launch lifecycle / no Ref pool to quote).
const TRACK_ONLY = { trackOnly: true };
const isQ = (a) => typeof a === 'string' && a.endsWith('.qlyphs.near') && a !== 'liquidity.qlyphs.near' && !/^(registrar|attestor)\./.test(a);

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

  // qlyphs ("<name>-<id>.qlyphs.near" tokens; liquidity.qlyphs.near opens a DCL pool quoted in QTC)
  qlyphs: {
    account: 'liquidity.qlyphs.near',
    parse(tx) {
      const out = [];
      const nw = tx.calls.find((c) => c.method === 'new');
      const md = nw && isQ(tx.receiver) ? nw.args?.metadata || {} : {};
      for (const e of tx.events.filter((x) => x.executor === DCL && x.event === 'create_pool')) {
        const poolId = e.data?.[0]?.pool_id; if (!poolId) continue;
        const [a, b] = poolId.split('|');
        const token = [a, b].find(isQ); if (!token) continue;
        out.push({ token, launchpad: 'qlyphs', creator: null, name: md.name || null, symbol: md.symbol || null, pool: { dex: 'dcl', poolId, quote: otherSide(poolId, token) }, devBuyNear: 0, lp: { owner: null, locked: null }, tax: null, liveOnFirstTrade: true, ...TRACK_ONLY });
      }
      return out;
    },
  },

  // tkn.near: plain FT factory ("<symbol>.tkn.near"). The token is minted without a pool; the owner adds liquidity later (Ref DCL, or a
  // Ref v2 pool against wNEAR as BLACKDRAGON did), so the token waits as "awaiting_pool" until checkTknPool() (collect/launches.js) finds it.
  tkn: {
    account: 'tkn.near',
    parse(tx) {
      if (tx.failed) return [];
      const c = tx.calls.find((x) => x.method === 'create_token');
      const md = c?.args?.args?.metadata;
      if (!md?.symbol) return [];
      return [{ token: `${String(md.symbol).toLowerCase()}.tkn.near`, launchpad: 'tkn', creator: c.args.args.owner_id || tx.signer, name: md.name || null, symbol: md.symbol, pool: null, awaitingPool: true, liveOnFirstTrade: true, devBuyNear: 0, lp: { owner: null, locked: null }, tax: null, ...TRACK_ONLY }];
    },
  },

  // gaypad (bonding curve inside gaypad.j1-racing.near; trades are its token_swap events, see collect/trades.js)
  gaypad: {
    account: 'gaypad.j1-racing.near',
    parse(tx) {
      const out = [];
      for (const e of tx.events.filter((x) => x.executor === 'gaypad.j1-racing.near' && x.event === 'token_sale_created')) {
        const d = Array.isArray(e.data) ? e.data[0] : e.data; if (!d?.token_id) continue;
        out.push({ token: d.token_id, launchpad: 'gaypad', creator: d.account_id || null, name: d.metadata?.name || null, symbol: d.metadata?.symbol || null,
          pool: { dex: 'curve', poolId: d.token_id, quote: 'wrap.near' }, devBuyNear: 0, lp: { owner: 'gaypad.j1-racing.near', locked: null }, tax: null, ...TRACK_ONLY });
      }
      return out;
    },
  },

  // justhoot v2 (since 2026-10-19): launches moved to v2-launchpad.justhoot.near, tokens are "<symbol>.v2-launchpad.justhoot.near" ("hoot_launcher_v2" events).
  // Stored as launchpad "justhoot" like v1 so links, filters and the scanner's justhoot timing apply.
  justhoot_v2: {
    account: 'v2-launchpad.justhoot.near',
    parse(tx) {
      const out = [];
      const V2 = (name) => tx.events.filter((x) => x.executor === 'v2-launchpad.justhoot.near' && x.standard === 'hoot_launcher_v2' && x.event === name).map((x) => (Array.isArray(x.data) ? x.data[0] : x.data));
      for (const d of V2('meme_launched')) {
        const token = d?.token_id; if (!token) continue;
        const args = tx.calls.find((c) => c.method === 'launch_meme')?.args?.args || {};
        const poolId = V2('dcl_pool_created').find((x) => x.token_id === token)?.pool_id || V2('launch_planned').find((x) => x.token_id === token)?.plan?.pool_id || `${[token, d.quote_token_id].sort().join('|')}|10000`;
        const q = d.quote_token_id || otherSide(poolId, token);
        out.push({ token, launchpad: 'justhoot', creator: d.creator_id || null, name: args.name || null, symbol: args.symbol || null, pool: { dex: 'dcl', poolId, quote: q },
          devBuyNear: q === 'wrap.near' ? yoctoToNear(d.dev_buy_quote || '0') : (d.dev_buy_quote && d.dev_buy_quote !== '0' ? null : 0), devBuyQuoteRaw: q !== 'wrap.near' && d.dev_buy_quote && d.dev_buy_quote !== '0' ? d.dev_buy_quote : null,
          lp: { owner: 'v2-pool-creator.justhoot.near', locked: null }, tax: args.transfer_fee_pips ? { transferFeePips: args.transfer_fee_pips } : null });
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
