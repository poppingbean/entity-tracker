// The operator pass runs beside the online AI and works only while that one cannot (src/ai/online.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, noteMode, HEARTBEAT_STALE_MS } from '../src/ai/online.js';

const now = 1_800_000_000_000;
const beat = (ai, ago = 30e3) => ({ ts: now - ago, ai: { enabled: true, model: 'm', ...ai } });

test('online AI status: the worker heartbeat decides, the probe only when it cannot', () => {
  assert.equal(decide(beat({ ok: true }), { now }).mode, 'online');
  const out = decide(beat({ ok: false, error: 'NEAR AI 402: insufficient credits' }), { now });
  assert.equal(out.mode, 'local'); assert.match(out.why, /402/);
  assert.equal(decide(beat({ ok: true }, HEARTBEAT_STALE_MS + 1), { now }).mode, 'local', 'a silent worker calls no AI');
  assert.equal(decide(null, { now }).mode, 'local');
  assert.equal(decide({ ts: now, ai: { enabled: false } }, { now }).mode, 'local');
  const unsure = decide(beat({ ok: null }), { now });
  assert.equal(unsure.needProbe, true); assert.equal(unsure.mode, null);
  assert.equal(decide(beat({ ok: null }), { now, probe: { ok: true } }).mode, 'online');
  assert.equal(decide(beat({ ok: null }), { now, probe: { ok: false, error: 'timed out' } }).mode, 'local');
});

test('online AI status: the mode is kept, and each change is logged once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aion-'));
  const a = noteMode(dir, { mode: 'online', why: 'ok' }, now);
  assert.equal(a.changed, true); assert.equal(a.since, now);
  const b = noteMode(dir, { mode: 'online', why: 'ok' }, now + 900e3);
  assert.equal(b.changed, false); assert.equal(b.since, now, 'since stays at the change');
  const c = noteMode(dir, { mode: 'local', why: 'credits' }, now + 1800e3);
  assert.equal(c.changed, true); assert.equal(c.previous, 'online');
  const log = fs.readFileSync(path.join(dir, 'mode.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 2); assert.match(log[1], /online -> local  credits/);
});
