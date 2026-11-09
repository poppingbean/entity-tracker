// The golden set: accounts whose class is known for certain. Every migration step must keep them right (docs/ontology-design.md, 6).
import { isA } from './classes.js';

export const GOLDEN = [
  ['9c484fa5d2d069569ba063fc555c34e621ccd88fdbb0295fc79bad232621c5c1', 'exchange/hot_wallet', 'Binance hot wallet (sweeps to binancecold3.near)'],
  ['451913e633c72fb951effe076d3bd2977e3f08083dcf6c87fa89992b0d437c5c', 'exchange/hot_wallet', 'Binance hot wallet'],
  ['5c33c6218d47e00ef229f60da78d0897e1ee9665312550b8afd5f9c7bc6957d2', 'exchange/hot_wallet', 'Binance hot wallet'],
  ['d04204b6591fefb973a8ed60929f8211af89ee38020da9faf905acdc7a320063', 'exchange/hot_wallet', 'Binance hot wallet'],
  ['binancecold3.near', 'exchange/cold_wallet', 'Binance cold wallet'],
  ['solver-priv-liq.near', 'service/intents_solver', 'the NEAR Intents solver behind the false drain of 2026-11-04'],
  ['intents.near', 'service/router', 'NEAR Intents'],
  ['wrap.near', 'service/router', 'wrapped NEAR'],
  ['nearlytrade.near', 'service/launchpad', 'launchpad'],
  ['launchpad.justhoot.near', 'service/launchpad', 'launchpad'],
  ['meme-cooking.near', 'service/launchpad', 'launchpad'],
  ['meteor-relayer.near', 'service/relayer', 'relayer'],
  ['5115501476.tg', 'person/app_user', 'a Telegram-wallet user'],
  ['contract.main.burrow.near', 'contract/lending', 'Rhea (Burrow) lending, the 2026-04 exploit target'],
  ['near', 'system', 'the system account'],
];

/** Check resolved entities (Map account → entity) against the golden set: [{ account, expect, got, ok, why }]. */
export const checkGolden = (ents) => GOLDEN.map(([account, expect, note]) => {
  const e = ents.get(account);
  return { account, expect, got: e?.class || 'unknown', ok: !!e && isA(e.class, expect), note, why: e?.why || null };
});
