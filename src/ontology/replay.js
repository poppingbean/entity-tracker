// Replay every stored case with the old rules and with the ontology, in one process, and compare what an operator would see: status,
// kind, attacker, target, the case's accounts, where the money came from and where it went. Read-only (traceIncident writes nothing).
//   node src/cli.js ontology-replay [--json] [--only <id prefix>]
import { col } from '../db.js';
import { traceIncident } from '../incident/trace.js';
import { clearIdentifyCache } from '../incident/origin.js';
import { setReads } from './sync.js';
import { config } from '../config.js';

const brief = (inc) => ({
  status: inc.status, kind: inc.kind || null, attacker: inc.attacker?.account || null, target: inc.target?.account || null,
  accounts: (inc.accounts || []).map((a) => `${a.role}:${a.account}`).sort(),
  sources: (inc.sources || []).map((s) => `${s.account}:${s.kind}`).sort(),
  exits: (inc.trail?.exits || []).map((e) => e.kind).sort(),
  stolen_usd: Math.round(inc.stolen_usd || 0),
});

/** What differs between two briefs (empty = same). Amounts within 2 % count as equal (prices move between the two runs). */
export function diff(a, b) {
  const out = [];
  for (const k of ['status', 'kind', 'attacker', 'target']) if (a[k] !== b[k]) out.push(`${k}: ${a[k]} → ${b[k]}`);
  for (const k of ['accounts', 'sources', 'exits']) {
    const A = new Set(a[k]), B = new Set(b[k]);
    const gone = [...A].filter((x) => !B.has(x)), added = [...B].filter((x) => !A.has(x));
    if (gone.length || added.length) out.push(`${k}: ${gone.length ? `−${gone.slice(0, 4).join(', ')}` : ''}${added.length ? ` +${added.slice(0, 4).join(', ')}` : ''}`.trim());
  }
  const m = Math.max(a.stolen_usd, b.stolen_usd);
  if (m > 0 && Math.abs(a.stolen_usd - b.stolen_usd) / m > 0.02) out.push(`stolen_usd: ${a.stolen_usd} → ${b.stolen_usd}`);
  return out;
}

async function run(input, read) {
  setReads(read);
  clearIdentifyCache();
  try { return brief(await traceIncident(input)); } catch (e) { return { error: e.message }; }
}

export async function replay({ only = null, log = () => {} } = {}) {
  const now = config.ontology.read;
  const cases = await col('incidents').find(only ? { _id: new RegExp('^' + only) } : {}, { projection: { input: 1, status: 1, kind: 1 } }).sort({ first_seen_ts: 1 }).toArray();
  const rows = [];
  for (const c of cases) {
    if (!c.input) { rows.push({ id: c._id, stored: c.status, skipped: 'no input' }); continue; }
    const t0 = Date.now();
    const before = await run(c.input, 'none');
    const after = await run(c.input, now);
    const d = before.error || after.error ? [`error: ${before.error || after.error}`] : diff(before, after);
    rows.push({ id: c._id, stored: `${c.status} ${c.kind || ''}`.trim(), old: before.status ? `${before.status} ${before.kind || ''}`.trim() : null, new: after.status ? `${after.status} ${after.kind || ''}`.trim() : null, changes: d, s: Math.round((Date.now() - t0) / 1000) });
    log(`${c._id.slice(0, 24)} ${d.length ? 'CHANGED ' + d.join('; ') : 'same'} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  setReads(now);
  const changed = rows.filter((r) => r.changes?.length);
  const statusChanged = changed.filter((r) => r.changes.some((x) => /^(status|kind):/.test(x)));
  return { cases: rows.length, same: rows.length - changed.length - rows.filter((r) => r.skipped).length, changed: changed.length, status_or_kind_changed: statusChanged.length, rows };
}

export function replayText(r) {
  const L = [`Stored-case replay: ${r.cases} cases, ${r.same} unchanged, ${r.changed} changed (${r.status_or_kind_changed} in status or kind)`, '', '| case | stored | old rules | ontology | differences |', '|---|---|---|---|---|'];
  for (const x of r.rows) L.push(`| \`${x.id.slice(0, 28)}…\` | ${x.stored} | ${x.old ?? x.skipped ?? '–'} | ${x.new ?? '–'} | ${x.changes?.length ? x.changes.join('<br>') : 'same'} |`);
  return L.join('\n');
}
