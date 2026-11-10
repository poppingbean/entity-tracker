// Ground truth for security verdicts (src/accuracy/truth.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextHistory, incidentTruth, detectionTruth, accountTruth, historyFromStored } from '../src/accuracy/truth.js';

const DAY = 86400e3, NOW = 1800000000000;

test('nextHistory: nothing when unchanged, an entry on a change, capped at 30', () => {
  assert.deepEqual(nextHistory(undefined, 'suspected', { status: 'suspected' }, 'rules', 1), []);
  assert.deepEqual(nextHistory(undefined, 'suspected', { status: 'confirmed', kind: 'wallet_drainer' }, 'rules', 5), [{ ts: 5, status: 'confirmed', kind: 'wallet_drainer', by: 'rules' }]);
  const h = [{ ts: 1, status: 'confirmed', kind: null, by: 'rules' }];
  assert.equal(nextHistory(h, 'confirmed', { status: 'confirmed' }, 'rules', 2).length, 1);
  assert.equal(nextHistory(h, 'confirmed', { status: 'cleared' }, 'operator', 2)[1].by, 'operator');
  const long = Array.from({ length: 30 }, (_, i) => ({ ts: i, status: i % 2 ? 'a' : 'b', kind: null, by: 'rules' }));
  assert.equal(nextHistory(long, 'a', { status: 'zz' }, 'rules', 99).length, 30);
});

test('incidentTruth: priority order', () => {
  assert.deepEqual(incidentTruth({ _id: 'x', confirmed_by: { source: 'https://x' } }, 'good'), { label: 'good', source: 'manual' });
  assert.deepEqual(incidentTruth({ confirmed_by: { source: 'https://rekt.news/x' } }), { label: 'bad', source: 'public_report' });
  assert.deepEqual(incidentTruth({ confirmed_by: { source: null } }), { label: 'bad', source: 'operator_confirm' });
  assert.deepEqual(incidentTruth({ status: 'cleared', cleared: { by: 'operator', ts: NOW } }, null, NOW), { label: 'good', source: 'operator_clear' });
  assert.equal(incidentTruth({ status: 'cleared', cleared: { ts: NOW - 3 * DAY } }, null, NOW).label, null, 'a review clear needs 14 days');
  assert.deepEqual(incidentTruth({ status: 'cleared', cleared: { ts: NOW - 15 * DAY } }, null, NOW), { label: 'good', source: 'review_clear' });
  assert.deepEqual(incidentTruth({ status: 'confirmed' }), { label: null, source: null });
  assert.equal(incidentTruth({ _id: 'a' }, [{ kind: 'incident', id: 'a', label: 'bad' }]).source, 'manual');
});

test('detectionTruth', () => {
  assert.equal(detectionTruth({ verdict: 'suspect' }, { label: 'bad', source: 'public_report' }).label, 'bad');
  assert.equal(detectionTruth({ verdict: 'own_funds', ts: NOW - 20 * DAY }, null, null, NOW).label, 'good');
  assert.equal(detectionTruth({ verdict: 'own_funds', ts: NOW - 2 * DAY }, null, null, NOW).label, null);
  assert.equal(detectionTruth({ verdict: 'suspect' }, null).label, null);
});

test('accountTruth', () => {
  assert.equal(accountTruth('a', [{ role: 'attacker', truth: 'bad' }]).label, 'bad');
  assert.equal(accountTruth('a', [{ role: 'attacker', truth: 'good' }]).label, null);
  assert.equal(accountTruth('a', [{ role: 'victim', truth: 'bad' }]).label, null, 'a victim is not bad');
  assert.equal(accountTruth('wrap.near', [], null, 'service/router').label, 'good');
  assert.equal(accountTruth('bob.near', [], null, 'person/wallet').label, null);
});

test('historyFromStored: first status from tags, current status last', () => {
  const h = historyFromStored({ status: 'cleared', kind: 'x', first_seen_ts: 5, tags: [{ tag: 'review', ts: 5 }, { tag: 'safe', ts: 9, by: 'operator' }] });
  assert.deepEqual(h.map((e) => [e.status, e.by]), [['suspected', 'rules'], ['cleared', 'operator']]);
  assert.deepEqual(historyFromStored({ status: 'suspected', first_seen_ts: 3, tags: [] }).map((e) => e.status), ['suspected']);
});
