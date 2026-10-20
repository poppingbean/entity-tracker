// Command line helpers.
//   node src/cli.js backfill <launchpad|all> <hours>   replay recent launches into the database
//   node src/cli.js process                            process everything that is pending, then regroup (and review with NEAR AI)
//   node src/cli.js reprofile                          profile every early wallet again, then regroup
//   node src/cli.js evaluate                           only regroup + rule verdicts
//   node src/cli.js review [n]                         NEAR AI review of up to n groups
//   node src/cli.js status                             counts
//   node src/cli.js check-ai                           test the NEAR AI key / model
import { config, validateConfig } from './config.js';
import { connectDb, closeDb, col, metaGet } from './db.js';
import { enableDbLog, flushLogs, info } from './log.js';
import { backfill } from './collect/launches.js';
import { processToken } from './collect/process.js';
import { profilePending } from './graph/profile.js';
import { evaluateGroups, reviewPending } from './evaluate/run.js';
import { checkAi, aiEnabled, aiStatus } from './ai/nearai.js';

const [cmd, ...args] = process.argv.slice(2);
const errs = validateConfig();
if (errs.length) { for (const e of errs) console.error(`config error: ${e}`); process.exit(1); }
await connectDb(); enableDbLog();

try {
  if (cmd === 'backfill') {
    const [pad = 'all', hours = '24'] = args;
    const pads = pad === 'all' ? config.launchpads : [pad];
    for (const p of pads) await backfill(p, Number(hours));
  } else if (cmd === 'process') {
    // every unfinished token once (an old token that is not fully read yet is continued until it is), then all pending wallets
    const lastCp = config.outcome.minutes[config.outcome.minutes.length - 1] * 60e3;
    const ids = (await col('tokens').find({ status: { $nin: ['done', 'skipped_quote'] } }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
    info(`processing ${ids.length} tokens`);
    let fails = 0;
    for (const id of ids) {
      for (let guard = 0; guard < 40; guard++) {
        try {
          const t = await col('tokens').findOne({ _id: id });
          const r = await processToken(t);
          fails = 0;
          if (r.done || Date.now() - t.live_ts < lastCp) break; // young tokens get one pass; old ones continue until fully read
        } catch (e) {
          if (++fails > 8) throw e;
          console.error(`${id} failed (${String(e.message).slice(0, 120)}); retrying in ${fails * 5}s`);
          await new Promise((r) => setTimeout(r, fails * 5000));
        }
      }
    }
    for (let guard = 0; guard < 400; guard++) {
      try { if (!(await profilePending(60))) break; fails = 0; }
      catch (e) { if (++fails > 8) throw e; await new Promise((r) => setTimeout(r, fails * 5000)); }
    }
    await evaluateGroups();
    if (aiEnabled()) { let k; do { k = await reviewPending(5); } while (k > 0); }
  } else if (cmd === 'reprofile') {
    // forget every funding / flow result and profile all early wallets again (after the profiling logic changed)
    await col('edges').deleteMany({ type: { $in: ['fund', 'flow'] } });
    await col('wallets').deleteMany({ is_early: { $ne: true } }); // cached funder nodes
    await col('wallets').updateMany({ is_early: true }, { $set: { profiled: false }, $unset: { funding_done: '', chain: '', funders: '', flow_out: '' } });
    let fails = 0;
    for (let guard = 0; guard < 400; guard++) {
      try { if (!(await profilePending(60))) break; fails = 0; }
      catch (e) { if (++fails > 8) throw e; await new Promise((r) => setTimeout(r, fails * 5000)); }
    }
    await evaluateGroups();
    if (aiEnabled()) { let k; do { k = await reviewPending(5); } while (k > 0); }
  } else if (cmd === 'evaluate') {
    await evaluateGroups();
  } else if (cmd === 'review') {
    info(`reviewed ${await reviewPending(Number(args[0]) || 5)} groups`);
  } else if (cmd === 'check-ai') {
    const s = await checkAi();
    console.log(JSON.stringify({ enabled: aiEnabled(), model: config.ai.model, baseUrl: config.ai.baseUrl, ok: s.ok, error: s.error, calls: s.calls }, null, 1));
  } else if (cmd === 'status') {
    const [tokens, done, entries, wallets, profiled, clusters, byVerdict] = await Promise.all([
      col('tokens').countDocuments(), col('tokens').countDocuments({ status: 'done' }), col('entries').countDocuments(), col('wallets').countDocuments({ is_early: true }),
      col('wallets').countDocuments({ is_early: true, profiled: true }), col('clusters').countDocuments(), col('clusters').aggregate([{ $group: { _id: '$verdict', n: { $sum: 1 } } }]).toArray(),
    ]);
    console.log(JSON.stringify({ tokens, done, entries, wallets, profiled, clusters, byVerdict: Object.fromEntries(byVerdict.map((r) => [r._id, r.n])), ai: { enabled: aiEnabled(), model: config.ai.model, status: aiStatus.ok }, worker: await metaGet('worker') }, null, 1));
  } else {
    console.log('commands: backfill <launchpad|all> <hours> | process | evaluate | review [n] | status | check-ai');
  }
} finally { await flushLogs(); await closeDb(); }
process.exit(0);
