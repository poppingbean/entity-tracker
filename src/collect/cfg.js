// Per-token analysis settings. Bonding-curve tokens (gaypad) trade in tiny amounts (the whole curve holds a couple of NEAR), so the dust
// thresholds that suit pool launches would throw every trade away.
import { config } from '../config.js';

export function cfgFor(token) {
  const curve = token?.pool?.dex === 'curve';
  return {
    outcome: curve ? { ...config.outcome, priceMinNear: 0.0005 } : config.outcome,
    entry: { ...config.entry, minutes: config.outcome.minutes, ...(curve ? { minNear: 0.01, priceMinNear: 0.0005 } : {}) },
    keepNear: curve ? 0.0005 : 0.01, // trades below this are not stored
  };
}
