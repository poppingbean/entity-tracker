// Command line helpers.
//   node src/cli.js backfill <launchpad|all> <hours>   replay recent launches into the database
//   node src/cli.js process                            process everything that is pending, then regroup (and review with NEAR AI)
//   node src/cli.js reprofile                          profile every early wallet again, then regroup
//   node src/cli.js label <account> "<name>" [type]    name an exchange / service wallet (type: exchange|service|bridge|fund|other)
//   node src/cli.js rebuild-entries                    recompute early entries from stored trades (no network), then regroup
//   node src/cli.js rugs                               flag known rugs (creator blacklist), re-apply the rug rules to every token, regroup
//   node src/cli.js expand [batches]                   profile the wallets linked to the groups (3 hops out), then regroup
//   node src/cli.js audit <account> [--force] [--json]  audit any NEAR contract / token (access keys, code, tax, sell behaviour)
//   node src/cli.js creators [max]                      trace who funded every token creator (newest first), then rebuild entities
//   node src/cli.js ledger [token]                      read done tokens' trades up to today (all due tokens, or one token to the end)
//   node src/cli.js import-scanner [state.json] [--dry]  copy the live scanner's data (launches, evaluations, blacklist, positions) here
//   node src/cli.js rescore-gates [--apply|--undo]     re-score stored checks now that min_buyers / not_overextended are warnings (dry run by default)
//   node src/cli.js scan <token> [--features]         run the gates + AI analyst on any stored token (no buying)
//   node src/cli.js sim-reset                          reset the simulated wallet
//   node src/cli.js entities                           rebuild the entity table
//   node src/cli.js evaluate                           only regroup + rule verdicts
//   node src/cli.js review [n]                         NEAR AI review of up to n groups
//   node src/cli.js status                             counts
//   node src/cli.js check-ai                           test the NEAR AI key / model
//   node src/cli.js flag <account> critical|high|medium "<reason>"   report an account to the transaction firewall (unflag <account> to undo)
//   node src/cli.js check-tx '<json>'                    run the transaction firewall on a request body
//   node src/cli.js deep-review [--now]                 run the deep reviews (re-trace + NEAR AI verdict) of findings that are due
//   node src/cli.js review-drains                      check past drain reports for withdrawals of the wallet's own deposits
//   node src/cli.js exchanges                          rediscover exchange hot wallets and their withdrawal baselines (drain detection)
//   node src/cli.js exchange-wallet <account> <exchange> [hot|cold]   add an exchange wallet by hand
//   node src/cli.js incident <account|tx hash|target:<contract>> [--no-ai]   trace a hack: attacker accounts, target, losses, victims, money trail
//   node src/cli.js accuracy                           score gates, rule score, audit risk, AI and group verdicts against what happened
//   node src/cli.js backtest KEY=VALUE ...             replay the gates on every stored check with config.rules changed (e.g. minBuyers=8)
//   node src/cli.js truth <kind> <id> bad|good|clear [note]   hand label (kind: token|group|wallet|collection|incident|detection|account|contract)
//   node src/cli.js feedback [accept|reject <id>]      list pending reports, or review one
//   node src/cli.js case-add <case id | account> <plan.json> [--dry]   add accounts, funded edges, suspected links to a confirmed case (docs/incidents.md)
//   node src/cli.js ring-scan [case id]                look for laundering rings (memecoins bought by wallets a confirmed case paid); stores proposals
//   node src/cli.js ring-approve <id> [--dry] | ring-reject <id> ["reason"]   an operator applies a proposal with case-add, or drops it
//   node src/cli.js chain-links                        addresses on other chains that received money from 2+ NEAR cases (leads; flags nothing)
//   node src/cli.js nft-from-deploys [days] [--dry]    list NFT collections deployed in the last N days (default 30): HOT Craft, near.cooking, any contract the audit calls NFT
//   node src/cli.js tokens-from-deploys [days] [--dry]   open tokens deployed in the last N days (default 7) that already have a pool (any factory, no launchpad)
//   node src/cli.js watch-list [--status s] [--limit N]   money watch cases (docs/money-watch-design.md); watch-show <id>; watch-scan [N] (read-only: what would open in the latest N blocks)
//   node src/cli.js watch-report <address> [--source <link>] [--note "<text>"]   a person reports an address; watch-confirm <id> [--source]; watch-close <id> <reason>; watch-review <id>
//   node src/cli.js academy-build [--dry]              rebuild the Safe Near Academy's graded tasks (docs/academy-design.md); --dry counts them per track and level
//   node src/cli.js academy-business [status|scan|close [--dry]|pause|resume]   the Academy's business (docs/academy-business.md)
//   node src/cli.js academy-demo <agent> [product] [usdc|near]   one loop: an order, its payment (you send it), the credit, a dry close
//   node src/cli.js link-eval                         pairwise precision / recall of the wallet grouping against pairs of known owners (changes nothing)
//   node src/cli.js exchanges-prune [--apply]          list (or remove) registry entries that rest only on being busy (IDENTIFY_BUSY_NEUTRAL)
//   node src/cli.js golden-candidates [--class <class>] [--limit N]   resolved accounts not in the golden set, strongest evidence first (JSON lines; writes nothing)
//   node src/cli.js trace-replay [--limit N] [--only <id prefix>] [--resume <earlier log>]   re-trace stored cases with the current code and diff them against what is stored (no AI, nothing saved)
//   node src/cli.js truth-backfill [--dry]             build status_history for stored cases and count how many are labelled bad / good / unknown
//   node src/cli.js fixture-tx <hash> <name> [--note "<text>"] [--stdout]   capture a real transaction as a test fixture (test/fixtures/tx/<name>.json)
//   node src/cli.js what-is <account>                  the ontology's answer for an account: class, why, conflicts, its edges
//   node src/cli.js ontology-backfill [--dry]          turn today's data into ontology facts (--dry: check them and the golden set, write nothing)
//   node src/cli.js ontology-apply [--dry]             recompute the grouping kinds stored on wallets with the current rule, then regroup
//   node src/cli.js ontology-replay [--json] [--only <id prefix>]   trace every stored case with the old rules and with the ontology, compare (writes nothing)
//   node src/cli.js ontology-parity                  what the writers would write now vs what is stored (missing / stale per writer; writes nothing)
//   node src/cli.js ontology-gate [--json]             is the next ontology migration PR ready? (heartbeat, shadow log, golden set)
import { config, validateConfig } from './config.js';
import { connectDb, closeDb, col, metaGet, metaSet } from './db.js';
import { enableDbLog, flushLogs, info } from './log.js';
import { backfill } from './collect/launches.js';
import { processToken } from './collect/process.js';
import { followDue, readLedger, rebuildLedger } from './collect/ledger.js';
import { profilePending } from './graph/profile.js';
import { evaluateGroups, reviewPending } from './evaluate/run.js';
import { buildEntities } from './evaluate/entities.js';
import { profileCreators } from './evaluate/creators.js';
import { scanDry, blacklistCreator } from './scanner/pipeline.js';
import { importScanner } from './import/scanner.js';
import { rescoreGates } from './scanner/rescore.js';
import { auditNearContract, summarizeAudit } from './audit/service.js';
import { recomputeToken, flagRugs } from './collect/rugs.js';
import { expandNetworks } from './graph/expand.js';
const buildEntries_done = async () => { await evaluateGroups(); };
import { resetSim, simBuy, managePositions } from './sim/portfolio.js';
import { checkAi, aiEnabled, aiStatus } from './ai/tools/nearai.js';
import { evaluateAccuracy, backtest } from './accuracy/run.js';
import { flagAccount, unflagAccount, checkRequest } from './firewall/service.js';
import { listFeedback, resolveFeedback, setTruth, clearTruth } from './accuracy/feedback.js';
import { backfill as ontologyBackfill } from './ontology/backfill.js';
import { gate as ontologyGate, gateText } from './ontology/gate.js';
import { whatIs, relationsOf } from './ontology/index.js';
import { checkGolden } from './ontology/golden.js';
import { resolve as ontologyResolve } from './ontology/resolve.js';
import { virtualFacts } from './ontology/known.js';

const [cmd, ...args] = process.argv.slice(2);
const errs = validateConfig();
if (errs.length) { for (const e of errs) console.error(`config error: ${e}`); process.exit(1); }
await connectDb(); enableDbLog();
config.ontology.shadow = false; // shadow mode measures the production processes, not one-off commands

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
    await (await import('./ontology/writers.js')).syncFacts(['labels']); // G1
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
  } else if (cmd === 'rescore-gates') {
    console.log(JSON.stringify(await rescoreGates({ apply: args.includes('--apply'), undo: args.includes('--undo') }), null, 1));
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
  } else if (cmd === 'creators') {
    // creator funding: trace every creator not traced yet (up to max), then rebuild the entities so funders show the creators they funded
    const max = Number(args[0]) || Infinity; let n, total = 0;
    while (total < max && (n = await profileCreators(Math.min(25, max - total)))) total += n;
    info(`creators: ${total} traced`);
    await buildEntities();
  } else if (cmd === 'ledger') {
    // the full ledger: one token read to the end, or every due done token (newest first) until none is left
    if (args[0]) {
      let t = await col('tokens').findOne({ _id: args[0] });
      if (t?.status !== 'done') throw new Error(`${args[0]}: not a token whose first 24 h are read (status ${t?.status ?? 'unknown'})`);
      // read the whole history first, then rebuild once (rebuilding loads every stored trade)
      let r = { added: 0 };
      for (;;) { const p = await readLedger(t, { passes: 5 }); r = { ...p, added: r.added + p.added }; if (p.caughtUp) break; t = await col('tokens').findOne({ _id: args[0] }); }
      await rebuildLedger(await col('tokens').findOne({ _id: args[0] }), r);
    } else { let n, total = 0; while ((n = await followDue(10, 3))) total += n; info(`ledger: ${total} passes, nothing left to read`); }
  } else if (cmd === 'review') {
    info(`reviewed ${await reviewPending(Number(args[0]) || 5)} groups`);
  } else if (cmd === 'check-ai') {
    const s = await checkAi();
    console.log(JSON.stringify({ enabled: aiEnabled(), model: config.ai.model, baseUrl: config.ai.baseUrl, ok: s.ok, error: s.error, calls: s.calls }, null, 1));
  } else if (cmd === 'confirm-incident') {
    // node src/cli.js confirm-incident <account> <source url | -> "<reason>": a hack confirmed outside the chain (the rules cannot prove it alone);
    // run it again with the link to add one
    const { confirmIncident } = await import('./incident/service.js');
    // optional, from the report: --kind protocol_exploit --target contract.main.burrow.near --loss 18400000 --accounts a,b,c
    const opt = (k) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : null; };
    const d = await confirmIncident(args[0], { source: args[1] === '-' ? null : args[1], reason: args[2], kind: opt('kind'), target: opt('target'), loss_usd: opt('loss'), accounts: (opt('accounts') || '').split(',').filter(Boolean) });
    info(`incident ${d._id}: confirmed (${d.confirmed_by?.source || 'no link yet'}) · ${d.kind} $${d.stolen_usd}`);
  } else if (cmd === 'case-add') {
    const { addToCase } = await import('./incident/caseadd.js');
    const plan = JSON.parse((await import('node:fs')).readFileSync(args[1], 'utf8'));
    console.log(JSON.stringify(await addToCase(args[0], plan, { dry: args.includes('--dry'), log: (l) => console.error(l) }), null, 1));
  } else if (cmd === 'ring-scan') {
    const { scanCase, proposeRings } = await import('./incident/ring.js');
    const { refreshSnapshot } = await import('./ontology/sync.js');
    await refreshSnapshot();
    const { findCase } = await import('./incident/caseadd.js');
    const cases = args[0] ? [await findCase(args[0])] : await col('incidents').find({ status: 'confirmed' }).toArray();
    for (const c of cases.filter(Boolean)) { const f = await scanCase(c, { log: (l) => console.error(l) }); const n = await proposeRings(c, f); console.log(JSON.stringify({ case: c._id, linked: f.linked.length, proposals: f.proposals.map((p) => ({ token: p.token, creator: p.creator, linked: p.linked, total: p.total, share: +p.share.toFixed(3) })), new: n })); }
  } else if (cmd === 'ring-approve') {
    const { approveRing } = await import('./incident/ring.js');
    console.log(JSON.stringify(await approveRing(args[0], { dry: args.includes('--dry'), log: (l) => console.error(l) }), null, 1));
  } else if (cmd === 'ring-reject') {
    const { rejectRing } = await import('./incident/ring.js');
    await rejectRing(args[0], args[1]); info(`${args[0]} rejected`);
  } else if (cmd === 'unconfirm-incident') {
    // node src/cli.js unconfirm-incident <account> ["<reason>"]
    const { unconfirmIncident } = await import('./incident/service.js');
    const d = await unconfirmIncident(args[0], { reason: args[1] || 'unconfirmed via CLI' });
    info(`incident ${d._id}: unconfirmed (status reverted to ${d.status})`);
  } else if (cmd === 'clear-incident') {
    // node src/cli.js clear-incident <account> ["<reason>"]
    const { clearIncident } = await import('./incident/service.js');
    const d = await clearIncident(args[0], { reason: args[1] || 'cleared via CLI' });
    info(`incident ${d._id}: cleared as normal activity`);
  } else if (cmd === 'reflag-incidents') {
    // node src/cli.js reflag-incidents: re-flag all auto-confirmed incidents and clear false flags
    const { reflagIncidents } = await import('./incident/reflag.js');
    const res = await reflagIncidents({ log: (m) => info(m) });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'flag') {
    // node src/cli.js flag <account> critical|high|medium "<reason>" ["<detail>"]: the transaction firewall warns about it from now on
    await flagAccount(args[0], args[1], args[2] || 'reported', args[3] || '');
    info(`firewall: ${args[0]} flagged ${args[1]} (${args[2] || 'reported'})`);
  } else if (cmd === 'unflag') {
    await unflagAccount(args[0]); info(`firewall: ${args[0]} unflagged`);
  } else if (cmd === 'deep-review') {
    // node src/cli.js deep-review [--now]: queue every finding without a review, then run the due ones (all of them with --now)
    const { backfillReviews, processDeepReview } = await import('./incident/deepreview.js');
    info(`queued: ${await backfillReviews()}`);
    if (args.includes('--now')) await col('deep_reviews').updateMany({ status: 'pending' }, { $set: { due_ts: 0 } });
    let r, n = 0; while ((r = await processDeepReview())) { n++; info(`reviewed: ${r.tag} (${r.why})`); }
    info(`deep reviews run: ${n}`);
  } else if (cmd === 'review-drains') {
    const { reviewDetections } = await import('./incident/detect.js');
    info(`drain reports reviewed: ${await reviewDetections(200)}`);
  } else if (cmd === 'exchanges') {
    const { refreshExchangeRegistry } = await import('./incident/exchanges.js');
    console.log(JSON.stringify(await refreshExchangeRegistry({ log: (m) => info(m) })));
  } else if (cmd === 'exchange-wallet') {
    const { addExchangeWallet } = await import('./incident/exchanges.js');
    if (!args[0] || !args[1]) throw new Error('usage: exchange-wallet <account> <exchange> [hot|cold]');
    await addExchangeWallet(args[0], args[1], args[2] === 'cold' ? 'cold' : 'hot'); info(`exchange wallet ${args[0]}: ${args[1]}`);
  } else if (cmd === 'academy-build') {
    // node src/cli.js academy-build [--dry]: the graded tasks for training agents, from the code audits and the launch checks
    const { buildAcademy } = await import('./academy/service.js');
    const r = await buildAcademy({ dry: args.includes('--dry'), log: (m) => info(m) });
    if (!r.dry) await metaSet('academy_build', { ts: Date.now(), tasks: r.tasks, counts: r.counts });
    for (const k of Object.keys(r.counts).sort()) console.log(`${k.padEnd(24)} ${r.counts[k]}`);
    console.log(`${r.tasks} tasks ${r.dry ? 'would be built' : 'built'}`);
  } else if (cmd === 'academy-business') {
    const B = await import('./academy/business.js'), sub = args[0] || 'status';
    if (sub === 'pause' || sub === 'resume') { await B.setPaused(sub === 'pause'); console.log(`kill switch ${sub === 'pause' ? 'ON: no new orders, no payouts' : 'off'}`); }
    else if (sub === 'scan') console.log(JSON.stringify(await B.scanPayments({ log: (m) => info(m) }), null, 1));
    else if (sub === 'close') console.log(JSON.stringify(await B.dailyClose({ force: true, dry: args.includes('--dry'), log: (m) => info(m) }), null, 1));
    else { const l = await B.publicLedger({ limit: 10 }); console.log(JSON.stringify({ business: l.business, totals: l.totals, ai_extra_today: l.ai_extra_today, why_not_running: B.notReady(B.rules()) }, null, 1)); }
  } else if (cmd === 'academy-demo') {
    // one full loop, in under two minutes: an order, its payment (sent by you from any wallet), the credit, then a dry daily close
    const B = await import('./academy/business.js'), agent = args[0], product = args[1] || 'exam_certificate', pay = args[2] || 'usdc';
    if (!agent) throw new Error('usage: academy-demo <agent> [product] [usdc|near]');
    const o = await B.createOrder(agent, product, { pay_with: pay });
    console.log(`order ${o.order}: send ${o.how_to_pay.send} to ${o.how_to_pay.to}${o.how_to_pay.memo ? ` (memo ${o.how_to_pay.memo})` : ''}. Waiting up to 3 minutes for it…`);
    await B.scanPayments(); // start the cursor if it is new
    for (let i = 0; i < 36; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      await B.scanPayments();
      const s = await B.orderStatus(agent, o.order);
      if (s.status === 'paid') { console.log(`paid by ${s.paid.tx}`); break; }
      if (i === 35) console.log('not paid yet: the worker keeps watching for 6 hours after the order expires');
    }
    console.log('entitlements:', JSON.stringify(await B.entitlements(agent)));
    console.log('daily close (dry):', JSON.stringify(await B.dailyClose({ force: true, dry: true }), null, 1));
  } else if (cmd === 'nft-from-deploys') {
    // node src/cli.js nft-from-deploys [days] [--dry]: NFT collections the deploy watcher saw that NFT Collectibles does not list yet
    const { backfillNftDeploys } = await import('./nft/sync.js');
    const r = await backfillNftDeploys(Number(args.find((a) => /^\d+$/.test(a))) || 30, { dry: args.includes('--dry') });
    const by = r.filter((x) => x.new).reduce((m, x) => ((m[x.source] = (m[x.source] || 0) + 1), m), {});
    for (const x of r.filter((y) => y.new).slice(0, 50)) info(`${args.includes('--dry') ? 'would list' : 'listed'}: ${x.account} (${x.source})`);
    console.log(`${r.length} NFT deploys seen, ${r.filter((x) => x.new).length} ${args.includes('--dry') ? 'would be' : 'were'} newly listed ${JSON.stringify(by)}`);
  } else if (cmd === 'tokens-from-deploys') {
    // node src/cli.js tokens-from-deploys [days] [--dry]: tokens deployed while the liquidity watch was not running, opened from their first pool
    const { backfillFromDeploys } = await import('./collect/liquidity.js');
    const r = await backfillFromDeploys(Number(args.find((a) => /^\d+$/.test(a))) || 7, { dry: args.includes('--dry'), log: (m) => info(m) });
    console.log(`${r.tokens.length} tokens ${args.includes('--dry') ? 'would be opened' : `opened (${r.tokens.filter((x) => x.opened).length} new)`} of ${r.checked} contracts checked${r.failed.length ? `; ${r.failed.length} could not be read (run it again)` : ''}`);
  } else if (cmd === 'watch-list') {
    // money watch cases (docs/money-watch-design.md): node src/cli.js watch-list [--status watching|suspicious|normal|confirmed] [--limit N]
    const si = args.indexOf('--status'), li = args.indexOf('--limit');
    const rows = await col('watches').find(si >= 0 ? { status: args[si + 1] } : {}, { projection: { moves: 0, reviews: 0 } }).sort({ opened_ts: -1 }).limit(li >= 0 ? Number(args[li + 1]) : 30).toArray();
    for (const w of rows) console.log(`${w._id.slice(0, 40).padEnd(40)} ${w.status.padEnd(10)} $${String(w.trigger.usd).padEnd(9)} ${(w.origin?.class || 'no origin yet').padEnd(26)} accounts ${(w.accounts || []).filter((a) => a.state === 'active').length}/${(w.accounts || []).length}  ${new Date(w.opened_ts).toISOString().slice(0, 16)}`);
    console.log(`${rows.length} watches`);
  } else if (cmd === 'watch-show') {
    console.log(JSON.stringify(await col('watches').findOne({ _id: args[0] }), null, 1));
  } else if (cmd === 'watch-report') {
    // a person reports an address as part of a hack: node src/cli.js watch-report <address> [--source <link>] [--note "<text>"]
    const { reportAddress } = await import('./watch/report.js'), g = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : null);
    console.log(JSON.stringify(await reportAddress(args[0], { source: g('--source'), note: g('--note') }), null, 1));
  } else if (cmd === 'watch-confirm') {
    const { confirmWatch } = await import('./watch/report.js'), g = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : null);
    console.log(JSON.stringify(await confirmWatch(args[0], { source: g('--source'), note: g('--note') }), null, 1));
  } else if (cmd === 'watch-close') {
    const { setStatus } = await import('./watch/store.js'), why = args.slice(1).join(' ') || 'closed by operator';
    console.log(await setStatus(args[0], 'normal', { by: 'operator', why, review: { ts: Date.now(), verdict: 'normal', by: 'operator', what_it_is: why, reasons: [] } }) ? 'closed' : 'no such watch');
  } else if (cmd === 'watch-review') {
    const { reviewWatch } = await import('./watch/review.js'), w = await col('watches').findOne({ _id: args[0] });
    console.log(w ? await reviewWatch(w) : 'no such watch');
  } else if (cmd === 'watch-scan') {
    // read-only: the movements that WOULD open a watch in the latest N blocks (default 600), nothing written: node src/cli.js watch-scan [N]
    const { flowsOfBlocks, openingMovements } = await import('./watch/scan.js'), { protocols } = await import('./incident/detect.js');
    const U = config.autoAudit.neardataUrl, H = config.fastnearApiKey ? { authorization: `Bearer ${config.fastnearApiKey}` } : {};
    const get = async (p) => { for (let t = 0; t < 3; t++) { try { const r = await fetch(U + p, { headers: H, signal: AbortSignal.timeout(20000) }); if (r.status === 404) return null; if (r.ok) return r.json(); } catch {} } return null; };
    const tip = (await get('/v0/last_block/final')).block.header.height, n = Number(args[0]) || 600, blocks = [];
    for (let h = tip - n; h < tip; h += 8) (await Promise.all(Array.from({ length: Math.min(8, tip - h) }, (_, i) => get(`/v0/block/${h + i}`)))).forEach((b) => b?.block && blocks.push(b));
    const flows = await flowsOfBlocks(blocks), opening = await openingMovements(flows, await protocols());
    for (const f of opening) console.log(`$${Math.round(f.usd)} ${f.symbol || f.token} ${f.from.slice(0, 24)} → ${f.to.slice(0, 24)} tx ${f.tx}`);
    console.log(`${blocks.length} blocks, ${flows.length} flows, ${opening.size} would open a watch`);
  } else if (cmd === 'incident') {
    const { investigate, parseInvestigation } = await import('./incident/service.js');
    const d = await investigate(parseInvestigation(args[0]), { ai: !args.includes('--no-ai'), log: (m) => info(m) });
    console.log(JSON.stringify({ id: d._id, status: d.status, kind: d.kind, target: d.target?.account, stolen_usd: d.stolen_usd, held_usd: d.held_usd, exits: d.trail.exit_usd, signals: d.signals, ai: d.ai?.headline }, null, 1));
  } else if (cmd === 'check-tx') {
    // node src/cli.js check-tx '<json body>' : what the firewall API answers
    console.log(JSON.stringify(await checkRequest(JSON.parse(args[0])), null, 1));
  } else if (cmd === 'accuracy') {
    console.log(JSON.stringify(await evaluateAccuracy(), null, 1));
  } else if (cmd === 'backtest') {
    const overrides = {};
    for (const a of args) {
      const [k, v] = a.split('=');
      if (!(k in config.rules)) throw new Error(`unknown rule ${k} (one of: ${Object.keys(config.rules).join(', ')})`);
      overrides[k] = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v;
    }
    console.log(JSON.stringify(await backtest(overrides), null, 1));
  } else if (cmd === 'truth') {
    const [kind, id, label, ...note] = args;
    if (label === 'clear') await clearTruth(kind, id); else await setTruth(kind, id, label, { note: note.join(' ') });
    info(`truth ${kind}:${id} = ${label}`);
  } else if (cmd === 'feedback') {
    if (args[0] === 'accept' || args[0] === 'reject') { const f = await resolveFeedback(args[1], args[0] === 'accept'); info(`feedback ${args[1]} (${f.kind}:${f.id} ${f.verdict}) ${args[0]}ed`); }
    else for (const f of await listFeedback('pending')) console.log(`${f._id}  ${new Date(f.ts).toISOString()}  ${f.kind}:${f.id}  says ${f.verdict}  ${f.note}`);
  } else if (cmd === 'status') {
    const [tokens, done, entries, wallets, profiled, clusters, byVerdict] = await Promise.all([
      col('tokens').countDocuments(), col('tokens').countDocuments({ status: 'done' }), col('entries').countDocuments(), col('wallets').countDocuments({ is_early: true }),
      col('wallets').countDocuments({ is_early: true, profiled: true }), col('clusters').countDocuments(), col('clusters').aggregate([{ $group: { _id: '$verdict', n: { $sum: 1 } } }]).toArray(),
    ]);
    console.log(JSON.stringify({ tokens, done, entries, wallets, profiled, clusters, byVerdict: Object.fromEntries(byVerdict.map((r) => [r._id, r.n])), ai: { enabled: aiEnabled(), model: config.ai.model, status: aiStatus.ok }, worker: await metaGet('worker') }, null, 1));
  } else if (cmd === 'ontology-backfill') {
    // --dry: build and check every fact, resolve the golden set from them, write nothing
    const dry = args.includes('--dry');
    const r = await ontologyBackfill({ dry });
    if (dry) {
      const per = new Map();
      for (const f of r.facts) { if (!per.has(f.subject)) per.set(f.subject, virtualFacts(f.subject)); per.get(f.subject).push(f); }
      const ents = new Map([...per].map(([a, fs]) => [a, ontologyResolve(a, fs)]));
      const { GOLDEN } = await import('./ontology/golden.js');
      for (const [a] of GOLDEN) if (!ents.has(a)) ents.set(a, ontologyResolve(a, virtualFacts(a)));
      const classes = {}; for (const e of ents.values()) classes[e.class] = (classes[e.class] || 0) + 1;
      const conflicts = [...ents.values()].filter((e) => e.conflicts.length);
      console.log(JSON.stringify({ facts: r.facts.length, per: r.per, rejected: r.rejected.length, rejected_sample: r.rejected.slice(0, 5), accounts: ents.size, classes, with_conflicts: conflicts.length,
        conflict_sample: conflicts.slice(0, 8).map((e) => ({ account: e.account, class: e.class, why: e.why, overruled: e.conflicts.map((c) => `${c.object} (${c.source} ${c.confidence}: ${c.evidence})`) })),
        golden: checkGolden(ents) }, null, 1));
    } else console.log(JSON.stringify(r, null, 1));
  } else if (cmd === 'ontology-parity') {
    const { parity } = await import('./ontology/backfill.js');
    console.log(JSON.stringify(await parity(), null, 1));
  } else if (cmd === 'chain-links') {
    // addresses on other chains that received money from two or more different NEAR cases: leads for the operator (flags nothing)
    const rows = await col('ontology_facts').aggregate([{ $match: { predicate: 'sent_to', valid_to: null } }, { $group: { _id: '$object', cases: { $addToSet: '$subject' }, usd: { $sum: '$amount_usd' } } }, { $match: { 'cases.1': { $exists: true } } }, { $sort: { usd: -1 } }]).toArray();
    for (const r of rows) console.log(JSON.stringify({ address: r._id, cases: r.cases, usd: Math.round(r.usd) }));
    console.log(`${rows.length} addresses shared by 2+ cases`);
  } else if (cmd === 'link-eval') {
    // pairwise precision / recall of the current wallet grouping against pairs whose owner is known (WP-13 part A); changes nothing
    console.log(JSON.stringify(await (await import('./graph/linkeval.js')).linkEval(), null, 1));
  } else if (cmd === 'exchanges-prune') {
    // registry entries that rest only on being busy (found by discovery, no sweep to an exchange's cold wallet, not added by hand): listed, and removed with --apply
    const { provenWallet } = await import('./incident/exchanges.js');
    const rows = (await col('exchange_wallets').find({}).toArray()).filter((r) => !provenWallet(r));
    for (const r of rows) console.log(`${r._id.slice(0, 40)}  ${r.exchange || 'unnamed'}  ${r.how || ''}`);
    console.log(`${rows.length} of the registry's entries rest on being busy alone`);
    if (args.includes('--apply') && rows.length) { await col('exchange_wallets').deleteMany({ _id: { $in: rows.map((r) => r._id) } }); console.log('removed'); }
  } else if (cmd === 'golden-candidates') {
    // resolved accounts not in the golden set, strongest evidence first, as JSON lines ready to paste into src/ontology/golden.json (writes nothing)
    const { GOLDEN } = await import('./ontology/golden.js'), have = new Set(GOLDEN.map((g) => g[0]));
    const ci = args.indexOf('--class'), li = args.indexOf('--limit'), cls = ci >= 0 ? args[ci + 1] : null, lim = li >= 0 ? Number(args[li + 1]) : 50;
    const { SOURCE_RANK } = await import('./ontology/classes.js');
    const rows = (await col('ontology_entities').find(cls ? { class: new RegExp('^' + cls) } : { class: { $ne: 'unknown' } }).limit(5000).toArray()).filter((e) => !have.has(e._id));
    rows.sort((a, b) => (SOURCE_RANK[b.source] || 0) - (SOURCE_RANK[a.source] || 0) || (b.confidence || 0) - (a.confidence || 0));
    for (const e of rows.slice(0, lim)) console.log(JSON.stringify({ account: e._id, expect: e.class, note: e.label || e.why || '', source: 'operator', _evidence: `${e.source} ${e.confidence}: ${e.why}`, _conflicts: (e.conflicts || []).length }));
  } else if (cmd === 'trace-replay') {
    // re-trace stored cases with the current code and diff them against what is stored (nothing saved; no AI)
    const { traceReplay } = await import('./ontology/replay.js'), { refreshSnapshot } = await import('./ontology/sync.js');
    await refreshSnapshot({ force: true });
    const li = args.indexOf('--limit'), oi = args.indexOf('--only'), si = args.indexOf('--resume');
    // --resume <log file of an earlier run>: skip the cases that run already logged (the log prints the first 26 characters of each id)
    const skip = si >= 0 ? (await import('node:fs')).readFileSync(args[si + 1], 'utf8').split(String.fromCharCode(10)).map((l) => l.split(' ')[0]).filter((x) => x.startsWith('inc:')) : [];
    const r = await traceReplay({ limit: li >= 0 ? Number(args[li + 1]) : 0, only: oi >= 0 ? args[oi + 1] : null, skip, log: (l) => console.error(l) });
    console.log(JSON.stringify(r, null, 1));
  } else if (cmd === 'truth-backfill') {
    // build status_history for cases stored before histories existed, from first_seen_ts + status + tags (--dry: counts only); then the labels they end up with
    const { historyFromStored, incidentTruth } = await import('./accuracy/truth.js');
    const dry = args.includes('--dry'), man = await col('ground_truth').find({ kind: 'incident' }).toArray(), counts = { cases: 0, with_history: 0, built: 0, bad: 0, good: 0, unlabelled: 0, by_source: {} };
    for (const inc of await col('incidents').find({}).toArray()) {
      counts.cases++;
      if (Array.isArray(inc.status_history) && inc.status_history.length) counts.with_history++;
      else { counts.built++; if (!dry) await col('incidents').updateOne({ _id: inc._id }, { $set: { status_history: historyFromStored(inc) } }); }
      const t = incidentTruth(inc, man.find((m) => m.id === inc._id)?.label);
      counts[t.label || 'unlabelled']++; if (t.source) counts.by_source[t.source] = (counts.by_source[t.source] || 0) + 1;
    }
    console.log(JSON.stringify({ dry, ...counts }, null, 1));
  } else if (cmd === 'fixture-tx') {
    const [hash, name] = args;
    if (!hash || !name || !/^[a-z0-9-]+$/.test(name)) throw new Error('usage: fixture-tx <hash> <name (a-z 0-9 -)> [--note "<text>"] [--stdout]');
    const { txIndexer } = await import('./near/rpc.js'), { shrinkTx, fixtureDoc } = await import('./near/fixture.js');
    const j = await txIndexer('/v0/transactions', { tx_hashes: [hash] });
    const tx = j?.transactions?.[0]; if (!tx) throw new Error('transaction not found');
    const ni = args.indexOf('--note'), doc = fixtureDoc({ name, note: ni >= 0 ? args[ni + 1] : '', hash, tx: shrinkTx(tx), synthetic: false });
    if (args.includes('--stdout')) console.log(JSON.stringify(doc)); // the Railway file system is not kept: copy this into test/fixtures/tx/<name>.json
    else { const fs = await import('node:fs'); fs.mkdirSync('test/fixtures/tx', { recursive: true }); fs.writeFileSync(`test/fixtures/tx/${name}.json`, JSON.stringify(doc, null, 1) + '\n'); console.log(`wrote test/fixtures/tx/${name}.json`); }
  } else if (cmd === 'ontology-apply') {
    // recompute the grouping kinds stored on wallets with the current rule (--dry: count only), then regroup
    const { applyGroupingKinds } = await import('./ontology/apply.js');
    const dry = args.includes('--dry');
    const r = await applyGroupingKinds({ dry });
    console.log(JSON.stringify(r, null, 1));
    if (!dry) { await evaluateGroups(); console.log('regrouped'); }
  } else if (cmd === 'ontology-replay') {
    // every stored case traced twice (old rules, then the ontology) and compared; writes nothing
    const { replay, replayText } = await import('./ontology/replay.js');
    const { refreshSnapshot } = await import('./ontology/sync.js');
    await refreshSnapshot({ force: true });
    const oi = args.indexOf('--only');
    const r = await replay({ only: oi >= 0 ? args[oi + 1] : null, log: (l) => console.error(l) });
    console.log(args.includes('--json') ? JSON.stringify(r, null, 1) : replayText(r));
  } else if (cmd === 'ontology-gate') {
    const g = await ontologyGate();
    console.log(args.includes('--json') ? JSON.stringify(g, null, 1) : gateText(g));
  } else if (cmd === 'what-is') {
    const [account] = args;
    console.log(JSON.stringify({ ...(await whatIs(account)), relations: (await relationsOf(account, { direction: 'both' })).slice(0, 40).map((f) => `${f.subject} ${f.predicate} ${JSON.stringify(f.object)} · ${f.source} ${f.confidence ?? ''} · ${f.evidence || ''}`) }, null, 1));
  } else {
    console.log('commands: backfill <launchpad|all> <hours> | process | creators [max] | ledger [token] | evaluate | review [n] | status | check-ai');
  }
} finally { await flushLogs(); await closeDb(); }
process.exit(0);
