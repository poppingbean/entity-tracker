// The simulated wallet. Money here is paper: a buy / sell is priced with the pool's own on-chain quote (price impact + pool fee
// included), then the launch's token tax and a small extra slippage are applied. Nothing is ever sent to the chain.
import { col } from '../db.js';
import { config } from '../config.js';
import { info, warn } from '../log.js';
import { decimals, units } from '../near/quotes.js';
import { yoctoToNear, ftBalance } from '../near/rpc.js';
import { poolSnapshot, quoteSell, fillable, amountForNear, toYocto } from '../scanner/pool.js';

const S = () => config.sim;
const keepBps = (x) => (10000 - x) / 10000;

export async function ensureAccount() {
  const a = await col('sim_account').findOne({ _id: 'main' });
  if (a) return a;
  const doc = { _id: 'main', start_near: S().startNear, cash_near: S().startNear, created_ts: Date.now(), realized_near: 0 };
  await col('sim_account').updateOne({ _id: 'main' }, { $setOnInsert: doc }, { upsert: true });
  info(`SIM wallet created with ${S().startNear} NEAR (paper money)`);
  return doc;
}

export async function resetSim() {
  for (const c of ['sim_account', 'sim_positions', 'sim_fills', 'sim_equity']) await col(c).deleteMany({});
  return ensureAccount();
}

/** Token tax as fractions kept by the holder on a buy and on a sell (buy / sell bps and a per-transfer fee in pips). */
function taxKeep(tax) {
  const pips = (tax?.transferFeePips || 0) / 1e6;
  return { buy: keepBps(tax?.buyBps || 0) * (1 - pips), sell: keepBps(tax?.sellBps || 0) * (1 - pips) };
}

/** Can the simulated wallet take this buy? Returns a reason string when it cannot. */
export async function checkBuy(token, nearAmount) {
  const a = await ensureAccount();
  if (a.cash_near - nearAmount < S().minReserveNear) return `cash ${a.cash_near.toFixed(2)} N would fall below the ${S().minReserveNear} N reserve`;
  const open = await col('sim_positions').find({ status: 'open' }, { projection: { cost_near: 1, token: 1, realized_near: 1 } }).toArray();
  if (open.some((p) => p.token === token)) return 'already holding this token';
  const exposure = open.reduce((s, p) => s + Math.max(0, p.cost_near - (p.realized_near || 0)), 0);
  if (exposure + nearAmount > S().maxOpenCostNear) return `open exposure ${exposure.toFixed(1)} N + ${nearAmount} N would exceed the ${S().maxOpenCostNear} N cap`;
  const today = await col('sim_positions').countDocuments({ opened_ts: { $gt: Date.now() - 86400e3 } });
  if (today >= S().maxBuysPerDay) return `${today} buys in the last 24 h (cap ${S().maxBuysPerDay})`;
  return null;
}

/** Simulated buy of `nearAmount` NEAR of the token. Returns { status, reason?, position? }. */
export async function simBuy(t, nearAmount, meta = {}) {
  const blocked = await checkBuy(t._id, nearAmount);
  if (blocked) return { status: 'blocked', reason: blocked };
  const snap = await poolSnapshot(t, nearAmount);
  if (!snap.route || BigInt(snap.quoteOutRaw) === 0n) return { status: 'blocked', reason: 'no quote / route' };
  const keep = taxKeep(t.tax);
  const gross = BigInt(snap.quoteOutRaw);
  const net = (gross * BigInt(Math.round(keepBps(S().extraSlippageBps) * 1e6)) * BigInt(Math.round(keep.buy * 1e6))) / 10n ** 12n; // x extra slippage x token tax
  const dec = await decimals(t._id);
  const tokens = units(net.toString(), dec);
  // reserve the cash first (conditional update: never overspend under concurrency)
  const r = await col('sim_account').updateOne({ _id: 'main', cash_near: { $gte: nearAmount + S().minReserveNear } }, { $inc: { cash_near: -nearAmount } });
  if (!r.modifiedCount) return { status: 'blocked', reason: 'not enough cash' };
  const now = Date.now();
  const id = `${t._id}|${now}`;
  const creatorBase = t.creator ? (await ftBalance(t._id, t.creator))?.toString() ?? null : null;
  const pos = {
    _id: id, token: t._id, symbol: t.symbol || null, launchpad: t.launchpad, creator: t.creator || null, opened_ts: now, status: 'open', cost_near: nearAmount, held_raw: net.toString(), held_tokens: tokens,
    decimals: dec, entry_price: tokens > 0 ? nearAmount / tokens : null, realized_near: 0, value_near: nearAmount, roi: 0, checked_ts: now, route: snap.route.kind, tax: t.tax || null,
    creator_base_raw: creatorBase, size_reason: meta.sizeReason || null, ai: meta.ai ? { action: meta.ai.action, confidence: meta.ai.confidence, risk_level: meta.ai.risk_level } : null, score: meta.score ?? null,
    scan_id: meta.scanId || null, take_profit: null, exit: null, origin: meta.origin || 'first_scan',
  };
  await col('sim_positions').insertOne(pos);
  await col('sim_fills').insertOne({ _id: `${id}|buy`, position_id: id, ts: now, side: 'buy', near: nearAmount, tokens, price: pos.entry_price, route: snap.route.kind, reason: meta.reason || 'AI approved' });
  info(`SIM BUY ${t.symbol || ''} ${t._id}: ${nearAmount} NEAR → ${tokens.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens (${snap.route.kind})`);
  return { status: 'bought', position: pos };
}

/** Profit of a simulated position split in realized (NEAR already sold minus the cost of the tokens sold) and unrealized (what is still held, at today's value, minus its cost). */
export function positionPnl(p) {
  const closed = p.status === 'closed';
  const initial = p.entry_price > 0 ? p.cost_near / p.entry_price : null;
  const soldFrac = closed ? 1 : initial ? Math.min(1, Math.max(0, 1 - (p.held_tokens || 0) / initial)) : 0;
  const costSold = p.cost_near * soldFrac;
  const realized = (p.realized_near || 0) - costSold;
  const unrealized = closed ? 0 : (p.value_near || 0) - (p.cost_near - costSold);
  return { realized_pnl: realized, unrealized_pnl: unrealized, pnl: realized + unrealized };
}

/** NEAR the whole holding would fetch right now (after the token's sell tax), 0 when the pool cannot fill any of it. */
export async function valueOf(t, heldRaw, tax) {
  const f = await fillable(t, heldRaw);
  return yoctoToNear(f.out.toString()) * taxKeep(tax).sell;
}

/** Simulated sell of `share` (0-1] of a position, or of exactly `amountRaw` tokens. */
export async function simSell(t, pos, { share = 1, amountRaw = null, reason = 'manual' } = {}) {
  if (pos.status !== 'open') return { status: 'skipped', reason: 'position is closed' };
  const held = BigInt(pos.held_raw);
  let amt = amountRaw != null ? BigInt(amountRaw) : (held * BigInt(Math.round(share * 1e6))) / 1000000n;
  if (share >= 0.9999 && amountRaw == null) amt = held;
  if (amt > held) amt = held;
  const f = await fillable(t, amt);
  if (f.out === 0n) return { status: 'blocked', reason: 'the pool cannot fill this sale right now' };
  const near = yoctoToNear(f.out.toString()) * taxKeep(pos.tax).sell * keepBps(S().extraSlippageBps);
  const remaining = held - f.amount;
  const dec = pos.decimals;
  const now = Date.now();
  const realized = (pos.realized_near || 0) + near;
  const closed = remaining === 0n;
  const upd = { held_raw: remaining.toString(), held_tokens: units(remaining.toString(), dec), realized_near: realized };
  if (closed) { upd.status = 'closed'; upd.exit = { ts: now, reason, near, share: 1 }; upd.value_near = 0; upd.roi = realized / pos.cost_near - 1; }
  else if (reason.startsWith('take profit')) upd.take_profit = { ts: now, near, share: Number(f.amount * 10000n / held) / 10000, reason };
  await col('sim_positions').updateOne({ _id: pos._id }, { $set: upd });
  await col('sim_account').updateOne({ _id: 'main' }, { $inc: { cash_near: near, realized_near: near } });
  await col('sim_fills').insertOne({ _id: `${pos._id}|sell|${now}`, position_id: pos._id, ts: now, side: 'sell', near, tokens: units(f.amount.toString(), dec), price: near / Math.max(1e-12, units(f.amount.toString(), dec)), reason });
  info(`SIM SELL ${pos.symbol || ''} ${pos.token}: ${near.toFixed(3)} NEAR back (${reason})${closed ? ' · closed' : ''}`);
  return { status: closed ? 'closed' : 'sold', near, closed };
}

/** Mark every open position to market, take profit, watch for dev rugs. Called every POSITION_CHECK_SECONDS. */
export async function managePositions(blacklistCreator) {
  const open = await col('sim_positions').find({ status: 'open' }).toArray();
  for (const pos of open) {
    try {
      const t = await col('tokens').findOne({ _id: pos.token });
      if (!t?.pool) continue;
      const value = await valueOf(t, pos.held_raw, pos.tax);
      const roi = pos.cost_near ? (value + (pos.realized_near || 0)) / pos.cost_near - 1 : 0;
      await col('sim_positions').updateOne({ _id: pos._id }, { $set: { value_near: value, roi, checked_ts: Date.now() } });
      pos.value_near = value; pos.roi = roi;

      // dev rug: the creator's balance fell by 20 % or more while we hold
      if (S().rugWatch && pos.creator && pos.creator_base_raw && BigInt(pos.creator_base_raw) > 0n) {
        const base = BigInt(pos.creator_base_raw), fell = (b) => b != null && b * 10000n <= base * 8000n;
        // confirm with a second read a few seconds later: one bad RPC answer must not blacklist a creator
        let bal = await ftBalance(pos.token, pos.creator);
        if (fell(bal)) { await new Promise((r) => setTimeout(r, 5000)); bal = await ftBalance(pos.token, pos.creator); }
        if (fell(bal)) {
          await blacklistCreator(pos.creator, { token: pos.token, symbol: pos.symbol, reason: `creator balance fell ${Number(((base - bal) * 10000n) / base) / 100}% while the simulated portfolio held it` });
          warn(`DEV RUG ${pos.symbol || ''} ${pos.token}: creator dumped, exiting the simulated position`);
          await simSell(t, pos, { share: 1, reason: 'dev rug' });
          continue;
        }
      }
      // take profit once: cost back plus a share of the profit
      if (!pos.take_profit && roi > S().takeProfitRoi && BigInt(pos.held_raw) > 0n) {
        const profit = value + (pos.realized_near || 0) - pos.cost_near;
        const want = Math.min(value, pos.cost_near + S().takeProfitShare * Math.max(0, profit));
        const amount = await amountForNear(t, pos.held_raw, BigInt(toYocto(want)));
        if (amount > 0n) await simSell(t, pos, { amountRaw: amount, reason: `take profit at ROI ${(roi * 100).toFixed(0)}%` });
      }
    } catch (e) { warn(`sim check ${pos.token} failed: ${e.message}`); }
  }
  // equity curve (at most one point every 5 minutes)
  const last = await col('sim_equity').find().sort({ ts: -1 }).limit(1).toArray();
  if (!last[0] || Date.now() - last[0].ts > 300e3) {
    const a = await ensureAccount();
    const fresh = await col('sim_positions').find({ status: 'open' }, { projection: { value_near: 1 } }).toArray();
    const openValue = fresh.reduce((s, p) => s + (p.value_near || 0), 0);
    const ts = Date.now();
    await col('sim_equity').replaceOne({ _id: ts }, { _id: ts, ts, cash: a.cash_near, open_value: openValue, equity: a.cash_near + openValue }, { upsert: true });
  }
  return open.length;
}
