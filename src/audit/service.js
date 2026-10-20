// Audit a NEAR contract / token: access keys, code (WASM exports, owner guards), buy/sell tax and recent sell behaviour, scored into
// a risk and a trust score with a full checklist. Results are cached in MongoDB (`audits`).
import { col } from '../db.js';
import { viewAccount, viewAccessKeyList, viewCode, viewFunction, viewStatePrefix, EMPTY_CODE_HASH } from './rpc.js';
import { staticAnalysis, behaviourAnalysis, codeFactors } from './analysis.js';
import { nearFactors, nearTaxFactors, scoreFromFactors, trustScoreFromFactors, hasBackdoor, CONFIRMED_MALICIOUS } from './factors.js';

export const CACHE_TTL_MS = 60 * 60 * 1000; // risk data rarely changes faster than this
// NEAR's account id grammar (dot-separated lowercase / digit / hyphen labels; 64-hex implicit accounts match it too).
const NEAR_ADDR_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const validNearAddress = (a) => typeof a === 'string' && a.length >= 2 && a.length <= 64 && NEAR_ADDR_RE.test(a);

const inflight = new Map(); // one audit per address at a time

export async function getCachedAudit(address) { return col('audits').findOne({ _id: address }); }

/** Audit one NEAR account. `force` skips the cache. Never throws for "account not found": that is an answer (notFound). */
export function auditNearContract(address, { force = false } = {}) {
  if (inflight.has(address)) return inflight.get(address);
  const p = run(address, force).finally(() => inflight.delete(address));
  inflight.set(address, p);
  return p;
}

async function run(address, force) {
  if (!validNearAddress(address)) throw new Error('invalid NEAR account id');
  if (!force) { const c = await getCachedAudit(address); if (c && Date.now() - c.fetchedAt < CACHE_TTL_MS) return c; }

  const account = await viewAccount(address);
  // A Global Contract account keeps its own code_hash empty and references shared code through global_contract_hash: still a live contract.
  const notFound = !account || (account.code_hash === EMPTY_CODE_HASH && !account.global_contract_hash && !account.global_contract_account_id);
  const accessKeys = notFound ? [] : await viewAccessKeyList(address);
  let meta = null, stat = null, beh = null, tax = null;
  if (!notFound) {
    meta = await viewFunction(address, 'ft_metadata');
    // Launchpad "token-tax" contracts expose their buy/sell tax via get_tax. The tax is taken inside ft_transfer, so DEX quotes ignore it and
    // swaps with tight slippage fail: it looks like a honeypot to traders even though selling works.
    tax = (await viewFunction(address, 'get_tax'))?.tax || null;
    const isTok = Boolean(meta && (meta.symbol || meta.name));
    const code = await viewCode(address).catch(() => null); // global-contract accounts have no code of their own: code checks are skipped
    stat = code ? staticAnalysis(code, isTok) : null;
    if (isTok) {
      const state = await viewStatePrefix(address, 'STATE');
      beh = await behaviourAnalysis(address, state).catch(() => null);
    }
  }
  const isToken = Boolean(meta && (meta.symbol || meta.name));
  const cFactors = notFound ? [] : codeFactors(stat, beh);
  const factors = notFound ? null : [...nearFactors(accessKeys, { backdoor: hasBackdoor(cFactors) }), ...cFactors, ...nearTaxFactors(tax)];
  const doc = {
    _id: address, chain: 'near', address, kind: isToken ? 'token' : 'contract', tokenName: isToken ? meta.name || null : null, tokenSymbol: isToken ? meta.symbol || null : null,
    risk: factors ? scoreFromFactors(factors) : { score: null, level: null, factors: [] }, trust: factors ? trustScoreFromFactors(factors) : { score: null, level: null, factors: [] },
    raw: notFound ? null : { account, accessKeys, tax, code: stat && { exports: stat.exports, fakeStorage: stat.fakeStorage, nonStandard: stat.nonStandard, privilegedNames: stat.privilegedNames }, behaviour: beh },
    notFound, fetchedAt: Date.now(),
  };
  await col('audits').replaceOne({ _id: address }, doc, { upsert: true });
  return doc;
}

/** The few numbers and findings the gates and the AI analyst need (not the whole checklist). */
export function summarizeAudit(doc) {
  if (!doc || doc.notFound || doc.risk?.score == null) return { available: false, reason: doc?.notFound ? 'account has no contract' : 'no audit' };
  const hits = doc.risk.factors.filter((f) => f.hit && f.weight > 0).sort((a, b) => b.weight - a.weight);
  const code = doc.raw?.code, beh = doc.raw?.behaviour;
  return {
    available: true, risk_score: doc.risk.score, risk_level: doc.risk.level, trust_score: doc.trust.score, trust_level: doc.trust.level, hygiene_pct: doc.trust.hygienePct ?? null,
    confirmed_malicious: hits.filter((f) => CONFIRMED_MALICIOUS.has(f.key)).map((f) => ({ key: f.key, detail: f.detail })),
    findings: hits.slice(0, 8).map((f) => ({ key: f.key, weight: f.weight, detail: f.detail })),
    full_access_keys: doc.raw?.accessKeys?.filter((k) => k.access_key?.permission === 'FullAccess').length ?? null,
    privileged_methods: code?.privilegedNames?.slice(0, 8) || [], non_standard_methods: code?.nonStandard?.slice(0, 8) || [],
    sells: beh ? { ok: beh.sellOk, failed: beh.sellFail, blocked_wallets: beh.blockedSellers, buys: beh.buys } : null, audited_ts: doc.fetchedAt,
  };
}
