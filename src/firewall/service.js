// Transaction firewall: decode -> context -> rules -> (optional) AI explanation. Called by the public API (POST /api/v1/tx/check) that
// wallets and dApps use right before asking the user to sign. Only counters are kept (per verdict and finding code), never addresses.
import { col } from '../db.js';
import { decodeRequest } from './decode.js';
import { buildContext, accountReputation } from './context.js';
import { checkTransactions } from './rules.js';
import { explainCheck } from './explain.js';

export const FIREWALL_VERSION = '1.0';

/** Check what a wallet is about to sign. Throws on an unreadable request (the API answers 400). */
export async function checkRequest(body) {
  const t0 = Date.now();
  const txs = decodeRequest(body || {});
  const { ctx, complete, accounts_checked } = await buildContext(txs);
  const result = checkTransactions(txs, ctx);
  const explanation = body.explain ? await explainCheck(result, ctx) : undefined;
  const out = { version: FIREWALL_VERSION, ...result, ...(explanation !== undefined ? { explanation } : {}), context: { complete, accounts_checked }, checked_ts: Date.now(), took_ms: Date.now() - t0 };
  count(result).catch(() => {});
  return out;
}

export { accountReputation };

async function count(r) {
  const inc = { total: 1, [`verdict.${r.verdict}`]: 1 };
  for (const f of r.findings) if (f.severity !== 'info') inc[`codes.${f.code}`] = 1;
  await col('meta').updateOne({ _id: 'firewall:stats' }, { $inc: Object.fromEntries(Object.entries(inc).map(([k, v]) => [`value.${k}`, v])), $set: { ts: Date.now() } }, { upsert: true });
}

/** Report an account by hand (a drainer, a phishing contract): every check that touches it carries the flag. */
export async function flagAccount(id, severity, reason, detail = '') {
  if (!['critical', 'high', 'medium'].includes(severity)) throw new Error('severity: critical | high | medium');
  await col('firewall_flags').replaceOne({ _id: id }, { _id: id, severity, reason: String(reason).slice(0, 120), detail: String(detail).slice(0, 400), ts: Date.now() }, { upsert: true });
}
export const unflagAccount = (id) => col('firewall_flags').deleteOne({ _id: id });
