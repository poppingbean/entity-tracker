// Money flows out of executed transactions (FastNEAR tx indexer format): who sent what to whom, from the successful receipts only.
//   NEAR        Transfer actions between accounts (gas refunds from `system` are left out)
//   tokens      NEP-141 events (ft_transfer / ft_mint / ft_burn) and the older plain "Transfer N from A to B" log some tokens still write
//   NFTs        NEP-171 nft_transfer events
//   NEAR Intents  balances inside intents.near (NEP-245 mt_transfer between intents accounts) and withdrawals out of it (dip4 ft_withdraw /
//               native_withdraw / mt_burn with a withdraw memo); a withdrawal to another chain is where a trail on NEAR ends
// Pure: exported for tests and used by the tracer and the live detector.

export const NEAR = 'near';
const LEGACY = /^Transfer (\d+) from ([a-z0-9._-]+) to ([a-z0-9._-]+)$/;
const ev = (log) => { if (!log.startsWith('EVENT_JSON:')) return null; try { return JSON.parse(log.slice(11)); } catch { return null; } };
const big = (s) => { try { return BigInt(s); } catch { return 0n; } };

/** Flows in one receipt execution: `r` = { receipt, execution_outcome } (tx indexer and neardata shapes both work). */
export function flowsOfReceipt(r, { tx = null, height = null, ts = null } = {}) {
  const rc = r.receipt, o = r.execution_outcome?.outcome || {};
  if (!rc || o.status?.Failure) return [];
  const out = [], at = { tx, height: height ?? r.execution_outcome?.block_height ?? null, ts, receipt: rc.receipt_id };
  const add = (f) => { if (f.raw > 0n && f.from !== f.to) out.push({ ...at, ...f, raw: f.raw.toString() }); };
  const act = rc.receipt?.Action;
  if (act && rc.predecessor_id !== 'system') for (const a of act.actions || []) {
    if (a?.Transfer) add({ token: NEAR, from: rc.predecessor_id, to: rc.receiver_id, raw: big(a.Transfer.deposit), kind: 'transfer' });
    // NEAR attached to a call is paid in too (deposit_and_stake, near_deposit, a swap paying in NEAR); 1-yocto security deposits are not
    else if (a?.FunctionCall && big(a.FunctionCall.deposit) >= 10n ** 21n) add({ token: NEAR, from: rc.predecessor_id, to: rc.receiver_id, raw: big(a.FunctionCall.deposit), kind: 'call_deposit' });
  }
  const token = rc.receiver_id;
  for (const log of o.logs || []) {
    const m = log.match(LEGACY);
    if (m) { add({ token, from: m[2], to: m[3], raw: big(m[1]), kind: 'transfer' }); continue; }
    const e = ev(log);
    if (!e || !Array.isArray(e.data)) continue;
    if (e.standard === 'nep141') for (const d of e.data) {
      if (e.event === 'ft_transfer') add({ token, from: d.old_owner_id, to: d.new_owner_id, raw: big(d.amount), kind: 'transfer' });
      else if (e.event === 'ft_mint') add({ token, from: `mint:${token}`, to: d.owner_id, raw: big(d.amount), kind: 'mint' });
      else if (e.event === 'ft_burn') add({ token, from: d.owner_id, to: `burn:${token}`, raw: big(d.amount), kind: 'burn' });
    } else if (e.standard === 'nep171' && e.event === 'nft_transfer') for (const d of e.data) {
      for (const id of d.token_ids || []) out.push({ ...at, token: `nft:${token}`, nft: String(id), from: d.old_owner_id, to: d.new_owner_id, raw: '1', kind: 'nft' });
    } else if (e.standard === 'nep245' && token === 'intents.near') for (const d of e.data) {
      // balances inside NEAR Intents: token ids look like nep141:<contract>
      (d.token_ids || []).forEach((id, i) => {
        const t = `intents:${String(id).replace(/^nep141:/, '')}`, amt = big(d.amounts?.[i]);
        if (e.event === 'mt_transfer') add({ token: t, from: d.old_owner_id, to: d.new_owner_id, raw: amt, kind: 'intents' });
        else if (e.event === 'mt_mint') add({ token: t, from: 'intents:deposit', to: d.owner_id, raw: amt, kind: 'intents_deposit' });
        else if (e.event === 'mt_burn') add({ token: t, from: d.owner_id, to: /withdraw/i.test(d.memo || '') ? 'intents:withdraw' : 'intents:burn', raw: amt, kind: 'intents_withdraw' });
      });
    } else if (e.standard === 'dip4' && /withdraw/.test(e.event)) for (const d of e.data) {
      // where an intents withdrawal goes: a NEAR account, or another chain through a bridge token (memo "WITHDRAW_TO:<address>")
      const dest = d.memo && /WITHDRAW_TO:/i.test(d.memo) ? `chain:${d.memo.replace(/^.*WITHDRAW_TO:/i, '')}` : d.receiver_id;
      if (dest) out.push({ ...at, token: `intents:${d.token || 'wrap.near'}`, from: d.account_id, to: dest, raw: String(d.amount || '0'), kind: 'intents_out', via: d.token || null });
    }
  }
  return out;
}

/** Every flow in one tx indexer transaction document. */
export function flowsOfTx(t) {
  const tx = t.transaction?.hash, ts = Number(t.execution_outcome?.block_timestamp || 0) / 1e6 || null, height = t.execution_outcome?.block_height ?? null;
  return (t.receipts || []).flatMap((r) => flowsOfReceipt(r, { tx, height: r.execution_outcome?.block_height ?? height, ts }));
}

/** Net amounts per token for one account over a list of flows: { token: { in, out, net } } as BigInt strings. */
export function netOf(account, flows, accounts = new Set([account])) {
  const m = new Map();
  for (const f of flows) {
    const i = accounts.has(f.to), o = accounts.has(f.from);
    if (i === o) continue; // between the account's own wallets
    const x = m.get(f.token) || { in: 0n, out: 0n };
    if (i) x.in += BigInt(f.raw); else x.out += BigInt(f.raw);
    m.set(f.token, x);
  }
  return Object.fromEntries([...m].map(([k, v]) => [k, { in: v.in.toString(), out: v.out.toString(), net: (v.in - v.out).toString() }]));
}
