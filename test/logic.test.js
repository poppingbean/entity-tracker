// Unit tests for the pure logic: early entries / outcomes, grouping, metrics + verdicts, AI reply parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntries, buildOutcome, buildLedger, priceAt, priceSeries, evalRoi } from '../src/collect/analyze.js';
import { buildGroups } from '../src/graph/cluster.js';
import { computeMetrics, ruleVerdict, winTag } from '../src/evaluate/metrics.js';
import { extractJson } from '../src/ai/nearai.js';
import { positionPnl } from '../src/sim/portfolio.js';
import { redact } from '../src/web/redact.js';
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

// ---------------------------------------------------------------- contract audit
import { staticAnalysis, codeFactors } from '../src/audit/analysis.js';
import { nearFactors, nearTaxFactors, scoreFromFactors, trustScoreFromFactors, sellBehaviourFactors, hasBackdoor } from '../src/audit/factors.js';
import { summarizeAudit } from '../src/audit/service.js';
import { applyRules } from '../src/scanner/rules.js';

/** A tiny valid WASM module that exports the given (empty) functions, to exercise the real code analysis. */
function wasmWith(names) {
  const leb = (n) => [n]; // all counts / sizes in these tests are < 128
  const enc = (s) => [...Buffer.from(s)];
  const section = (id, body) => [id, ...leb(body.length), ...body];
  const types = section(1, [1, 0x60, 0, 0]);
  const funcs = section(3, [names.length, ...names.map(() => 0)]);
  const exports = section(7, [names.length, ...names.flatMap((n, i) => [n.length, ...enc(n), 0x00, i])]);
  const code = section(10, [names.length, ...names.flatMap(() => [2, 0, 0x0b])]);
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...funcs, ...exports, ...code]);
}

test('audit: WASM analysis finds a fake storage method and privileged methods, ignores getters and standards', () => {
  const stat = staticAnalysis(wasmWith(['ft_transfer', 'ft_balance_of', 'storage_deposit', 'storage_unstake', 'blacklist_add', 'get_owner', 'on_transfer_callback']), true);
  assert.deepEqual(stat.fakeStorage, ['storage_unstake']);
  assert.deepEqual(stat.privilegedNames, ['blacklist_add']);
  assert.equal(stat.nonStandard.length, 0, 'standard methods, getters and callbacks are not "non-standard"');
  assert.equal(staticAnalysis(Buffer.from('not wasm'), true), null);
});

test('audit: a locked contract with a backdoor is critical and earns no trust; a clean locked contract earns trust', () => {
  const stat = staticAnalysis(wasmWith(['ft_transfer', 'storage_unstake']), true);
  const beh = { sellOk: 55, sellFail: 14, buys: 30, blockedSellers: 0, successfulSellers: 20, privilegedCalls: 24, topPrivileged: { who: 'owner.near', method: 'storage_unstake', count: 24 } };
  const cf = codeFactors(stat, beh);
  assert.equal(hasBackdoor(cf), true);
  const factors = [...nearFactors([], { backdoor: hasBackdoor(cf) }), ...cf];
  const risk = scoreFromFactors(factors), trust = trustScoreFromFactors(factors);
  assert.ok(risk.score >= 70 && risk.level === 'critical', `risk ${risk.score}`);
  assert.ok(trust.score <= 10, 'confirmed malicious caps trust');
  assert.equal(factors.find((f) => f.key === 'noFullAccessKey').hit, false, 'immutability is not reassuring when the code has a backdoor');

  const clean = nearFactors([], { backdoor: false });
  assert.equal(clean.find((f) => f.key === 'noFullAccessKey').hit, true);
  assert.equal(scoreFromFactors(clean).level, 'low');
});

test('audit: a full-access key is a critical finding; honeypot sell pattern needs several blocked wallets', () => {
  const withKey = nearFactors([{ public_key: 'k', access_key: { permission: 'FullAccess' } }]);
  assert.equal(withKey.find((f) => f.key === 'fullAccessKeyExists').hit, true);
  assert.ok(scoreFromFactors(withKey).score >= 35);
  const f = (beh) => Object.fromEntries(sellBehaviourFactors(beh).map((x) => [x.key, x.hit]));
  assert.equal(f({ sellOk: 0, sellFail: 6, buys: 10, blockedSellers: 4, successfulSellers: 0 }).sellsFailing, true);
  assert.equal(f({ sellOk: 30, sellFail: 6, buys: 10, blockedSellers: 4, successfulSellers: 20 }).sellsFailing, false, 'selling works for others: not a honeypot');
  assert.equal(nearTaxFactors({ buy_bps: 200, sell_bps: 200, pairs: [1] }).find((x) => x.key === 'taxLow').hit, true);
  assert.equal(nearTaxFactors({ buy_bps: 3500, sell_bps: 100 }).find((x) => x.key === 'taxExtreme').hit, true);
});

test('audit: summary for the gates, and the contract_audit_ok gate', () => {
  assert.equal(summarizeAudit({ notFound: true }).available, false);
  const factors = [...nearFactors([]), ...codeFactors(staticAnalysis(wasmWith(['ft_transfer', 'storage_unstake']), true), null)];
  const doc = { notFound: false, risk: scoreFromFactors(factors), trust: trustScoreFromFactors(factors), raw: { accessKeys: [], code: { privilegedNames: [], nonStandard: [] }, behaviour: null }, fetchedAt: 1 };
  const sum = summarizeAudit(doc);
  assert.equal(sum.available, true); assert.deepEqual(sum.confirmed_malicious.map((c) => c.key), ['fakeStorageMethod']);

  const base = { pool: { quoteAccepted: true, route: 'direct', lpLocked: true, nearReserve: 200, quoteSymbol: 'wNEAR', quoteForBuy: { tokensOut: 1 } }, contract: { matchesTemplate: true }, market: { mcapUsd: 20000 },
    trading: { uniqueBuyers: 30, creatorSold: false, priceMultipleSinceFirstTrade: 1, buyNear: 100, sellNear: 10, syncBuyClusters: 0 }, launch: { tax: null }, wallets: { linkedBuyerShare: 0, creatorFundedBuyers: [], creator: null }, intel: null };
  assert.equal(applyRules({ ...base, audit: { available: false } }).gates.find((g) => g.id === 'contract_audit_ok').ok, true, 'no audit: not blocked');
  assert.equal(applyRules({ ...base, audit: sum }).gates.find((g) => g.id === 'contract_audit_ok').ok, false, 'a confirmed backdoor fails the gate');
});

test('deep links: wallets joined through ordinary wallets up to 3 hops; profiled network wallets make the extra hops visible', () => {
  const early = [
    { _id: 'a', chain: [], funders: [], flow_out: [{ to: 'x', near: 5 }] },       // a paid x
    { _id: 'b', chain: [{ account: 'boss', kind: 'wallet', hop: 1 }], funders: [{ account: 'boss', kind: 'wallet', near: 9 }], flow_out: [] },
    { _id: 'c', chain: [], funders: [], flow_out: [] },
  ];
  const x = { _id: 'x', kind: 'wallet', chain: [{ account: 'boss', kind: 'wallet', hop: 1 }], funders: [{ account: 'boss', kind: 'wallet', near: 6 }], flow_out: [] }; // boss funded x
  const none = buildGroups(early, [], new Map(), { cobuySeconds: 15, cobuyMinTokens: 4 }, []);
  assert.notEqual(none.walletGroup.get('a'), none.walletGroup.get('b'), 'without the network wallet the link is invisible');
  const withNet = buildGroups(early, [], new Map(), { cobuySeconds: 15, cobuyMinTokens: 4 }, [x]);
  assert.equal(withNet.walletGroup.get('a'), withNet.walletGroup.get('b'), 'a -> x <- boss -> b is 3 hops');
  assert.notEqual(withNet.walletGroup.get('a'), withNet.walletGroup.get('c'));
  const g = withNet.groups.find((gr) => gr.members.includes('a'));
  assert.ok(g.links.some((l) => l.type === 'deep_link'), 'recorded as a deep link');
  assert.equal(g.nodeDepth.boss, 1, 'boss is one hop from b');
  assert.equal(g.nodeDepth.x, 1);
  const shallow = buildGroups(early, [], new Map(), { cobuySeconds: 15, cobuyMinTokens: 4, deepDepth: 1 }, [x]);
  assert.notEqual(shallow.walletGroup.get('a'), shallow.walletGroup.get('b'), 'depth 1 does not reach');
});

test('deep links: exchanges / hubs and busy distributors are never walked through', () => {
  const hubKind = [
    { _id: 'a', chain: [], funders: [], flow_out: [{ to: 'x', near: 5 }] },
    { _id: 'b', chain: [], funders: [{ account: 'x', kind: 'wallet', near: 5 }], flow_out: [] },
  ];
  const hubX = { _id: 'x', kind: 'hub', chain: [], funders: [], flow_out: [] };
  const r = buildGroups(hubKind, [], new Map(), { cobuySeconds: 15, cobuyMinTokens: 4 }, [hubX]);
  assert.notEqual(r.walletGroup.get('a'), r.walletGroup.get('b'), 'a hot wallet in the middle proves nothing');
  const crowd = Array.from({ length: 20 }, (_, i) => ({ _id: `w${i}`, chain: [], funders: [], flow_out: [{ to: 'svc', near: 5 }] }));
  const r2 = buildGroups(crowd, [], new Map(), { cobuySeconds: 15, cobuyMinTokens: 4 }, []);
  assert.equal(new Set(crowd.map((w) => r2.walletGroup.get(w._id))).size, 20, 'an account reached by more than 15 wallets is a service');
});

test('tags: win80 / win50 / win30 / loss by the share of tokens ended in profit; unrated until enough tokens', () => {
  assert.equal(winTag(0.9, 5, 3), 'win80'); assert.equal(winTag(0.8, 5, 3), 'win80');
  assert.equal(winTag(0.6, 5, 3), 'win50'); assert.equal(winTag(0.5, 4, 3), 'win50');
  assert.equal(winTag(0.35, 6, 3), 'win30'); assert.equal(winTag(0.3, 3, 3), 'win30');
  assert.equal(winTag(0.2, 5, 3), 'loss'); assert.equal(winTag(0, 3, 3), 'loss');
  assert.equal(winTag(1, 2, 3), 'unrated'); assert.equal(winTag(null, 0, 3), 'unrated');
  const rois = [0.5, -0.2, 1.2, 0.1, -0.6];
  const { entries, tokens } = (function () { const t = new Map(), es = []; rois.forEach((r, i) => { const id = `p${i}`; t.set(id, { symbol: id, live_ts: T0 + i, creator: 'c', outcome: { rugged: false } }); es.push({ token: id, wallet: 'w1', rank: 2, delay_s: 20, buy_near: 10, roi: { 60: r }, sold_share: { 60: 0 }, first_buy_ts: T0 + i, token_rugged: false }); }); return { entries: es, tokens: t }; })();
  const { metrics } = computeMetrics(['w1'], entries, tokens, new Map([['w1', { _id: 'w1' }]]), new Set(), { minutes: [60], winRoi: 0.2, cobuySeconds: 15, minTokens: 3 });
  assert.equal(metrics.profit_rate, 0.6); assert.equal(winTag(metrics.profit_rate, metrics.tokens_n, 3), 'win50');
});

test('rugs: a deep fall with the creator selling is a rug; so is a token flagged from the creator blacklist', () => {
  const lcfg = { minutes: cfg.minutes, rugDrawdown: 0.9, softRugDrawdown: 0.7 };
  const mk = (extra = []) => [trade('a', true, 10, 1000, 1), trade('b', true, 20, 1000, 5), ...extra, trade('x', false, 5, 1000, 40), trade('x', false, 1, 1000, 70)];
  // peak price 0.02, ends at 0.001 -> collapse >= 0.9 without the creator selling
  assert.equal(buildOutcome(token, mk(), T0 + 120 * MIN, lcfg).rug_kinds[0], 'price_crash');
  // peak 0.02, ends at 0.0035 (-82 %): not a crash by itself, a rug once the creator also sold
  const soft = [trade('creator.near', false, 3, 100, 50), trade('x', false, 3.5, 1000, 80)];
  const base = [trade('a', true, 10, 1000, 1), trade('b', true, 20, 1000, 5), ...soft];
  const withCreator = buildOutcome(token, base, T0 + 120 * MIN, lcfg);
  assert.ok(withCreator.drawdown >= 0.7 && withCreator.drawdown < 0.9); assert.deepEqual(withCreator.rug_kinds, ['creator_dump']); assert.equal(withCreator.rugged, true);
  const noCreator = buildOutcome(token, [trade('a', true, 10, 1000, 1), trade('b', true, 20, 1000, 5), trade('x', false, 3.5, 1000, 80)], T0 + 120 * MIN, lcfg);
  assert.equal(noCreator.rugged, false);
  const flagged = buildOutcome({ ...token, rug: { flagged: true, reason: 'creator balance fell 100% while we held' } }, [trade('a', true, 10, 1000, 1)], T0 + 5 * MIN, lcfg);
  assert.equal(flagged.rugged, true); assert.deepEqual(flagged.rug_kinds, ['flagged']); assert.match(flagged.rug_reason, /creator balance/);
});

test('profit split: realized = NEAR taken out minus the cost of tokens sold; unrealized = the rest', () => {
  // a buys 1000 tokens for 10 N at 0.01; at 30 min sells 500 for 15 N (price 0.03); at 59 min price is 0.04
  const trades = [trade('a', true, 10, 1000, 1), trade('x', true, 30, 1000, 29), trade('a', false, 15, 500, 30), trade('x', true, 40, 1000, 59)];
  const e = buildEntries(token, trades, T0 + 70 * MIN, cfg).find((x) => x.wallet === 'a');
  // at 60 min: value = 15 taken out + 500 held x 0.04 = 35; pnl 25; realized 15 - 10 x 0.5 = 10; unrealized 15
  assert.ok(Math.abs(e.roi[60] - 2.5) < 1e-9);
  const { metrics, tokens: rows } = computeMetrics(['a'], [e], new Map([['tok.near', token]]), new Map([['a', { _id: 'a' }]]), new Set(), { minutes: cfg.minutes, winRoi: 0.2, cobuySeconds: 15, minTokens: 1 });
  assert.ok(Math.abs(metrics.pnl_near - 25) < 1e-6 && Math.abs(metrics.realized_near - 10) < 1e-6 && Math.abs(metrics.unrealized_near - 15) < 1e-6);
  assert.ok(Math.abs(rows[0].realized_near + rows[0].unrealized_near - rows[0].pnl_near) < 1e-9);
  assert.ok(Math.abs(e.realized_now - 10) < 1e-6 && Math.abs(e.pnl_now - 25) < 1e-6 && Math.abs(e.unrealized_now - 15) < 1e-6);
});

test('simulated position profit split (open with a partial sale, and closed)', () => {
  const open = { status: 'open', cost_near: 10, entry_price: 0.01, held_tokens: 500, realized_near: 8, value_near: 12 }; // sold half for 8 N, rest worth 12 N
  const a = positionPnl(open);
  assert.ok(Math.abs(a.realized_pnl - 3) < 1e-9 && Math.abs(a.unrealized_pnl - 7) < 1e-9 && Math.abs(a.pnl - 10) < 1e-9);
  const b = positionPnl({ status: 'open', cost_near: 10, entry_price: 0.01, held_tokens: 1000, realized_near: 0, value_near: 6 });
  assert.ok(b.realized_pnl === 0 && Math.abs(b.unrealized_pnl + 4) < 1e-9);
  const c = positionPnl({ status: 'closed', cost_near: 10, realized_near: 4, value_near: 0 });
  assert.ok(Math.abs(c.realized_pnl + 6) < 1e-9 && c.unrealized_pnl === 0);
});

test('rugs: a token that pumped and came back to its launch price is a round-trip rug', () => {
  const lcfg = { minutes: cfg.minutes, rugDrawdown: 0.9, softRugDrawdown: 0.7, roundTripPeak: 3, roundTripBack: 1.25 };
  // launch 0.01, peak 0.04 (4x), now 0.011 (1.1x): drawdown 72 %, creator did not sell
  const rt = [trade('a', true, 10, 1000, 1), trade('b', true, 40, 1000, 5), trade('x', false, 11, 1000, 80)];
  const o = buildOutcome(token, rt, T0 + 120 * MIN, lcfg);
  assert.deepEqual(o.rug_kinds, ['round_trip']); assert.equal(o.rugged, true);
  // pumped 2x only, or still well above launch: not a rug
  assert.equal(buildOutcome(token, [trade('a', true, 10, 1000, 1), trade('b', true, 20, 1000, 5), trade('x', false, 11, 1000, 80)], T0 + 120 * MIN, lcfg).rugged, false);
  assert.equal(buildOutcome(token, [trade('a', true, 10, 1000, 1), trade('b', true, 40, 1000, 5), trade('x', false, 25, 1000, 80)], T0 + 120 * MIN, lcfg).rugged, false);
});

test('creator exit: share of the dev buy sold in the first hour and how soon; any creator sale is a rug (creator sold)', () => {
  const lcfg = { minutes: cfg.minutes, rugDrawdown: 0.9 };
  const tr = [trade('a', true, 20, 2000, 0.1), trade('creator.near', false, 19, 1900, 3), trade('b', true, 30, 1000, 4)]; // price 3x the launch price afterwards
  const o = buildOutcome({ ...token, dev_buy_near: 20 }, tr, T0 + 50 * MIN, lcfg);
  assert.ok(o.creator_exit.share > 0.9 && o.creator_exit.minutes === 3);
  assert.equal(o.rugged, true, 'any creator sale is a dump'); assert.deepEqual(o.rug_kinds, ['creator_sold'], 'not an exit rug while holders are well in profit');
  assert.equal(buildOutcome(token, tr, T0 + 50 * MIN, lcfg).creator_exit, null, 'no dev buy known: no share');
});

test('rugs: creator exit (80 %+ of the dev buy sold in the first hour) with the price now at most 1.5x launch is a rug', () => {
  const lcfg = { minutes: cfg.minutes, rugDrawdown: 0.9, creatorExitShare: 0.8 };
  const tr = (lastNear) => [trade('a', true, 20, 2000, 0.1), trade('creator.near', false, 19, 1900, 3), trade('b', true, 5, 500, 4), trade('x', false, lastNear, 500, 30)];
  // launch price 0.01; the last sale at 0.0092 -> below launch
  const down = buildOutcome({ ...token, dev_buy_near: 20 }, tr(4.6), T0 + 50 * MIN, lcfg);
  assert.equal(down.rugged, true); assert.deepEqual(down.rug_kinds, ['creator_exit']);
  // price a little above launch (1.1x): still an exit rug; well above (1.6x): a rug only because the creator sold
  assert.deepEqual(buildOutcome({ ...token, dev_buy_near: 20 }, tr(5.5), T0 + 50 * MIN, lcfg).rug_kinds, ['creator_exit']);
  assert.deepEqual(buildOutcome({ ...token, dev_buy_near: 20 }, tr(8), T0 + 50 * MIN, lcfg).rug_kinds, ['creator_sold']);
});

test('rugs: creator exit (80 %+ of the dev buy sold in the first hour) with the price at or below launch is a rug; above launch it is not', () => {
  const lcfg = { minutes: cfg.minutes, rugDrawdown: 0.9, creatorExitShare: 0.8, creatorExitBack: 1 };
  const t0 = { ...token, dev_buy_near: 20 };
  // launch 0.01; creator sells 19 N at minute 3; last trade at 0.0093: price below launch
  const down = [trade('a', true, 20, 2000, 0.1), trade('creator.near', false, 19, 2000, 3), trade('x', false, 9.3, 1000, 10)];
  const o = buildOutcome(t0, down, T0 + 20 * MIN, lcfg);
  assert.deepEqual(o.rug_kinds, ['creator_exit']); assert.equal(o.rugged, true);
  // same exit but the price is above the launch price: warning only
  const up = [trade('a', true, 20, 2000, 0.1), trade('creator.near', false, 19, 2000, 3), trade('x', true, 12, 1000, 10)];
  const o2 = buildOutcome(t0, up, T0 + 20 * MIN, lcfg);
  assert.deepEqual(o2.rug_kinds, ['creator_sold']); assert.ok(o2.creator_exit.share >= 0.8);
  // a small creator sale is not an exit, but still a rug (creator sold); a sale at or under CREATOR_SELL_RUG_NEAR is not
  const small = [trade('a', true, 20, 2000, 0.1), trade('creator.near', false, 3, 300, 3), trade('x', false, 9.3, 1000, 10)];
  assert.deepEqual(buildOutcome(t0, small, T0 + 20 * MIN, lcfg).rug_kinds, ['creator_sold']);
  assert.equal(buildOutcome(t0, small, T0 + 20 * MIN, { ...lcfg, creatorSellRugNear: 5 }).rugged, false);
});

test('public mode: thresholds, rule names, reasons and gate ids are removed from API responses', () => {
  const tok = redact('/api/token', { id: 't', rug: { flagged: true, reason: 'creator sold at launch' }, outcome: { rugged: true, rug_kinds: ['creator_exit'], rug_reason: 'x', creator_exit: { share: 0.99, minutes: 3 }, peak_multiple: 2 },
    scan: { score: 70, pass: false, failed: ['min_mcap', 'min_buyers'], decision: 'rules failed: min_mcap' }, audit: { available: true, findings: [{ key: 'fullAccessKeyExists', weight: 35, detail: '1 key' }] },
    creator_info: { launches: 3, rugged: 1, blacklisted: { ts: 1, reason: 'creator balance fell 100% while we held', source: 'scanner', token: 'a', symbol: 'A' }, tokens: [{ id: 'a', kinds: ['flagged'] }] } });
  assert.equal(tok.rug, undefined); assert.equal(tok.outcome.rug_kinds, undefined); assert.equal(tok.outcome.rug_reason, undefined); assert.equal(tok.outcome.creator_exit, true); assert.equal(tok.outcome.rugged, true); assert.equal(tok.outcome.peak_multiple, 2);
  assert.equal(tok.scan.failed, undefined); assert.equal(tok.scan.failed_n, 2); assert.ok(!/min_mcap/.test(JSON.stringify(tok)));
  assert.equal(tok.audit.findings[0].weight, undefined); assert.equal(tok.creator_info.blacklisted.reason, undefined); assert.equal(tok.creator_info.blacklisted.source, undefined); assert.equal(tok.creator_info.tokens[0].kinds, undefined);
  const cl = redact('/api/cluster', { id: 'c', rule: { score: 70, verdict: 'bad', tags: ['insider'] }, links: [{ type: 'cobuy' }, { type: 'deep_link', depth: 3 }], ai: { label: 'L', summary: 'S', reasons: ['r'], red_flags: ['f'], verdict: 'bad' }, metrics: { win_rate: 0.5, fresh_share: 0.9, sync_share: 0.8, creator_linked_share: 0.3 }, history: [{ ts: 1, verdict: 'bad', score: 40, tags: ['x'] }] });
  assert.equal(cl.rule, undefined); assert.equal(cl.links, undefined); assert.equal(cl.links_n, 2); assert.equal(cl.ai.reasons, undefined); assert.equal(cl.ai.label, 'L'); assert.equal(cl.metrics.fresh_share, undefined); assert.equal(cl.metrics.win_rate, 0.5); assert.equal(cl.history[0].tags, undefined);
  const au = redact('/api/audit', { risk: { score: 50, factors: [{ key: 'a', hit: true, weight: 30 }, { key: 'b', hit: false, weight: 12 }] }, trust: { score: 10, factors: [] }, summary: { available: true, findings: [] } });
  assert.deepEqual(au.risk.factors, [{ key: 'a', hit: true }]);
  assert.deepEqual(redact('/api/health', { ok: true }), { ok: true });
});

test('full ledger: 24 h outcome ignores later trades; the ledger and roi_now follow them', () => {
  const lcfg = { minutes: cfg.minutes, rugDrawdown: 0.9 };
  const DAY = 1440;
  const trades = [
    trade('a', true, 10, 1000, 1),        // launch price 0.01
    trade('b', true, 30, 1000, 60),       // 0.03 inside the first day
    trade('c', true, 100, 1000, DAY + 600), // 0.1 on day 2: new all-time high
    trade('c', false, 5, 1000, DAY * 5),  // 0.005 on day 6: collapsed
  ];
  const now = T0 + DAY * 6 * MIN;
  const o = buildOutcome(token, trades, now, lcfg);
  assert.ok(Math.abs(o.last_multiple - 3) < 1e-9, '24 h outcome stops at the last checkpoint');
  assert.equal(o.rugged, false);
  const L = buildLedger(token, trades, lcfg);
  assert.ok(Math.abs(L.ath_multiple - 10) < 1e-9);
  assert.equal(L.ath_after_cp, true);
  assert.ok(Math.abs(L.last_multiple - 0.5) < 1e-9);
  assert.ok(Math.abs(L.drawdown - 0.95) < 1e-9);
  assert.equal(L.collapsed, true);
  assert.equal(L.trades, 4);
  assert.equal(L.after_cp.trades, 2);
  assert.equal(L.last_trade_ts, T0 + DAY * 5 * MIN);
  const a = buildEntries(token, trades, now, { ...cfg, minutes: cfg.minutes }).find((e) => e.wallet === 'a');
  assert.ok(Math.abs(a.roi[1440] - 2) < 1e-9, 'checkpoint ROI (what verdicts use) is the 24 h one');
  assert.ok(Math.abs(a.roi_now - (-0.5)) < 1e-9, 'roi_now uses the latest price');
});

test('creator sold after the first 24 h: the ledger sees it, and a ledger flag reads as creator sold', () => {
  const lcfg = { minutes: cfg.minutes, rugDrawdown: 0.9 };
  const trades = [trade('a', true, 10, 1000, 1), trade('b', true, 30, 1000, 60), trade('creator.near', false, 4, 100, 1440 * 3)];
  assert.equal(buildOutcome(token, trades, T0 + 1440 * 4 * MIN, lcfg).rugged, false, 'the 24 h outcome cannot see a later sale');
  const L = buildLedger(token, trades, lcfg);
  assert.equal(L.creator_sell_near_after_cp, 4); assert.equal(L.creator_first_sell_after_cp_ts, T0 + 1440 * 3 * MIN);
  const o = buildOutcome({ ...token, rug: { flagged: true, source: 'ledger', reason: 'creator sold 4.00 N after the first 24 h' } }, trades, T0 + 1440 * 4 * MIN, lcfg);
  assert.equal(o.rugged, true); assert.deepEqual(o.rug_kinds, ['creator_sold']); assert.match(o.rug_reason, /after the first 24 h/);
});
