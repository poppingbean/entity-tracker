// Pool access for the simulated investor: what a buy / sell would really fill at on Ref (DCL and v2), using the on-chain
// quote functions. Same routes the live scanner uses (wNEAR direct, NEARLY / QTC through a DCL bridge pool, RHEA through Ref v2),
// but nothing is ever sent: these are read-only view calls.
import { view } from '../near/rpc.js';
import { DCL, REFV2, WNEAR, QUOTES, decimals, units, bridgeOut, quoteToNear } from '../near/quotes.js';
import { yoctoToNear } from '../near/rpc.js';

export const toYocto = (near) => (BigInt(Math.round(near * 1e6)) * 10n ** 18n).toString();

/** Current NEAR reserve of the pool, and what `buyNear` NEAR would buy (route + tokens out). */
export async function poolSnapshot(t, buyNear) {
  const amountIn = toYocto(buyNear);
  const dec = await decimals(t._id);
  const q = t.pool.quote, pid = t.pool.poolId;
  if (t.pool.dex === 'dcl') {
    const p = await view(DCL, 'get_pool', { pool_id: pid });
    const nearReserve = await quoteToNear(q, p.token_x === t._id ? p.total_y : p.total_x);
    const dclQuote = async (pool_ids, input_token, input_amount) => (await view(DCL, 'quote', { pool_ids, input_token, output_token: t._id, input_amount }).catch(() => null))?.amount || '0';
    let route = null, out = '0';
    const b = QUOTES[q]?.bridge;
    if (q === WNEAR) { route = { kind: 'direct', poolIds: [pid] }; out = await dclQuote([pid], WNEAR, amountIn); }
    else if (b?.dex === 'dcl') { route = { kind: 'dcl_multihop', poolIds: [b.poolId, pid] }; out = await dclQuote(route.poolIds, WNEAR, amountIn); }
    else if (b?.dex === 'refv2') {
      const mid = await bridgeOut(q, amountIn);
      route = { kind: 'refv2_then_dcl', bridgePool: b.poolId, quoteToken: q, midRaw: mid, poolIds: [pid] };
      out = mid !== '0' ? await dclQuote([pid], q, mid) : '0';
    }
    return { nearReserve, quoteOutRaw: out, quoteOut: units(out, dec), amountIn, route };
  }
  const p = await view(REFV2, 'get_pool', { pool_id: Number(pid) });
  const i = p.token_account_ids.indexOf(WNEAR); // meme.cooking Ref v2 pools are always wNEAR-paired
  if (i < 0) return { nearReserve: 0, quoteOutRaw: '0', quoteOut: 0, amountIn, route: null };
  const nearReserve = yoctoToNear(p.amounts[i]);
  const out = await view(REFV2, 'get_return', { pool_id: Number(pid), token_in: WNEAR, amount_in: amountIn, token_out: t._id });
  return { nearReserve, quoteOutRaw: out || '0', quoteOut: units(out || '0', dec), amountIn, route: { kind: 'refv2', poolIds: [pid] } };
}

/** yoctoNEAR received for selling `amountRaw` tokens (0n when there is no route / no liquidity). */
export async function quoteSell(t, amountRaw) {
  const amt = BigInt(amountRaw);
  if (amt <= 0n) return 0n;
  const q = t.pool.quote, pid = t.pool.poolId, b = QUOTES[q]?.bridge;
  try {
    if (t.pool.dex === 'refv2') return BigInt((await view(REFV2, 'get_return', { pool_id: Number(pid), token_in: t._id, amount_in: amt.toString(), token_out: WNEAR })) || '0');
    if (q === WNEAR) return BigInt((await view(DCL, 'quote', { pool_ids: [pid], input_token: t._id, output_token: WNEAR, input_amount: amt.toString() }))?.amount || '0');
    if (b?.dex === 'dcl') return BigInt((await view(DCL, 'quote', { pool_ids: [pid, b.poolId], input_token: t._id, output_token: WNEAR, input_amount: amt.toString() }))?.amount || '0');
    if (b?.dex === 'refv2') {
      const mid = (await view(DCL, 'quote', { pool_ids: [pid], input_token: t._id, output_token: q, input_amount: amt.toString() }))?.amount || '0';
      if (mid === '0') return 0n;
      return BigInt((await view(REFV2, 'get_return', { pool_id: b.poolId, token_in: q, amount_in: mid, token_out: WNEAR })) || '0');
    }
  } catch {}
  return 0n;
}

/** Largest part of a holding the pool can fill (DCL quotes 0 when a sale runs past the liquidity): halve until it fills. */
export async function fillable(t, heldRaw) {
  let amount = BigInt(heldRaw);
  for (let i = 0; i < 8 && amount > 0n; i++, amount /= 2n) {
    const out = await quoteSell(t, amount);
    if (out > 0n) return { amount, out };
  }
  return { amount: 0n, out: 0n };
}

/** Smallest amount whose sale yields at least `targetYocto` (bisection); the fillable amount when the target is out of reach. */
export async function amountForNear(t, heldRaw, targetYocto) {
  const f = await fillable(t, heldRaw);
  const held = BigInt(heldRaw);
  let lo = 0n, hi = f.amount;
  if (f.out < targetYocto) return f.amount;
  for (let i = 0; i < 24 && hi - lo > held / 100000n + 1n; i++) {
    const mid = (lo + hi) / 2n;
    if ((await quoteSell(t, mid)) >= targetYocto) hi = mid; else lo = mid;
  }
  return hi;
}
