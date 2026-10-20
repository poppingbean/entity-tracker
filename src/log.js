// Console log + (once the database is up) a 30-day event log in MongoDB. Never throws.
import { col } from './db.js';

export const recentLogs = [];
let seq = 0, queue = [], dbReady = false, timer = null;

export function log(level, msg, data) {
  console.log(`${new Date().toISOString()} ${level.padEnd(5)} ${msg}${data ? ' ' + JSON.stringify(data) : ''}`);
  const e = { id: ++seq, ts: Date.now(), level, msg: String(msg).slice(0, 1000), data: data ?? null };
  recentLogs.push(e); if (recentLogs.length > 300) recentLogs.shift();
  queue.push({ ...e, at: new Date(e.ts) });
  if (queue.length > 5000) queue.splice(0, queue.length - 5000);
  if (dbReady) schedule();
}
export const info = (m, d) => log('INFO', m, d);
export const warn = (m, d) => log('WARN', m, d);
export const error = (m, d) => log('ERROR', m, d);

function schedule() { if (!timer) timer = setTimeout(flush, 2000); timer.unref?.(); }
async function flush() {
  timer = null;
  if (!queue.length) return;
  const batch = queue; queue = [];
  try { await col('events').insertMany(batch, { ordered: false }); }
  catch { queue = batch.concat(queue).slice(-5000); } // keep for the next try
}
export function enableDbLog() { dbReady = true; if (queue.length) schedule(); }
export async function flushLogs() { if (dbReady) await flush(); }
