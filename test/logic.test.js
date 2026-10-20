// Unit tests for the pure logic: early entries / outcomes, grouping, metrics + verdicts, AI reply parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntries, buildOutcome, priceAt, priceSeries, evalRoi } from '../src/collect/analyze.js';
import { buildGroups } from '../src/graph/cluster.js';
import { computeMetrics, ruleVerdict } from '../src/evaluate/metrics.js';
import { extractJson } from '../src/ai/nearai.js';
import { normaliseReview } from '../src/ai/review.js';

const MIN = 60e3;
const T0 = 1_700_000_000_000;
const cfg = { windowMinutes: 10, maxBuyers: 60, minNear: 1, minutes: [60, 360, 1440], rugDrawdown: 0.9 };
const token = { _id: 'tok.near', live_ts: T0, creator: 'creator.near', symbol: 'TOK', launchpad: 'nearlytrade' };
let seq = 0;
const trade = (trader, buy, near, tokens, minute) => ({ _id: `h${seq++}`, token: 'tok.near', ts: T0 + minute * MIN, trader, buy, near, tokens });

test('priceAt returns the last price at or before a time', () => {
  const s = priceSeries([trade('a', true, 1, 100, 0), trade('b', true, 2, 100, 5)]);
  assert.equal(priceAt(s, T0 - 1), null);
  assert.equal(priceAt(s, T0), 0.01);
  assert.equal(priceAt(s, T0 + 6 * MIN), 0.02);
});

test('entries: only first-window buyers count, ROI = value at checkpoint / NEAR in - 1', () => {
  // price rises from 0.01 to 0.04 within 1 h; a sells half at 30 min (price 0.03)
  const trades = [
    trade('a', true, 10, 1000, 1), trade('b', true, 10, 800, 2), trade('late', true, 10, 300, 30),
    trade('x', true, 30, 1000, 29), trade('a', false, 15, 500, 30),     // a sold 500 tokens for 15 N at price 0.03
    trade('x', true, 40, 1000, 59),                                      // price 0.04 at 59 min
  ];
  const now = T0 + 61 * MIN;
  const entries = buildEntries(token, trades, now, cfg);
  assert.deepEqual(entries.map((e) => e.wallet), ['a', 'b'], 'late buyer (outside window) is not early');
  const a = entries.find((e) => e.wallet === 'a');
  // value at 60 min: 15 N taken out + 500 tokens x 0.04 = 35 N on 10 N in -> +250 %
  assert.ok(Math.abs(a.roi[60] - 2.5) < 1e-9, `a roi ${a.roi[60]}`);
  const b = entries.find((e) => e.wallet === 'b');
  assert.ok(Math.abs(b.roi[60] - 2.2) < 1e-9, `b roi ${b.roi[60]}`); // 800 x 0.04 = 32 on 10 in
  assert.equal(a.rank, 1); assert.equal(b.rank, 2); assert.equal(evalRoi(a, cfg.minutes), a.roi[60]);
});

test('entries: dust buys are ignored and the creator is flagged', () => {
  const trades = [trade('dust', true, 0.5, 50, 1), trade('creator.near', true, 5, 500, 1)];
  const e = buildEntries(token, trades, T0 + 61 * MIN, cfg);
  assert.equal(e.length, 1); assert.equal(e[0].is_creator, true);
});

test('outcome: a collapse from the peak is a rug once the first checkpoint has passed', () => {
  const trades = [trade('a', true, 10, 1000, 1), trade('b', true, 50, 1000, 20), trade('c', false, 4, 1000, 50), trade('d', false, 2, 1000, 70)];
  const o = buildOutcome(token, trades, T0 + 100 * MIN, { minutes: cfg.minutes, rugDrawdown: 0.9 });
  assert.equal(o.peak_price, 0.05); assert.ok(o.drawdown >= 0.9); assert.equal(o.rugged, true);
  const young = buildOutcome(token, trades.slice(0, 3), T0 + 30 * MIN, { minutes: cfg.minutes, rugDrawdown: 0.9 });
  assert.equal(young.rugged, false, 'too young to judge');
});

test('groups: shared non-generic funder and co-buying link wallets; exchanges and distributors do not', () => {
  const w = (id, chain, flow_out = []) => ({ _id: id, chain, flow_out });
  const wallets = [
    w('a', [{ account: 'boss', kind: 'wallet', hop: 1 }]), w('b', [{ account: 'boss', kind: 'wallet', hop: 1 }]),
    w('c', [{ account: 'cex', kind: 'hub', hop: 1 }]), w('d', [{ account: 'cex', kind: 'hub', hop: 1 }]),
    w('e', [{ account: 'x1', kind: 'wallet', hop: 1 }]), w('f', [{ account: 'x2', kind: 'wallet', hop: 1 }]),
  ];
  const entries = [];
  for (let i = 0; i < 4; i++) { entries.push({ token: `t${i}`, wallet: 'e', first_buy_ts: T0 + i }); entries.push({ token: `t${i}`, wallet: 'f', first_buy_ts: T0 + i + 3000 }); }
  const { groups, walletGroup } = buildGroups(wallets, entries, new Map(), { cobuySeconds: 15, cobuyMinTokens: 4 });
  assert.equal(walletGroup.get('a'), walletGroup.get('b'), 'same funder');
  assert.notEqual(walletGroup.get('c'), walletGroup.get('d'), 'exchange funder links nothing');
  assert.equal(walletGroup.get('e'), walletGroup.get('f'), 'bought together in 4 tokens');
  assert.notEqual(walletGroup.get('a'), walletGroup.get('e'));
  assert.equal(groups.length, 4);
});

test('groups: creator-funded wallets are linked to the creator and marked insider', () => {
  const wallets = [{ _id: 'a', chain: [{ account: 'creator.near', kind: 'wallet', hop: 1 }], flow_out: [] }, { _id: 'b', chain: [], flow_out: [{ to: 'creator.near', near: 5 }] }];
  const entries = [{ token: 'tok.near', wallet: 'a', first_buy_ts: T0 }, { token: 'tok.near', wallet: 'b', first_buy_ts: T0 }];
  const { walletGroup, insiderEntries } = buildGroups(wallets, entries, new Map([['tok.near', { creator: 'creator.near' }]]), { cobuySeconds: 15, cobuyMinTokens: 4 });
  assert.equal(walletGroup.get('a'), walletGroup.get('b'));
  assert.ok(insiderEntries.has('tok.near|a') && insiderEntries.has('tok.near|b'));
});

const mcfg = { minutes: [60, 360, 1440], winRoi: 0.2, cobuySeconds: 15, minTokens: 3, goodScore: 68, badScore: 38 };
function mkEntries(rois, rugged = false, insider = false) {
  const entries = [], tokens = new Map(), ins = new Set();
  rois.forEach((r, i) => {
    const id = `t${i}`;
    tokens.set(id, { symbol: id, launchpad: 'nearlytrade', live_ts: T0 + i, creator: 'c', outcome: { rugged: Array.isArray(rugged) ? rugged[i] : rugged, peak_multiple: 3 } });
    entries.push({ token: id, wallet: 'w1', rank: 2, delay_s: 20, buy_near: 10, roi: { 60: r }, sold_share: { 60: 0.5 }, first_buy_ts: T0 + i, token_rugged: false });
    if (insider) ins.add(`${id}|w1`);
  });
  return { entries, tokens, ins };
}

test('verdict: steady winners in healthy tokens are good', () => {
  const { entries, tokens, ins } = mkEntries([1.5, 0.8, 0.5, 2, 0.4, 1.2]);
  const { metrics } = computeMetrics(['w1'], entries, tokens, new Map(), ins, mcfg);
  const v = ruleVerdict(metrics, 3, mcfg);
  assert.equal(metrics.tokens_n, 6); assert.equal(metrics.win_rate, 1);
  assert.equal(v.verdict, 'good'); assert.ok(v.tags.includes('smart-early'));
});

test('verdict: profit made inside rugged tokens is a rug farmer (bad)', () => {
  const { entries, tokens, ins } = mkEntries([0.9, 1.4, 0.6, 1.1], true);
  const { metrics } = computeMetrics(['w1'], entries, tokens, new Map(), ins, mcfg);
  const v = ruleVerdict(metrics, 3, mcfg);
  assert.ok(v.tags.includes('rug-farmer')); assert.equal(v.verdict, 'bad');
});

test('verdict: creator-linked entries are insiders (bad); too few tokens is unknown', () => {
  const a = mkEntries([0.5, 0.6, 0.7, 0.9], false, true);
  const m = computeMetrics(['w1'], a.entries, a.tokens, new Map(), a.ins, mcfg).metrics;
  assert.ok(ruleVerdict(m, 2, mcfg).tags.includes('insider')); assert.equal(ruleVerdict(m, 2, mcfg).verdict, 'bad');
  const b = mkEntries([2, 3]);
  const mb = computeMetrics(['w1'], b.entries, b.tokens, new Map(), b.ins, mcfg).metrics;
  assert.equal(ruleVerdict(mb, 2, mcfg).verdict, 'unknown');
});

test('AI reply parsing: plain, fenced, and prose-wrapped JSON; review validation', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Here you go: {"a":3} thanks'), { a: 3 });
  assert.equal(extractJson('no json here'), null);
  const r = normaliseReview({ verdict: 'good', confidence: 1.7, label: 'Smart early buyers', archetype: 'weird', summary: 's', reasons: ['x'], red_flags: 'oops', follow_advice: 'follow' });
  assert.equal(r.verdict, 'good'); assert.equal(r.confidence, 1); assert.equal(r.archetype, 'unclear'); assert.deepEqual(r.red_flags, []);
  assert.equal(normaliseReview({ verdict: 'maybe' }), null);
});

test('groups: an exchange wallet paying the same odd amount to two wallets within the hour links them; round amounts do not', () => {
  const w = (id, near, ts) => ({ _id: id, chain: [{ account: 'cex', kind: 'hub', hop: 1 }], funders: [{ account: 'cex', kind: 'hub', near, ts }], flow_out: [] });
  const wallets = [w('a', 17.706, T0), w('b', 17.706, T0 + 20 * MIN), w('c', 10, T0), w('d', 10, T0 + 5 * MIN), w('e', 17.706, T0 + 3 * 3600e3)];
  const { walletGroup } = buildGroups(wallets, [], new Map(), { cobuySeconds: 15, cobuyMinTokens: 4 });
  assert.equal(walletGroup.get('a'), walletGroup.get('b'), 'same odd amount, 20 min apart');
  assert.notEqual(walletGroup.get('c'), walletGroup.get('d'), 'round amounts are everyone');
  assert.notEqual(walletGroup.get('a'), walletGroup.get('e'), 'hours apart');
});
