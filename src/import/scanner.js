// One-off import of the live scanner's data (its data/state.json) into this tracker's MongoDB database.
//   node src/cli.js import-scanner [path/to/state.json] [--dry]
// Safe to re-run: documents are keyed by natural ids and existing tracker data is never overwritten.
//
//   launches          -> tokens          (new ones are queued, so the tracker reads their trades and early buyers)
//   evaluations       -> scans           (kind first / followup, source "scanner": gates, score, AI verdicts, features)
//   creator blacklist -> blacklist       (the scanner's dev-rug blacklist now feeds this tracker's creator gate)
//   code-hash counts  -> templates       (merged with max())
//   REAL positions    -> scanner_positions / scanner_spend   (kept apart: they are live trades, NOT simulated ones,
//                                                            so they never touch the paper wallet)
import fs from 'node:fs';
import { col } from '../db.js';
import { config } from '../config.js';
import { isKnownQuote } from '../near/quotes.js';

const MIN = 60e3;

export async function importScanner(file, { dry = false } = {}) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = Date.now();
  const stat = { tokens: { seen: 0, new: 0, existing: 0, skippedNoPool: 0 }, scans: 0, followups: 0, blacklist: 0, templates: 0, positions: 0, spend: 0 };
  const tokenOps = [], scanOps = [], posOps = [], spendOps = [];

  for (const t of Object.values(s.tokens || {})) {
    if (!t.token || !t.liveTs || !t.pool?.poolId) { stat.tokens.skippedNoPool++; continue; } // raises that never launched
    stat.tokens.seen++;
    const e = t.evaluation;
    const ageMin = (now - t.liveTs) / MIN;
    const doc = {
      launchpad: t.launchpad, creator: t.creator || null, symbol: t.symbol || null, name: t.name || null, meme_id: null, pool: t.pool,
      dev_buy_near: t.devBuyNear ?? null, dev_buy_quote_raw: t.devBuyQuoteRaw ?? null, lp: t.lp ?? null, tax: t.tax ?? null, liquidity_near: t.liquidityNear ?? null,
      live_ts: t.liveTs, live_height: null, live_tx: t.liveTx || null, status: isKnownQuote(t.pool.quote) ? 'new' : 'skipped_quote', sync_height: null, sync_ts: null, trades_n: 0,
      created_ts: t.createdTs || t.firstSeen || now, next_process_ts: 0, imported_from: 'scanner',
      // an old / already evaluated launch must not be bought by the simulated wallet
      ...(e || ageMin > config.scan.maxTokenAgeMinutes ? { scan_done: true, scan: e ? { ts: t.evaluatedTs, score: e.score, pass: !(e.failed || []).length && (e.score ?? 0) >= config.rules.minScore, decision: `imported from the scanner (${e.action || t.status})`, bought: /bought|manual_held/.test(t.status || ''), failed: e.failed || [], imported: true } : { ts: now, imported: true, stale: true, decision: 'imported (too old to scan)' } } : {}),
    };
    const scanner = { status: t.status, score: e?.score ?? null, failed: e?.failed ?? null, ai_action: e?.ai?.action ?? e?.ai?.decision ?? null, ai_confidence: e?.ai?.confidence ?? null, ai_risk: e?.ai?.risk_level ?? null, evaluated_ts: t.evaluatedTs ?? null, imported_ts: now };
    tokenOps.push({ updateOne: { filter: { _id: t.token }, update: { $setOnInsert: doc, $set: { scanner } }, upsert: true } });

    const mkAi = (a) => (a ? { action: a.action || a.decision, confidence: a.confidence, risk_level: a.risk_level, quality_score: a.quality_score ?? null, reasons: a.reasons || [], red_flags: a.red_flags || [], model: `${a.model || 'claude'} (scanner)` } : null);
    const trade = t.trade?.t1 ? { status: t.trade.t1.status, reason: t.trade.t1.reason || null, near: t.trade.t1.plan?.near ?? null } : null;
    if (e && t.evaluatedTs && e.score !== undefined) {
      const id = `${t.token}|${t.evaluatedTs}|first`;
      scanOps.push({ replaceOne: { filter: { _id: id }, upsert: true, replacement: { _id: id, id, token: t.token, symbol: t.symbol || null, launchpad: t.launchpad, ts: t.evaluatedTs, kind: 'first', minutes: Math.round((t.evaluatedTs - t.liveTs) / MIN),
        score: e.score, pass: !(e.failed || []).length && (e.score ?? 0) >= config.rules.minScore, failed: (e.failed || []).map((g) => (typeof g === 'string' ? { id: g, why: '' } : g)), features: e.features || null, ai: mkAi(e.ai),
        decision: `scanner: ${e.action || e.ai?.decision || t.status}`, action: e.action || null, trade, source: 'scanner' } } });
      stat.scans++;
    }
    for (const r of Object.values(t.rereviews || {})) {
      if (!r.ts || r.status === 'running' || r.status === 'missed') continue;
      const id = `${t.token}|${r.ts}|followup`;
      scanOps.push({ replaceOne: { filter: { _id: id }, upsert: true, replacement: { _id: id, id, token: t.token, symbol: t.symbol || null, launchpad: t.launchpad, ts: r.ts, kind: 'followup', minutes: r.minutes, score: r.score, pass: !(r.failed || []).length,
        failed: (r.failed || []).map((g) => ({ id: g, why: '' })), features: null, ai: mkAi(r.ai), decision: `scanner follow-up: ${r.action || r.note || ''}`, action: r.action || null, trade: r.trade || null, source: 'scanner' } } });
      stat.followups++;
    }
  }

  for (const p of s.positions || []) {
    const id = `${p.token}|${p.ts}|${p.paper ? 1 : 0}`;
    posOps.push({ replaceOne: { filter: { _id: id }, upsert: true, replacement: { _id: id, ...p, imported_ts: now, source: 'scanner' } } }); stat.positions++;
  }
  (s.spend || []).forEach((x, i) => { const id = `${x.ts}|${x.token || ''}|${x.tranche ?? ''}|${x.near ?? ''}|${x.hash || i}`; spendOps.push({ replaceOne: { filter: { _id: id }, upsert: true, replacement: { _id: id, ...x, source: 'scanner' } } }); stat.spend++; });
  const bl = Object.entries(s.blacklist || {});
  stat.blacklist = bl.length;
  stat.templates = Object.values(s.templates || {}).reduce((n, h) => n + Object.keys(h).length, 0);

  if (dry) { const have = new Set((await col('tokens').find({ _id: { $in: tokenOps.map((o) => o.updateOne.filter._id) } }, { projection: { _id: 1 } }).toArray()).map((x) => x._id)); stat.tokens.existing = have.size; stat.tokens.new = stat.tokens.seen - have.size; return { dry: true, ...stat }; }

  const before = await col('tokens').estimatedDocumentCount();
  const batches = async (coll, ops) => { for (let i = 0; i < ops.length; i += 500) await col(coll).bulkWrite(ops.slice(i, i + 500), { ordered: false }); };
  await batches('tokens', tokenOps); await batches('scans', scanOps); await batches('scanner_positions', posOps); await batches('scanner_spend', spendOps);
  for (const [account, v] of bl) await col('blacklist').updateOne({ _id: account }, { $setOnInsert: { _id: account, ts: v.ts, token: v.token || null, symbol: v.symbol || null, reason: v.reason || null, source: 'scanner' } }, { upsert: true });
  for (const [launchpad, hashes] of Object.entries(s.templates || {})) if (Object.keys(hashes).length) await col('templates').updateOne({ _id: launchpad }, { $max: Object.fromEntries(Object.entries(hashes).map(([h, n]) => [`counts.${h}`, n])) }, { upsert: true });
  const after = await col('tokens').estimatedDocumentCount();
  stat.tokens.new = Math.max(0, after - before); stat.tokens.existing = stat.tokens.seen - stat.tokens.new;
  return { dry: false, ...stat };
}
