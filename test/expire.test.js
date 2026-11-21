import { test } from 'node:test';
import assert from 'node:assert/strict';
import { everHack, lastActivity, isQuiet } from '../src/incident/expire.js';

const H = 3600e3, NOW = 1_000 * H, Q = 72 * H;

test('a case ever called a hack is never returned to normal', () => {
  assert.equal(everHack({ tags: [{ tag: 'hack' }, { tag: 'review' }] }), true, 'tagged Hack, then Watching (realkingdom9695.near)');
  assert.equal(everHack({ status_history: [{ status: 'confirmed' }, { status: 'suspected' }] }), true);
  assert.equal(everHack({ confirmed_by: { by: 'operator' } }), true);
  assert.equal(everHack({ verdict: 'hack' }), true);
  assert.equal(everHack({ tags: [{ tag: 'drain?' }, { tag: 'review' }] }), false);
  assert.equal(isQuiet({ status: 'suspected', tags: [{ tag: 'hack', ts: 0 }, { tag: 'review', ts: 0 }] }, 'incident', 0, NOW, Q), false);
});

test('the clock runs from the newest of the case and its signals (a report, a move, news)', () => {
  const d = { ts: 10 * H, tags: [{ tag: 'drain?', ts: 10 * H }, { tag: 'review', ts: 20 * H }] };
  assert.equal(lastActivity(d), 20 * H);
  assert.equal(lastActivity(d, [null, 500 * H, undefined]), 500 * H, 'a report or a move restarts the clock');
  assert.equal(isQuiet(d, 'detection', lastActivity(d), NOW, Q), true, 'quiet for 980 h');
  assert.equal(isQuiet(d, 'detection', lastActivity(d, [NOW - 71 * H]), NOW, Q), false, 'news 71 h ago keeps it open');
  assert.equal(isQuiet(d, 'detection', lastActivity(d, [NOW - 72 * H]), NOW, Q), true, 'exactly 72 h: back to normal');
});

test('only open cases move: Large transfer and Watching findings, suspected investigations', () => {
  const old = 0;
  assert.equal(isQuiet({ tags: [{ tag: 'drain?' }] }, 'detection', old, NOW, Q), true, 'Large transfer');
  assert.equal(isQuiet({ tags: [] }, 'detection', old, NOW, Q), true, 'a finding with no tag yet is a Large transfer');
  assert.equal(isQuiet({ tags: [{ tag: 'drain?' }, { tag: 'safe' }] }, 'detection', old, NOW, Q), false, 'already Normal');
  assert.equal(isQuiet({ tags: [], verdict: 'own_funds' }, 'detection', old, NOW, Q), false, 'own funds: already shown as Normal');
  assert.equal(isQuiet({ status: 'suspected' }, 'incident', old, NOW, Q), true);
  for (const status of ['confirmed', 'cleared', 'nothing_found']) assert.equal(isQuiet({ status }, 'incident', old, NOW, Q), false, status);
});
