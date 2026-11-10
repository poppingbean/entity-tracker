// Prices at the time of an incident (src/incident/pricehistory.js): pure parts, tier order, fall-through. No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKlines, impliedPrices, nearestImplied, isStable, usdAt } from '../src/incident/pricehistory.js';
import { config } from '../src/config.js';

test('klines to hourly closes; junk rows are skipped', () => {
  const m = parseKlines([[3600e3 * 10, '1', '2', '0.5', '1.5', '9'], [3600e3 * 11, 'x', 'x', 'x', 'bad'], null]);
  assert.deepEqual([...m], [[10, 1.5]]);
});
test('stablecoins are recognised', () => {
  assert.equal(isStable('usdt.tether-token.near'), true); assert.equal(isStable('intents:usdt.tether-token.near'), true); assert.equal(isStable('wrap.near'), false);
});
test('implied prices: the attacker gave token A and received a stablecoin in one transaction', () => {
  const flows = [{ tx: 't1', ts: 1000, token: 'fake.near', from: 'atk', to: 'pool', raw: '2000' }, { tx: 't1', ts: 1000, token: 'usdt.tether-token.near', from: 'pool', to: 'atk', raw: '500' },
    { tx: 't2', ts: 5000, token: 'fake.near', from: 'x', to: 'y', raw: '1' }];
  const amountOf = (t, raw) => Number(raw), known = (t) => (t === 'usdt.tether-token.near' ? 1 : null);
  const m = impliedPrices(flows, amountOf, known);
  assert.deepEqual(m.get('fake.near'), [{ ts: 1000, usd: 0.25 }]);
  assert.deepEqual(nearestImplied(m.get('fake.near'), 2000), { usd: 0.25, at_ts: 1000 });
  assert.equal(nearestImplied(m.get('fake.near'), 1000 + 25 * 3600e3), null, 'older than 24 h is not used');
});
test('usdAt: stable is 1; the switch off, or no timestamp, falls to today; a missing source falls through', async () => {
  const was = config.incidents.priceAtIncident;
  config.incidents.priceAtIncident = true;
  assert.deepEqual(await usdAt('usdt.tether-token.near', 1700000000000), { usd: 1, basis: 'stable', at_ts: 1700000000000 });
  config.incidents.priceAtIncident = false;
  assert.equal((await usdAt('usdt.tether-token.near', 1700000000000)).basis, 'today');
  config.incidents.priceAtIncident = was;
});
