// Command line helpers.
//   node src/cli.js backfill <launchpad|all> <hours>   replay recent launches into the database
//   node src/cli.js process                            process everything that is pending, then regroup (and review with NEAR AI)
//   node src/cli.js reprofile                          profile every early wallet again, then regroup
//   node src/cli.js label <account> "<name>" [type]    name an exchange / service wallet (type: exchange|service|bridge|fund|other)
//   node src/cli.js rebuild-entries                    recompute early entries from stored trades (no network), then regroup
//   node src/cli.js rugs                               flag known rugs (creator blacklist), re-apply the rug rules to every token, regroup
//   node src/cli.js expand [batches]                   profile the wallets linked to the groups (3 hops out), then regroup
//   node src/cli.js audit <account> [--force] [--json]  audit any NEAR contract / token (access keys, code, tax, sell behaviour)
//   node src/cli.js ledger [token]                      read done tokens' trades up to today (all due tokens, or one token to the end)
//   node src/cli.js import-scanner [state.json] [--dry]  copy the live scanner's data (launches, evaluations, blacklist, positions) here
//   node src/cli.js scan <token> [--features]          run the gates + AI analyst on any stored token (no buying)
//   node src/cli.js sim-reset                          reset the simulated wallet
//   node src/cli.js entities                           rebuild the entity table
//   node src/cli.js evaluate                           only regroup + rule verdicts
//   node src/cli.js review [n]                         NEAR AI review of up to n groups
//   node src/cli.js status                             counts
//   node src/cli.js check-ai                           test the NEAR AI key / model
import { config, validateConfig } from './config.js';
import { connectDb, closeDb, col, metaGet } from './db.js';
import { enableDbLog, flushLogs, info } from './log.js';
import { backfill } from './collect/launches.js';
import { processToken } from './collect/process.js';
import { followToken, followDue } from './collect/ledger.js';
import { profilePending } from './graph/profile.js';
import { evaluateGroups, reviewPending } from './evaluate/run.js';
import { buildEntities } from './evaluate/entities.js';
import { scanDry, blacklistCreator } from './scanner/pipeline.js';
import { importScanner } from './import/scanner.js';
import { auditNearContract, summarizeAudit } from './audit/service.js';
import { recomputeToken, flagRugs } from './collect/rugs.js';
import { expandNetworks } from './graph/expand.js';
const buildEntries_done = async () => { await evaluateGroups(); };
import { resetSim, simBuy, managePositions } from './sim/portfolio.js';
import { checkAi, aiEnabled, aiStatus } from './ai/nearai.js';

const [cmd, ...args] = process.argv.slice(2);
const errs = validateConfig();
if (errs.length) { for (const e of errs) console.error(`config error: ${e}`); process.exit(1); }
await connectDb(); enableDbLog();

try {
  if (cmd === 'backfill') {
    const [pad = 'all', hours = '24'] = args;
    const pads = pad === 'all' ? config.launchpads : [pad]; // backfill() follows aliases (justhoot also replays justhoot_v2)
    for (const p of pads) await backfill(p, Number(hours));
  } else if (cmd === 'process') {
    // every unfinished token once (an old token that is not fully read yet is continued until it is), then all pending wallets
    const lastCp = config.outcome.minutes[config.outcome.minutes.length - 1] * 60e3;
    const ids = (await col('tokens').find({ status: { $nin: ['done', 'skipped_quote', 'awaiting_pool', 'no_pool'] } }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
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
  } else if (cmd === 'label') {
    const [account, name, type = 'other'] = args;
    if (!account || !name) throw new Error('usage: label <account> "<name>" [exchange|service|bridge|fund|other]');
    await col('labels').replaceOne({ _id: account }, { _id: account, label: name, type, ts: Date.now() }, { upsert: true });
    await buildEntities();
    info(`labelled ${account} as "${name}" (${type})`);
  } else if (cmd === 'rebuild-entries') {
    // recompute every token's early entries and outcome from the trades already stored (no network): picks up new fields and rug rules
    const toks = await col('tokens').find({ status: { $nin: ['skipped_quote', 'awaiting_pool', 'no_pool'] }, trades_n: { $gt: 0 } }).toArray();
    let n = 0;
    for (const t of toks) n += (await recomputeToken(t)) || 0;
    info(`rebuilt ${n} early entries from stored trades`);
    await buildEntries_done();
  } else if (cmd === 'rugs') {
    // flag tokens named in the creator blacklist as rugged, re-apply the rug rules to every stored token, regroup, and list what is rugged
    info(`flagged ${await flagRugs()} tokens from the blacklist`);
    const toks = await col('tokens').find({ trades_n: { $gt: 0 } }).toArray();
    for (const t of toks) await recomputeToken(t);
    await evaluateGroups();
    const rows = await col('tokens').aggregate([{ $match: { 'outcome.rugged': true } }, { $unwind: { path: '$outcome.rug_kinds', preserveNullAndEmptyArrays: true } }, { $group: { _id: '$outcome.rug_kinds', n: { $sum: 1 } } }]).toArray();
    console.log(JSON.stringify({ rugged: await col('tokens').countDocuments({ 'outcome.rugged': true }), by_kind: Object.fromEntries(rows.map((r) => [r._id || 'n/a', r.n])), flagged: await col('tokens').countDocuments({ 'rug.flagged': true }) }));
  } else if (cmd === 'expand') {
    // profile the wallets linked to the groups (up to 3 hops out), n batches, then regroup
    let k = 0; for (let i = 0; i < (Number(args[0]) || 5); i++) k += await expandNetworks();
    info(`expanded ${k} linked wallets`);
    await evaluateGroups();
  } else if (cmd === 'audit') {
    const doc = await auditNearContract(args[0], { force: args.includes('--force') });
    if (doc.notFound) { console.log(`${doc.address}: no contract on this account`); }
    else {
      console.log(`${doc.address} (${doc.kind}${doc.tokenSymbol ? ' ' + doc.tokenSymbol : ''}) · risk ${doc.risk.score}/100 ${doc.risk.level} · trust ${doc.trust.score}/100 ${doc.trust.level}`);
      for (const f of doc.risk.factors.filter((x) => x.hit && x.weight > 0).sort((a, b) => b.weight - a.weight)) console.log(`  [${f.category} +${f.weight}] ${f.label}${f.detail ? ' - ' + f.detail : ''}`);
      console.log('  passed:', doc.risk.factors.filter((x) => !x.hit && x.weight > 0).map((x) => x.key).join(', ') || '-');
      if (args.includes('--json')) console.log(JSON.stringify(summarizeAudit(doc), null, 1));
    }
  } else if (cmd === 'import-scanner') {
    const file = args.find((a) => !a.startsWith('--')) || '../near-launch-scanner/data/state.json';
    const r = await importScanner(file, { dry: args.includes('--dry') });
    console.log(JSON.stringify(r, null, 1));
  } else if (cmd === 'scan') {
    const r = await scanDry(args[0]);
    console.log(JSON.stringify({ rules: { pass: r.rules.pass, score: r.rules.score, failed: r.rules.failed }, ai: r.ai, decision: r.decision, features: args.includes('--features') ? r.features : undefined }, null, 1));
    if (args.includes('--buy') && r.decision.buy) { // simulated buy right now (paper money)
      const t = await col('tokens').findOne({ _id: args[0] });
      console.log('simulated buy:', JSON.stringify(await simBuy(t, r.decision.near, { ai: r.ai, score: r.rules.score, reason: r.decision.why })));
    }
  } else if (cmd === 'sim-check') {
    await managePositions(blacklistCreator);
    console.log(JSON.stringify(await col('sim_positions').find().toArray(), null, 1));
    console.log(JSON.stringify(await col('sim_account').findOne({ _id: 'main' })));
  } else if (cmd === 'sim-reset') {
    await resetSim();
    info(`simulated wallet reset to ${config.sim.startNear} NEAR`);
  } else if (cmd === 'entities') {
    await buildEntities();
  } else if (cmd === 'evaluate') {
    await evaluateGroups();
  } else if (cmd === 'ledger') {
    // the full ledger: one token read to the end, or every due done token (newest first) until none is left
    if (args[0]) {
      let t = await col('tokens').findOne({ _id: args[0] });
      if (t?.status !== 'done') throw new Error(`${args[0]}: not a token whose first 24 h are read (status ${t?.status ?? 'unknown'})`);
      while (!(await followToken(t, { passes: 5 })).caughtUp) t = await col('tokens').findOne({ _id: args[0] });
    } else { let n, total = 0; while ((n = await followDue(10, 3))) total += n; info(`ledger: ${total} passes, nothing left to read`); }
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
    console.log('commands: backfill <launchpad|all> <hours> | process | ledger [token] | evaluate | review [n] | status | check-ai');
  }
} finally { await flushLogs(); await closeDb(); }
process.exit(0);
