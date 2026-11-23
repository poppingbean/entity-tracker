// Is the online AI (NEAR AI, as the worker uses it) doing the work right now? The operator pass on this machine (scripts/operator-ai-daily.sh) asks
// this first and only answers requests while the online AI cannot: out of credits, keys refused, unreachable, or no worker running.
//   node src/cli.js ai-online [--state <dir>]   prints { mode: 'online' | 'local', why, source, ... }; with --state, the mode is kept in <dir>/mode.json
//                                                and every change of mode is added to <dir>/mode.log
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const HEARTBEAT_STALE_MS = 10 * 60e3; // the worker reports every minute

/**
 * The decision from the worker's heartbeat (meta 'worker') and, when that cannot tell, a probe of NEAR AI from here. Pure.
 *   worker reporting, AI ok           → online
 *   worker reporting, AI failing      → local (its error: credits, refused key, outage)
 *   worker reporting, AI off / no key → local
 *   worker silent for 10 min          → local (nobody is calling the online AI)
 *   worker reporting, no AI call yet  → the probe decides
 * Returns { mode, why, source, needProbe }.
 */
export function decide(worker, { now = Date.now(), probe = null } = {}) {
  const ts = worker?.ts || 0, ai = worker?.ai || null;
  if (!ts || now - ts > HEARTBEAT_STALE_MS) return { mode: 'local', source: 'worker', why: ts ? `the worker has not reported for ${Math.round((now - ts) / 60e3)} min` : 'no worker has reported' };
  if (!ai?.enabled) return { mode: 'local', source: 'worker', why: 'the worker has no NEAR AI key' };
  if (ai.ok === true) return { mode: 'online', source: 'worker', why: `the worker's NEAR AI calls succeed (${ai.model || 'model unknown'})` };
  if (ai.ok === false) return { mode: 'local', source: 'worker', why: `the worker's NEAR AI calls fail: ${String(ai.error || 'unknown error').slice(0, 200)}` };
  if (!probe) return { mode: null, source: 'worker', why: 'the worker has made no NEAR AI call yet', needProbe: true };
  return probe.ok ? { mode: 'online', source: 'probe', why: 'NEAR AI answered a test request' } : { mode: 'local', source: 'probe', why: `NEAR AI did not answer a test request: ${String(probe.error || 'unknown error').slice(0, 200)}` };
}

/** One small NEAR AI request from here (never through the operator folder). */
async function probeNearAi() {
  const { checkAi, aiStatus } = await import('./tools/nearai.js');
  const keep = config.ai.operatorDir;
  config.ai.operatorDir = '';
  try { await checkAi(); return { ok: aiStatus.ok === true, error: aiStatus.error }; } finally { config.ai.operatorDir = keep; }
}

/** The decision now: the heartbeat first, the probe only when needed. */
export async function onlineStatus({ now = Date.now() } = {}) {
  const { metaGet } = await import('../db.js');
  const worker = await metaGet('worker');
  let d = decide(worker, { now });
  if (d.needProbe) d = decide(worker, { now, probe: await probeNearAi() });
  return { ...d, worker_ts: worker?.ts || null, checked_ts: now };
}

/** Keep the mode in <dir>/mode.json; a change is added to <dir>/mode.log. Returns { ...status, since, changed, previous }. */
export function noteMode(dir, status, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mode.json');
  let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const changed = !prev || prev.mode !== status.mode;
  const since = changed ? now : prev.since;
  fs.writeFileSync(file, JSON.stringify({ mode: status.mode, why: status.why, since, checked_ts: now }, null, 1));
  if (changed) fs.appendFileSync(path.join(dir, 'mode.log'), `${new Date(now).toISOString()}  ${prev?.mode || '-'} -> ${status.mode}  ${status.why}\n`);
  return { ...status, since, changed, previous: prev?.mode || null };
}
