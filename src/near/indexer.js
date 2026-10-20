// FastNEAR transaction indexer helpers: account histories (oldest-first or newest-first), full transactions, decoding.
import { txIndexer } from './rpc.js';

const tsOf = (row) => Number(String(row.tx_block_timestamp).slice(0, 13));

/** One page of an account's tx list. `desc: false` = oldest first. Pages hold up to 200 rows. */
export async function accountPage(accountId, { desc = true, limit = 200, fromHeight, toHeight, resume } = {}) {
  const body = { account_id: accountId, desc, limit };
  if (fromHeight) body.from_tx_block_height = fromHeight;
  if (toHeight) body.to_tx_block_height = toHeight;
  if (resume) body.resume_token = resume;
  const j = await txIndexer('/v0/account', body);
  const rows = (j.account_txs || []).map((r) => ({ hash: r.transaction_hash, height: r.tx_block_height, ts: tsOf(r), isSigner: !!r.is_signer, isReceiver: !!r.is_receiver, ok: r.is_success !== false }));
  return { rows, resume: j.resume_token || null, count: j.txs_count ?? null };
}

/** Walk an account's history until `maxRows` rows, or until a row is past `untilTs` (when walking oldest-first). */
export async function accountRows(accountId, { desc = false, fromHeight, maxRows = 400, untilTs, sinceTs } = {}) {
  const out = []; let resume = null, count = null;
  while (out.length < maxRows) {
    const p = await accountPage(accountId, { desc, fromHeight, resume, limit: Math.min(200, maxRows - out.length) });
    count = count ?? p.count;
    let stop = false;
    for (const r of p.rows) {
      if (untilTs && !desc && r.ts > untilTs) { stop = true; break; } // oldest-first: past the horizon
      if (sinceTs && desc && r.ts < sinceTs) { stop = true; break; } // newest-first: older than wanted
      out.push(r);
    }
    if (stop || !p.resume || !p.rows.length) break;
    resume = p.resume;
  }
  return { rows: out, count };
}

/** Full transactions (with receipts, logs, events) for hashes, 20 per request. Returned oldest first. */
export async function fetchTxs(hashes) {
  hashes = [...new Set(hashes)];
  const out = new Map();
  for (let i = 0; i < hashes.length; i += 20) {
    const j = await txIndexer('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) });
    for (const t of j.transactions || []) { const d = decodeTx(t); if (!out.has(d.hash)) out.set(d.hash, d); }
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

const toNear = (yocto) => { try { return Number(BigInt(yocto) / 10n ** 18n) / 1e6; } catch { return 0; } };

/**
 * Normalise a transaction: signer, receiver, function calls (method + args + deposit), plain NEAR transfers,
 * and every EVENT_JSON / plain log with the contract that emitted it.
 */
export function decodeTx(t) {
  const tx = t.transaction;
  const calls = [], transfers = [];
  for (const a of tx.actions) {
    const fc = a.FunctionCall || a.Delegate?.delegate_action?.actions?.find((x) => x.FunctionCall)?.FunctionCall;
    if (fc) { let args = null; try { args = JSON.parse(Buffer.from(fc.args, 'base64').toString()); } catch {} calls.push({ method: fc.method_name, args, depositNear: toNear(fc.deposit || '0') }); }
    if (a.Transfer) transfers.push({ to: tx.receiver_id, near: toNear(a.Transfer.deposit || '0') });
  }
  const events = [], logs = [], inflows = [];
  let failed = false;
  for (const r of t.receipts) {
    // NEAR moved by a receipt: predecessor -> receiver (gas refunds come from "system" and are skipped)
    const rc = r.receipt;
    if (rc && rc.predecessor_id && rc.predecessor_id !== 'system') for (const a of rc.receipt?.Action?.actions || []) if (a.Transfer) inflows.push({ from: rc.predecessor_id, to: rc.receiver_id, near: toNear(a.Transfer.deposit || '0') });
    const o = r.execution_outcome.outcome;
    if (o.status && o.status.Failure) failed = true;
    for (const l of o.logs) {
      if (l.startsWith('EVENT_JSON:')) { try { events.push({ executor: o.executor_id, ...JSON.parse(l.slice(11)) }); } catch {} }
      else logs.push({ executor: o.executor_id, text: l });
    }
  }
  return { hash: tx.hash, signer: tx.signer_id, receiver: tx.receiver_id, ts: Number(String(t.execution_outcome.block_timestamp).slice(0, 13)), height: t.execution_outcome.block_height, calls, transfers, inflows, events, logs, failed };
}

/** New tx hashes of an account since a block height, oldest first (used to follow launchpad contracts). */
export async function newTxHashes(accountId, sinceHeight, maxPages = 10) {
  const hashes = [];
  let resume, head = sinceHeight;
  for (let p = 0; p < maxPages; p++) {
    const j = await txIndexer('/v0/account', { account_id: accountId, resume_token: resume });
    const rows = j.account_txs || [];
    for (const r of rows) { head = Math.max(head, r.tx_block_height); if (r.tx_block_height > sinceHeight) hashes.push(r.transaction_hash); }
    if (!j.resume_token || !rows.length || rows[rows.length - 1].tx_block_height <= sinceHeight || sinceHeight === 0) break;
    resume = j.resume_token;
  }
  return { hashes: [...new Set(hashes)].reverse(), head };
}
