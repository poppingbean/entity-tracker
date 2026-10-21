// Fetch a token the tracker has never seen (someone opened /tokens/<account> or searched for it): find its launch on chain, read its trades
// and early buyers, audit the contract and run the analysis once, in the background. Wallet profiling, groups and tags follow in the normal
// worker loop. Safe to ask for repeatedly: one job per token, and a token already in the database is just processed again.
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { adapters } from '../launchpads.js';
import { accountRows, fetchTxs } from '../near/indexer.js';
import { saveLaunches } from './launches.js';
import { processToken } from './process.js';
import { followToken } from './ledger.js';
import { auditNearContract, validNearAddress } from '../audit/service.js';
import { analyseOnDemand } from '../scanner/pipeline.js';
import { flagRug } from './rugs.js';

const SUFFIX = [[/\.nearlytrade\.near$/, 'nearlytrade'], [/\.(v2-)?launchpad\.justhoot\.near$/, 'justhoot'], [/\.meme-cooking\.near$/, 'memecooking'], [/\.gaypad\.j1-racing\.near$/, 'gaypad'], [/\.tkn\.near$/, 'tkn'], [/\.qlyphs\.near$/, 'qlyphs']];
const jobs = new Map(); // token -> { state: 'running' | 'done' | 'error', step, message, started, finished }
const MAX_JOBS = 3;

export const jobStatus = (id) => jobs.get(id) || null;

/** Look in the token's oldest transactions for a launch event of a supported launchpad. */
async function findLaunch(id) {
  const guess = SUFFIX.find(([re]) => re.test(id))?.[1];
  const order = guess ? [guess, ...Object.keys(adapters).filter((x) => x !== guess)] : Object.keys(adapters);
  const { rows } = await accountRows(id, { desc: false, maxRows: 40 });
  if (!rows.length) throw new Error('this account has no transactions on chain (it does not exist, or nothing ever happened on it)');
  const txs = await fetchTxs(rows.filter((r) => r.ok).map((r) => r.hash));
  for (const name of order) for (const tx of txs) { if (tx.failed) continue; if (adapters[name].parse(tx).some((l) => l.token === id)) return { launchpad: name, tx }; }
  throw new Error('not a token launched on a supported launchpad (nearly.trade, justhoot, meme.cooking, gaypad, tkn, qlyphs)');
}

async function run(id, job) {
  const step = (s) => { job.step = s; };
  let t = await col('tokens').findOne({ _id: id });
  if (!t) {
    step('looking for its launch on chain');
    const { launchpad, tx } = await findLaunch(id);
    await saveLaunches(launchpad, [tx]);
    t = await col('tokens').findOne({ _id: id });
    if (!t) throw new Error('the launch was found but could not be stored');
    // an old launch must not be bought by the simulated wallet; the on-demand analysis below covers it
    const old = Date.now() - t.live_ts > config.scan.maxTokenAgeMinutes * 60e3;
    await col('tokens').updateOne({ _id: id }, { $set: { on_demand_ts: Date.now(), ...(old && !t.track_only ? { scan_done: true, scan: { ts: Date.now(), imported: true, decision: 'fetched on demand' } } : {}) } });
    const bl = await col('blacklist').findOne({ token: id }); // a creator already blacklisted for this very token
    if (bl) await flagRug(id, { source: bl.source || 'tracker', reason: bl.reason, creator: bl._id, ts: bl.ts }).catch(() => {});
  }
  if (t.status === 'awaiting_pool') { job.message = 'The token exists but has no pool yet; it is checked again every 10 minutes.'; return; }
  if (t.status === 'skipped_quote') { job.message = 'Its pool is quoted in a token that cannot be valued in NEAR, so trades are not read.'; return; }
  const lastCp = config.outcome.minutes[config.outcome.minutes.length - 1] * 60e3;
  for (let i = 0; i < 30; i++) {
    t = await col('tokens').findOne({ _id: id });
    step(`reading trades (${t.trades_n || 0} so far)`);
    const r = await processToken(t);
    if (r.done || Date.now() - t.live_ts < lastCp) break;
  }
  // past its first 24 h: read the rest of its history up to now (the full ledger)
  t = await col('tokens').findOne({ _id: id });
  if (t.status === 'done' && config.ledger.enabled) for (let i = 0; i < 40; i++) {
    step(`reading the full ledger (${t.trades_n || 0} trades so far)`);
    if ((await followToken(t, { passes: 3 })).caughtUp) break;
    t = await col('tokens').findOne({ _id: id });
  }
  step('auditing the contract');
  await auditNearContract(id).catch((e) => warn(`on-demand audit of ${id}: ${e.message}`));
  if (!(await col('tokens').findOne({ _id: id }))?.track_only) {
    step('running the analysis');
    await analyseOnDemand(id).catch((e) => warn(`on-demand analysis of ${id}: ${e.message}`));
  }
  job.message = 'Early buyers are profiled and grouped in the background; their tags appear within a few minutes.';
}

/** Start (or report) the background job for one token. */
export function startFetch(id) {
  if (!validNearAddress(id)) return { state: 'error', message: 'invalid NEAR account id' };
  const cur = jobs.get(id);
  if (cur?.state === 'running') return cur;
  if ([...jobs.values()].filter((j) => j.state === 'running').length >= MAX_JOBS) return { state: 'error', message: 'the server is busy fetching other tokens, try again in a minute' };
  const job = { state: 'running', step: 'starting', message: null, started: Date.now(), finished: null };
  jobs.set(id, job);
  run(id, job).then(() => { job.state = 'done'; job.finished = Date.now(); info(`FETCHED on demand ${id}`); })
    .catch((e) => { job.state = 'error'; job.message = e.message; job.finished = Date.now(); warn(`on-demand fetch of ${id} failed: ${e.message}`); });
  for (const [k, j] of jobs) if (j.finished && Date.now() - j.finished > 3600e3) jobs.delete(k);
  return job;
}
