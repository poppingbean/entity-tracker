// Every contract deployed on NEAR, audited automatically. The watcher follows the chain tip through FastNEAR neardata (with the API key),
// records each successful DeployContract / DeployGlobalContract / UseGlobalContract (`contract_deploys`) and queues the account
// (`audit_queue`); the queue is worked through a few audits per pass beside the worker loop. Tip blocks are fast; blocks older than
// ~11 h come from a slow archive, so after downtime it catches up at most AUTO_AUDIT_MAX_BEHIND_BLOCKS and skips the rest.
import { col, metaGet, metaSet } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { autoAudit } from './auto.js';
import { raise } from '../alerts/store.js';
import { STRONG_FINDINGS } from './service.js';

const AUTH = () => (config.fastnearApiKey ? { authorization: `Bearer ${config.fastnearApiKey}` } : {});
const NEARDATA = () => config.autoAudit.neardataUrl;

/** One block; null when the height has no block (skipped heights), throws when the feed doesn't answer (retry later). */
async function block(height) {
  const r = await fetch(`${NEARDATA()}/v0/block/${height}`, { headers: AUTH(), signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`neardata ${r.status}`);
  const j = await r.json();
  return j?.block ? j : null;
}
async function tipHeight() {
  const r = await fetch(`${NEARDATA()}/v0/last_block/final`, { headers: AUTH(), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`neardata ${r.status}`);
  return (await r.json()).block.header.height;
}

/** Deploy actions in a block's successful receipts. Pure (exported for tests). */
export function deploysInBlock(b) {
  const out = [], ts = Number(b.block.header.timestamp_nanosec) / 1e6, height = b.block.header.height;
  for (const s of b.shards || []) for (const ro of s.receipt_execution_outcomes || []) {
    const r = ro.receipt, act = r?.receipt?.Action;
    if (!act || ro.execution_outcome?.outcome?.status?.Failure) continue;
    const kinds = (act.actions || []).map((a) => (typeof a === 'string' ? a : Object.keys(a)[0]));
    const deploy = kinds.find((k) => /^(DeployContract|DeployGlobalContract|UseGlobalContract)/.test(k));
    if (!deploy) continue;
    const a = act.actions[kinds.indexOf(deploy)], v = (typeof a === 'object' && a[deploy]) || {};
    out.push({ _id: r.receipt_id, account: r.receiver_id, kind: deploy, by: r.predecessor_id, signer: act.signer_id, height, ts, created: kinds.includes('CreateAccount'),
      global: typeof v === 'object' ? v.contract_identifier ?? v.account_id ?? v.code_hash ?? null : null });
  }
  return out;
}

/** Read the next blocks from the cursor and queue what was deployed. Returns { blocks, deploys, behind }. */
export async function watchDeploys() {
  const A = config.autoAudit, top = await tipHeight();
  let cursor = await metaGet('audit:deploy_cursor');
  if (!cursor) cursor = top - 10;
  if (top - cursor > A.maxBehindBlocks) { warn(`deploy watcher: ${top - cursor} blocks behind, skipping to ${top - A.maxBehindBlocks}`); cursor = top - A.maxBehindBlocks; }
  const heights = []; for (let h = cursor + 1; h <= Math.min(top, cursor + A.blocksPerTick); h++) heights.push(h);
  // fetch in parallel, then advance the cursor over the contiguous heights that answered
  const results = new Array(heights.length);
  let i = 0;
  await Promise.all(Array.from({ length: A.fetchConcurrency }, async () => {
    while (i < heights.length) { const k = i++; try { results[k] = { b: await block(heights[k]) }; } catch (e) { results[k] = { err: e.message }; } }
  }));
  let last = cursor, found = [];
  for (let k = 0; k < heights.length; k++) {
    if (results[k].err) break;
    last = heights[k];
    if (results[k].b) found.push(...deploysInBlock(results[k].b));
  }
  if (found.length) {
    await col('contract_deploys').bulkWrite(found.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
    await col('audit_queue').bulkWrite(found.map((d) => ({ updateOne: { filter: { _id: d.account }, update: {
      $set: { deploy: { by: d.by, signer: d.signer, kind: d.kind, ts: d.ts, height: d.height, global: d.global }, status: 'pending', enqueued_ts: Date.now(), attempts: 0,
        priority: /^DeployContract|^DeployGlobal/.test(d.kind) ? 2 : 1 } }, upsert: true } })), { ordered: false });
  }
  await metaSet('audit:deploy_cursor', last);
  return { blocks: last - cursor, deploys: found.length, behind: top - last };
}

/** Audit up to `n` queued contracts (new code first). Returns how many were audited. */
export async function processAuditQueue(n = config.autoAudit.auditsPerTick) {
  const jobs = await col('audit_queue').find({ status: 'pending', $or: [{ retry_ts: { $exists: false } }, { retry_ts: { $lte: Date.now() } }] }).sort({ priority: -1, enqueued_ts: 1 }).limit(n).toArray();
  let done = 0;
  for (const j of jobs) {
    await col('audit_queue').updateOne({ _id: j._id }, { $set: { status: 'running', started_ts: Date.now() } });
    try {
      const a = await autoAudit(j._id, { deploy: j.deploy, force: !!j.force });
      await col('audit_queue').updateOne({ _id: j._id }, { $set: { status: 'done', done_ts: Date.now(), level: a.auto?.level || null, role: a.auto?.role || null } });
      await alertFromAudit(j._id, a.auto, j).catch((e) => warn(`audit alert ${j._id}: ${e.message}`));
      done++;
    } catch (e) {
      const attempts = (j.attempts || 0) + 1;
      await col('audit_queue').updateOne({ _id: j._id }, { $set: { status: attempts >= 3 ? 'error' : 'pending', attempts, error: e.message.slice(0, 200), retry_ts: Date.now() + 10 * 60e3 * attempts } });
      warn(`auto audit ${j._id}: ${e.message}`);
    }
  }
  if (done) info(`auto audit: ${done} contract${done > 1 ? 's' : ''} audited`);
  return done;
}

/** Alerts from an audit: a newly deployed contract that is dangerous, and a redeploy that adds powers over users. */
export async function alertFromAudit(account, auto, job = {}) {
  if (!auto || auto.no_code) return;
  const url = `/audit/${encodeURIComponent(account)}`;
  const related = { tokens: auto.role === 'token' ? [account] : [], collections: auto.role === 'nft' ? [account] : [], wallets: [auto.deploy?.signer, auto.deploy?.deployer].filter(Boolean), creators: auto.deploy?.signer ? [auto.deploy.signer] : [] };
  const strong = (auto.findings || []).filter((f) => STRONG_FINDINGS.has(f.key) && (f.severity === 'critical' || f.severity === 'high'));
  if (job.deploy && (auto.level === 'critical' || strong.length)) {
    const top = strong[0] || auto.findings.find((f) => f.severity === 'critical');
    await raise(`contract_risk|${account}|${auto.code_key}`, { type: 'contract_risk', severity: 'high', title: `New contract ${account}: ${top?.title || 'critical audit'}`, url, related,
      text: `${auto.label} deployed${auto.deploy?.signer ? ` by ${auto.deploy.signer}` : ''}. ${auto.summary?.headline || top?.detail || ''}`.slice(0, 600), data: { level: auto.level, role: auto.role, event_ts: Date.now() } });
  }
  if (auto.change?.added_powers?.length) await raise(`contract_power_added|${account}|${auto.code_key}`, { type: 'contract_power_added', severity: 'high', title: `${account}: the new code adds ${auto.change.added_powers.join(', ').replace(/_/g, ' ')}`, url, related,
    text: auto.change.ai?.explanation || 'The contract was redeployed with new powers over its users.', data: { added: auto.change.added_powers, event_ts: Date.now() } });
}

/** Queue one account by hand or from another detector (a code change): it is audited again with fresh reads. */
export const enqueueAudit = (account, { reason = 'manual', priority = 3, force = true } = {}) => col('audit_queue').updateOne({ _id: account, status: { $ne: 'running' } },
  { $set: { status: 'pending', enqueued_ts: Date.now(), attempts: 0, priority, force, reason }, $unset: { retry_ts: '' } }, { upsert: true }).catch((e) => { if (e.code !== 11000) throw e; }); // already running: fine
