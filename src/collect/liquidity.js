// Tokens found from the chain, not from a launchpad. The deploy watcher reads every NEAR block (FastNEAR neardata); the same blocks come here.
// A token becomes a token the tracker follows the moment liquidity is first added for it against a quote the tracker can value (wNEAR,
// a stablecoin …), on Ref v2 (`add_liquidity`, its "Liquidity added [...]" log) or Ref DCL (the `liquidity_added` / `create_pool` events).
// It does not matter which factory or launchpad made the contract: the laundering memecoins of the Binance case (smithii.near tokens,
// 2026-11-05..07) used none of the launchpads the tracker followed, and were invisible to Tokens and the scanner.
//
// What has to hold before a liquidity add opens a token (so a pool for wNEAR / USDC or an old token is not "launched" again):
//   - the token is not a quote itself and is not already tracked (a tracked token waiting for its pool, `awaiting_pool`, goes live instead);
//   - the tracker saw the token's contract deployed (`contract_deploys`, the deploy watcher) within TOKENS_FROM_DEPLOYS_MAX_AGE_DAYS;
//   - it answers ft_metadata (it is a fungible token).
// The token's live time is the liquidity block, its creator the account that signed the deploy (the factory's caller), and its
// `launchpad` the factory that deployed it (smithii.near …) or 'direct'. From there the usual pipeline runs: trades, early wallets, groups,
// the scanner's first check. The ontology learns its `created_by` edge at once (writer `tokens`).
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { view } from '../near/rpc.js';
import { DCL, REFV2, WNEAR, isKnownQuote } from '../near/quotes.js';

const b64 = (s) => { try { return JSON.parse(Buffer.from(String(s || ''), 'base64').toString()); } catch { return null; } };
const evOf = (log) => { if (!String(log).startsWith('EVENT_JSON:')) return null; try { return JSON.parse(log.slice(11)); } catch { return null; } };
// "Liquidity added [\"2500 fuk-3.smithii.near\", \"40 wrap.near\"], minted N shares"
const REF_ADDED = /^Liquidity added \[(.*)\], minted/;
const legsOf = (text) => [...String(text).matchAll(/"(\d+) ([^"\s]+)"/g)].map((m) => ({ raw: m[1], token: m[2] }));

/**
 * The liquidity adds in one block's successful receipts. Pure (exported for tests). Returns
 * [{ dex, poolId, tokens: [{ token, raw }], provider, tx, height, ts }] (`tokens` = both sides of the pool).
 */
export function liquidityAdds(b) {
  const out = [], ts = Number(b.block.header.timestamp_nanosec) / 1e6, height = b.block.header.height;
  for (const s of b.shards || []) for (const ro of s.receipt_execution_outcomes || []) {
    const rc = ro.receipt, o = ro.execution_outcome?.outcome || {};
    if (!rc || o.status?.Failure) continue;
    const at = { tx: ro.tx_hash || null, height, ts, provider: rc.predecessor_id };
    if (rc.receiver_id === REFV2) {
      const calls = (rc.receipt?.Action?.actions || []).map((a) => a?.FunctionCall).filter(Boolean);
      const add = calls.find((c) => c.method_name === 'add_liquidity');
      if (!add) continue;
      const args = b64(add.args) || {};
      for (const log of o.logs || []) {
        const m = REF_ADDED.exec(log);
        if (m) out.push({ ...at, dex: 'refv2', poolId: args.pool_id ?? null, tokens: legsOf(m[1]) });
      }
    } else if (rc.receiver_id === DCL) {
      for (const log of o.logs || []) {
        const e = evOf(log);
        if (!e || !['liquidity_added', 'create_pool'].includes(e.event) || !Array.isArray(e.data)) continue;
        for (const d of e.data) {
          const id = d?.pool_id; if (!id) continue;
          const [x, y] = String(id).split('|');
          out.push({ ...at, dex: 'dcl', poolId: id, tokens: [{ token: x, raw: d.amount_x ?? d.paid_token_x ?? null }, { token: y, raw: d.amount_y ?? d.paid_token_y ?? null }], provider: d.owner_id || at.provider });
        }
      }
    }
  }
  return out;
}

/** The token and its quote in one add: exactly one side a quote the tracker can value, the other side not a quote. Pure. */
export function tokenOfAdd(a, isQuote = isKnownQuote) {
  if (!a?.tokens || a.tokens.length !== 2) return null;
  const [x, y] = a.tokens, qx = isQuote(x.token), qy = isQuote(y.token);
  if (qx === qy) return null; // two quotes (wNEAR/USDC) or two memecoins: not a launch the scanner can value
  const tok = qx ? y : x, q = qx ? x : y;
  return { token: tok.token, quote: q.token, quoteRaw: q.raw, pool: { dex: a.dex, poolId: a.poolId, quote: q.token } };
}

/** Whole NEAR in a raw wNEAR amount (24 decimals), else null. */
const nearOf = (quote, raw) => (quote === WNEAR && raw ? Number(BigInt(raw) / 10n ** 18n) / 1e6 : null);

/** Open (or bring live) the tokens these liquidity adds launch. Returns the token ids opened. */
export async function trackLiquidity(blocks) {
  const C = config.tokensFromDeploys;
  if (!C.enabled || !blocks.length) return [];
  const opened = [];
  for (const b of blocks) for (const a of liquidityAdds(b)) {
    const t = tokenOfAdd(a);
    if (!t) continue;
    try { if (await openToken(t, a)) opened.push(t.token); } catch (e) { warn(`token from liquidity ${t.token}: ${e.message}`); }
  }
  return opened;
}

/**
 * One token's first liquidity. An `awaiting_pool` token (a tkn.near launch, or one opened earlier from its deploy) goes live; an unknown
 * token deployed recently is added. Returns true when a token was opened or went live.
 */
export async function openToken(t, a, { now = Date.now() } = {}) {
  const C = config.tokensFromDeploys;
  const prev = await col('tokens').findOne({ _id: t.token }, { projection: { status: 1, launchpad: 1 } });
  const live = { pool: t.pool, live_ts: a.ts, live_height: a.height, live_tx: a.tx, liquidity_near: nearOf(t.quote, t.quoteRaw), status: 'new', next_process_ts: 0 };
  if (prev) {
    if (prev.status !== 'awaiting_pool') return false; // already tracked: a later add is just liquidity
    await col('tokens').updateOne({ _id: t.token, status: 'awaiting_pool' }, { $set: live });
    info(`POOL ${prev.launchpad} ${t.token}: ${t.pool.dex} ${t.pool.poolId ?? ''} (first liquidity, live from the block)`);
    await syncToken(t.token);
    return true;
  }
  const dep = await col('contract_deploys').find({ account: t.token }).sort({ ts: 1 }).limit(1).next();
  if (!dep || now - dep.ts > C.maxAgeDays * 86400e3) return false; // not a fresh deploy the watcher saw: an old token getting a new pool
  const md = await view(t.token, 'ft_metadata').catch(() => null);
  if (!md?.symbol) return false; // not a fungible token
  const doc = tokenDoc(t.token, dep, md, live, a);
  const r = await col('tokens').updateOne({ _id: t.token }, { $setOnInsert: doc }, { upsert: true });
  if (!r.upsertedCount) return false;
  info(`NEW ${doc.launchpad} ${doc.symbol || ''} ${t.token}: first liquidity on ${t.pool.dex} ${t.pool.poolId ?? ''}${doc.liquidity_near ? ` (${Math.round(doc.liquidity_near)} NEAR)` : ''}, deployed ${new Date(dep.ts).toISOString().slice(0, 16)} by ${doc.creator}`);
  await syncToken(t.token);
  return true;
}

/** The tokens document for a token found from its deploy (same shape as a launchpad launch, collect/launches.js). Pure. */
export function tokenDoc(id, dep, md, live, a = {}) {
  // a factory deploys the token into its own sub-account on behalf of the signer (smithii.near, tkn.near …); a self-deployed token is 'direct'
  const factory = dep.by && dep.by !== id && id.endsWith(`.${dep.by}`) ? dep.by : null;
  return {
    launchpad: factory || 'direct', source: 'deploy', factory, creator: dep.signer || dep.by || a.provider || null, symbol: md?.symbol || null, name: md?.name || null, meme_id: null,
    dev_buy_near: null, dev_buy_quote_raw: null, lp: { owner: a.provider || null, locked: null }, tax: null, created_ts: Date.now(),
    deploy: { ts: dep.ts, height: dep.height, kind: dep.kind, by: dep.by, signer: dep.signer },
    sync_height: null, sync_ts: null, trades_n: 0, live_on_first_trade: false,
    ...live, status: live.status || (isKnownQuote(live.pool?.quote) ? 'new' : 'skipped_quote'),
  };
}

/**
 * The two features stay in step: the ontology learns the token's creator at once (G1, writer `tokens`), and the token's contract audit
 * jumps the audit queue, so the scanner's first check (OBSERVE_SECONDS after the liquidity) reads a finished audit.
 */
async function syncToken(id) {
  await (await import('../ontology/writers.js')).syncFacts(['tokens'], { scope: { tokens: { ids: [id] } } }).catch(() => {});
  const audited = await col('audits').findOne({ _id: id, 'auto.ts': { $exists: true } }, { projection: { _id: 1 } }).catch(() => null);
  if (!audited) await (await import('../audit/watcher.js')).enqueueAudit(id, { reason: 'token went live', priority: 3, force: false }).catch(() => {});
}

/** Retry a chain read a few times (a long backfill makes thousands of calls and the public endpoints rate-limit). */
// only a network-type error is worth another try; a contract that answers with an error (no such method, no code) answers the same again
const transient = (e) => /timeout|timed out|abort|429|too many|50[0-4]|ECONN|ENOTFOUND|EAI_AGAIN|socket|fetch failed|network/i.test(String(e?.message || e));
async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; if (!transient(e)) break; await new Promise((r) => setTimeout(r, 1500 * (i + 1) ** 2)); } }
  throw last;
}

/**
 * The first pool of a token found later: its creator's own `add_liquidity` (the exact launch block and the Ref v2 pool id: neither is in the
 * token's own history, where the first swap is) or, failing that, the first pool event in the token's history (a swap, possibly routed
 * through an aggregator with no pool id). Returns the earlier hit, or null.
 */
export async function findFirstPool(id, creator, { maxRows = 300 } = {}) {
  const { firstPool, poolHit } = await import('./launches.js');
  const { accountRows, fetchTxs } = await import('../near/indexer.js');
  const own = (await retry(() => firstPool(id))).hit;
  let byCreator = null;
  if (creator && creator !== id) {
    const { rows } = await retry(() => accountRows(creator, { desc: false, maxRows }));
    byCreator = poolHit(id, await retry(() => fetchTxs(rows.filter((r) => r.ok).map((r) => r.hash))));
  }
  if (own && byCreator) return byCreator.tx.ts <= own.tx?.ts || !own.pool.poolId ? { ...byCreator, pool: { ...byCreator.pool, poolId: byCreator.pool.poolId ?? own.pool.poolId } } : own;
  return byCreator || own;
}

/**
 * Backfill: tokens deployed in the last `days` that got liquidity while nobody was looking (before this module ran). For every account the
 * deploy watcher saw deployed and not tracked yet: a fungible token (ft_metadata) with a first pool event against a quote the tracker can
 * value is opened with the live time of that event. Chain reads are retried; what still fails is counted, never taken for "no pool".
 * `dry`: list only. Returns { tokens: [{ token, launchpad, pool, live_ts, opened }], failed: [{ token, error }], checked }.
 */
export async function backfillFromDeploys(days = 7, { dry = false, log = () => {} } = {}) {
  const since = Date.now() - days * 86400e3;
  const deps = await col('contract_deploys').aggregate([{ $match: { ts: { $gte: since } } }, { $sort: { ts: 1 } }, { $group: { _id: '$account', dep: { $first: '$$ROOT' } } }]).toArray();
  const tracked = new Set((await col('tokens').find({ _id: { $in: deps.map((d) => d._id) } }, { projection: { _id: 1 } }).toArray()).map((t) => t._id));
  // skip contracts the audit already knows are not tokens (one ft_metadata call each for the rest)
  const notToken = new Set((await col('audits').find({ _id: { $in: deps.map((d) => d._id) }, 'auto.role': { $exists: true, $nin: ['token', 'multi_token'] } }, { projection: { _id: 1 } }).toArray()).map((a) => a._id));
  const out = [], failed = [];
  const todo = deps.filter(({ _id: id }) => !tracked.has(id) && !notToken.has(id) && !isKnownQuote(id));
  // eight accounts at a time: one ft_metadata call each, and a history walk for the tokens
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (next < todo.length) await one(todo[next++]); }));
  out.sort((a, b) => a.live_ts.localeCompare(b.live_ts));
  return { tokens: out, failed, checked: todo.length };

  async function one({ _id: id, dep }) {
    try {
      // not a token: the contract has no ft_metadata (a wallet, a DAO …) and answers with an error; only a network error is a failure
      const md = await retry(() => view(id, 'ft_metadata')).catch((e) => (transient(e) ? Promise.reject(e) : null));
      if (!md?.symbol) return;
      const hit = await findFirstPool(id, dep.signer);
      if (!hit?.tx || !isKnownQuote(hit.pool.quote)) return;
      const live = { pool: hit.pool, live_ts: hit.tx.ts, live_height: hit.tx.height, live_tx: hit.tx.hash, liquidity_near: null, status: 'new', next_process_ts: 0 };
      const doc = tokenDoc(id, dep, md, live, { provider: hit.tx.signer });
      let opened = false;
      if (!dry) { opened = !!(await col('tokens').updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true })).upsertedCount; if (opened) await syncToken(id); }
      out.push({ token: id, symbol: doc.symbol, launchpad: doc.launchpad, creator: doc.creator, pool: `${hit.pool.dex} ${hit.pool.poolId ?? ''}`, live_ts: new Date(hit.tx.ts).toISOString().slice(0, 16), opened });
      log(`${dry ? 'would open' : opened ? 'opened' : 'already there'}: ${doc.symbol} ${id} (${doc.launchpad}) live ${new Date(hit.tx.ts).toISOString().slice(0, 16)} on ${hit.pool.dex} ${hit.pool.poolId ?? '(pool id unknown)'}`);
    } catch (e) { failed.push({ token: id, error: e.message.slice(0, 120) }); log(`failed: ${id}: ${e.message.slice(0, 120)}`); }
  }
}
