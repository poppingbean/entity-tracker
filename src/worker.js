// The background loop: find launches, read their trades, profile early wallets, regroup, ask NEAR AI.
import { col, metaSet } from './db.js';
import { config } from './config.js';
import { info, warn, error } from './log.js';
import { discover } from './collect/launches.js';
import { processDue } from './collect/process.js';
import { profilePending } from './graph/profile.js';
import { expandNetworks } from './graph/expand.js';
import { flagRugs, refreshStaleOutcomes } from './collect/rugs.js';
import { evaluateGroups, reviewPending } from './evaluate/run.js';
import { checkAi, aiEnabled, aiStatus } from './ai/nearai.js';
import { scanTick, followUpTick, blacklistCreator } from './scanner/pipeline.js';
import { managePositions } from './sim/portfolio.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const runtime = { startedTs: Date.now(), cycles: 0, lastCycleTs: null, stopping: false, lastEvalTs: 0, lastPositionCheck: 0, lastRugCheck: 0 };

/** One pass of the pipeline. Returns what it did, so callers (the CLI) can loop until idle. */
export async function cycle({ evaluate = true } = {}) {
  const found = await discover();
  const processed = await processDue();
  let scanned = 0, followed = 0;
  if (config.scan.enabled) { scanned = await scanTick(); followed = await followUpTick(); }
  if (config.sim.enabled && Date.now() - runtime.lastPositionCheck > config.sim.positionCheckSeconds * 1000) { runtime.lastPositionCheck = Date.now(); await managePositions(blacklistCreator); }
  if (Date.now() - runtime.lastRugCheck > 10 * 60e3) { runtime.lastRugCheck = Date.now(); await flagRugs().catch((e) => warn(`rug flagging failed: ${e.message}`)); // creators blacklisted for dumping: their token is a rug
    if (await refreshStaleOutcomes().catch((e) => { warn(`rug rules refresh failed: ${e.message}`); return 0; })) runtime.lastEvalTs = 0; } // outcomes from older rug rules; regroup after
  const profiled = await profilePending(40);
  const expanded = evaluate ? await expandNetworks().catch((e) => { warn(`network expansion failed: ${e.message}`); return 0; }) : 0; // linked wallets around the groups, up to 3 hops
  let groups = null, reviewed = 0;
  const stale = Date.now() - runtime.lastEvalTs > 10 * 60e3;
  if (evaluate && (profiled > 0 || expanded > 0 && Date.now() - runtime.lastEvalTs > 2 * 60e3 || stale && processed > 0 || stale && runtime.lastEvalTs === 0)) {
    groups = (await evaluateGroups()).groups; runtime.lastEvalTs = Date.now();
  }
  if (evaluate && aiEnabled()) reviewed = await reviewPending(3);
  return { found, processed, scanned, followed, profiled, expanded, groups, reviewed };
}

export async function runWorker() {
  if (aiEnabled()) { checkAi().then((s) => (s.ok ? info(`NEAR AI ready (${config.ai.model})`) : warn(`NEAR AI NOT ready: ${s.error}`))); }
  else warn('NEAR_AI_API_KEY is not set: groups get rule-based verdicts only');
  info(`worker started · launchpads=${config.launchpads.join(',')} · early window ${config.entry.windowMinutes} min · outcomes at ${config.outcome.minutes.join('/')} min`);
  while (!runtime.stopping) {
    try {
      const r = await cycle();
      runtime.cycles++; runtime.lastCycleTs = Date.now();
      await metaSet('worker', { ts: Date.now(), cycles: runtime.cycles, startedTs: runtime.startedTs, last: r, ai: { enabled: aiEnabled(), model: config.ai.model, ok: aiStatus.ok, error: aiStatus.error, calls: aiStatus.calls, failures: aiStatus.failures } });
    } catch (e) { error(`cycle failed: ${e.message}`); }
    // sleep in short steps so a shutdown is prompt; work backlog continues without waiting
    const backlog = await col('tokens').countDocuments({ status: { $nin: ['done', 'skipped_quote', 'awaiting_pool', 'no_pool'] }, next_process_ts: { $lte: Date.now() } }).catch(() => 0);
    const wait = backlog > 0 ? 2000 : config.pollSeconds * 1000;
    for (let t = 0; t < wait && !runtime.stopping; t += 500) await sleep(500);
  }
}
