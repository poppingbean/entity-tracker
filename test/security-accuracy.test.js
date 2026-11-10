// Security accuracy (src/accuracy/security.js): hand-built cases, detections, firewall and audits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { casesAccuracy, detectionsAccuracy, auditsAccuracy, contractTruth, firewallAccuracy, byKind, SMALL } from '../src/accuracy/security.js';

const H = (...e) => e.map(([ts, status, by]) => ({ ts, status, by, kind: 'exchange_drain' }));
const inc = (id, status_history, extra = {}) => ({ _id: id, kind: 'exchange_drain', started_ts: 0, status_history, ...extra });
const row = (i, label) => ({ inc: i, truth: { label, source: 'x' } });
const MIN = 60e3, HR = 3600e3;

test('a retracted case lowers precision and is listed with the hours it stayed public', () => {
  const good = row(inc('g', H([10 * MIN, 'confirmed', 'rules'], [10 * MIN + 5 * HR, 'cleared', 'operator'])), 'good');
  const bad = row(inc('b', H([30 * MIN, 'confirmed', 'rules'])), 'bad');
  const r = casesAccuracy([good, bad]);
  assert.equal(r.called, 2); assert.equal(r.precision, 0.5);
  assert.deepEqual(r.retracted, [{ id: 'g', hours_public: 5 }]);
  assert.equal(r.note, SMALL);
});

test('a report-only case is a miss for recall; time to detect uses the first rules entry', () => {
  const byRules = row(inc('a', H([20 * MIN, 'confirmed', 'rules'], [90 * MIN, 'confirmed', 'report'])), 'bad');
  const byReport = row(inc('r', H([5 * MIN, 'suspected', 'rules'], [100 * MIN, 'confirmed', 'report'])), 'bad');
  const r = casesAccuracy([byRules, byReport]);
  assert.equal(r.recall_by_rules, 0.5); assert.equal(r.time_to_detect_min.median, 20); assert.equal(r.time_to_detect_min.n, 1);
});

test('loss ratio uses the tracer figure, not the reported one', () => {
  const r = casesAccuracy([row(inc('a', H([1, 'confirmed', 'rules']), { confirmed_by: { loss_usd: 100 }, traced_usd: 90 }), 'bad')]);
  assert.equal(r.loss_ratio.median, 0.9); assert.equal(r.loss_ratio.within_25pct, 1);
});

test('unlabelled cases are counted and excluded; found later counts long gaps', () => {
  const x = row(inc('u', H([1, 'confirmed', 'rules'])), null);
  const late = row(inc('l', H([9 * 86400e3, 'confirmed', 'rules'])), 'bad');
  const r = casesAccuracy([x, late], { alertMaxAgeDays: 7 });
  assert.equal(r.unlabelled, 1); assert.equal(r.found_later, 1); assert.equal(r.n, 1);
});

test('by kind: only with 5+ labelled cases', () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(inc('k' + i, H([1, 'confirmed', 'rules'])), 'bad'));
  assert.equal(byKind(rows).exchange_drain.precision, 1);
  assert.deepEqual(byKind(rows.slice(0, 2)).exchange_drain, { n: 2 });
});

test('detections: suspect against the label', () => {
  const r = detectionsAccuracy([{ det: { verdict: 'suspect', kind: 'protocol' }, truth: { label: 'bad' } }, { det: { verdict: 'suspect', kind: 'protocol' }, truth: { label: 'good' } }, { det: { verdict: 'own_funds' }, truth: { label: 'good' } }, { det: { verdict: 'suspect' }, truth: { label: null } }]);
  assert.deepEqual([r.tp, r.fp, r.tn, r.unlabelled], [1, 1, 1, 1]);
});

test('contract truth order and per-level bad rate', () => {
  assert.equal(contractTruth({ manual: 'good', rugged: true }).label, 'good');
  assert.equal(contractTruth({ rugged: true }).label, 'bad');
  assert.equal(contractTruth({ first_ts: 0 }, 31 * 86400e3).label, 'good');
  assert.equal(contractTruth({ first_ts: 10 * 86400e3 }, 31 * 86400e3).label, null);
  const r = auditsAccuracy([{ level: 'high', truth: { label: 'bad' } }, { level: 'high', truth: { label: 'good' } }, { level: 'low', truth: { label: 'good' } }, { level: 'low', truth: { label: null } }], 4);
  assert.equal(r.per_level.high.bad_rate, 0.5); assert.equal(r.per_level.low.audited, 2); assert.equal(r.per_level.low.labelled, 1); assert.equal(r.auc, 0.75);
});

test('firewall: a flagged account counts as blocked; a trusted look-alike is a false alarm', () => {
  const check = (id) => (id === 'bad.near' ? { verdict: 'block', findings: [{ code: 'flagged_receiver' }] } : id === 'wrap.nea' ? { verdict: 'block', findings: [{ code: 'lookalike_receiver' }] } : { verdict: 'ok', findings: [] });
  const r = firewallAccuracy(['bad.near', 'missed.near'], ['wrap.near', 'wrap.nea'], check);
  assert.equal(r.blocked_bad.share, 0.5); assert.deepEqual(r.blocked_bad.missed, ['missed.near']);
  assert.equal(r.false_alarm_good.share, 0.5); assert.deepEqual(r.false_alarm_good.rows, [{ account: 'wrap.nea', verdict: 'block', finding: 'lookalike_receiver' }]);
});
