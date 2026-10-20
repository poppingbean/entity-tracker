// Contract audit scoring (ported from the TrustFlow backend's contractAuditService / auditBehaviour for NEAR).
// A flat checklist of {key, label, labelVi, category, weight, hit, detail, detailVi}: `weight` is what a hit adds to the risk score
// (negative for trust-building signals); a check that did not hit still appears with hit:false so the UI shows it as a passed check.
// Risk: 0-19 low, 20-44 medium, 45-69 high, 70-100 critical. Trust is separate (not 100 - risk): a brand-new token can have a low
// risk score simply because nothing bad has happened yet, while still having no track record.

/** Factor details in both UI languages: a plain string is used for both, { en, vi } is split. */
export function bilingualDetail(detail) {
  if (detail && typeof detail === 'object') return { detail: detail.en ?? null, detailVi: detail.vi ?? detail.en ?? null };
  return { detail: detail || null, detailVi: detail || null };
}

export function makeCheck(factors) {
  return (key, label, labelVi, category, weight, hit, detail) => factors.push({ key, label, labelVi, category, weight, hit: !!hit, ...bilingualDetail(detail) });
}

/**
 * Chain-independent scoring of recent sell behaviour. beh = { sellOk, sellFail, buys, blockedSellers, successfulSellers, topFailReason }.
 * Failed sells alone are not a honeypot (slippage limits, stale balances, bot retries); only flag one when holders essentially cannot
 * sell: several distinct wallets never succeed AND successful sells are rare overall.
 */
export function sellBehaviourFactors(beh) {
  const factors = [], check = makeCheck(factors);
  const attempts = beh.sellOk + beh.sellFail;
  const honeypotSells = (beh.blockedSellers ?? 0) >= 3 && beh.sellFail >= 3 && beh.sellOk <= Math.max(1, Math.floor(attempts * 0.1));
  const reason = beh.topFailReason ? ` - "${beh.topFailReason}"` : '';
  const ok = beh.successfulSellers ?? 0, blocked = beh.blockedSellers ?? 0;
  const failDetail = attempts ? { en: `${beh.sellFail}/${attempts} sells failed · ${ok} wallets sold successfully, ${blocked} could not sell${reason}`, vi: `${beh.sellFail}/${attempts} lệnh bán thất bại · ${ok} ví bán thành công, ${blocked} ví chưa bán được${reason}` } : null;
  const okDetail = attempts ? { en: `${beh.sellOk}/${attempts} sells succeeded`, vi: `${beh.sellOk}/${attempts} lệnh bán thành công` } : null;
  check('sellsFailing', 'Honeypot: holders cannot sell (almost every sell attempt fails, across many wallets)', 'Honeypot: người nắm giữ không bán được (gần như mọi lệnh bán đều thất bại, trên nhiều ví)', 'critical', 50, honeypotSells, honeypotSells ? failDetail : okDetail);
  check('sellFailuresObserved', 'Some sell attempts failed, but other holders sell successfully (usually slippage limits, stale balances, bot retries), not a honeypot', 'Một số lệnh bán thất bại nhưng người khác vẫn bán thành công (thường do trượt giá, số dư trễ, bot thử lại), không phải honeypot', 'trading', 0, !honeypotSells && beh.sellFail >= 3, failDetail);
  check('noSuccessfulSells', 'Many buys but no successful sells in recent activity', 'Nhiều lệnh mua nhưng không có lệnh bán thành công gần đây', 'critical', 25, beh.buys >= 20 && beh.sellOk === 0, { en: `${beh.buys} buys / ${beh.sellOk} successful sells`, vi: `${beh.buys} mua / ${beh.sellOk} bán thành công` });
  return factors;
}

/**
 * Access keys are the central concept on NEAR: a FullAccess key lets whoever holds it redeploy the code or drain the contract, so its
 * presence (or absence) is the dominant signal. Immutability only counts as trust when the immutable code has no backdoor.
 */
export function nearFactors(accessKeys, { backdoor = false } = {}) {
  const factors = [], check = makeCheck(factors);
  const keysDetail = (n) => (n > 0 ? { en: `${n} ${n === 1 ? 'key' : 'keys'}`, vi: `${n} key` } : null);
  const fullAccessKeys = accessKeys.filter((k) => k.access_key?.permission === 'FullAccess');
  const unlimitedFnKeys = accessKeys.filter((k) => k.access_key?.permission !== 'FullAccess').filter((k) => { const p = k.access_key?.permission?.FunctionCall; return p && (p.allowance === null || p.allowance === undefined); });
  check('fullAccessKeyExists', 'Deployer/owner still holds a full-access key (can redeploy or drain the contract)', 'Người triển khai/chủ sở hữu vẫn giữ full-access key (có thể redeploy hoặc rút hết tài sản)', 'critical', 35, fullAccessKeys.length > 0, keysDetail(fullAccessKeys.length));
  check('multipleFullAccessKeys', 'More than one full-access key found (larger attack surface)', 'Có nhiều hơn 1 full-access key (bề mặt tấn công lớn hơn)', 'ownership', 10, fullAccessKeys.length > 1, fullAccessKeys.length > 1 ? keysDetail(fullAccessKeys.length) : null);
  check('unlimitedFunctionCallAllowance', 'A function-call access key has an unlimited gas allowance', 'Có function-call access key với allowance không giới hạn', 'ownership', 8, unlimitedFnKeys.length > 0, keysDetail(unlimitedFnKeys.length));
  check('noFullAccessKey', 'No full-access key remains: contract is locked/immutable (and no backdoor found in its code)', 'Không còn full-access key: contract đã bị khoá/bất biến (và không phát hiện backdoor trong mã)', 'trust', -25, fullAccessKeys.length === 0 && !backdoor);
  return factors;
}

/** Buy/sell tax read from the contract's own get_tax view (bps). */
export function nearTaxFactors(tax) {
  if (!tax) return [];
  const buy = Number(tax.buy_bps || 0) / 100, sell = Number(tax.sell_bps || 0) / 100, max = Math.max(buy, sell);
  const pairs = Array.isArray(tax.pairs) ? tax.pairs.length : 0;
  const detail = {
    en: `buy ${buy.toFixed(1)}% · sell ${sell.toFixed(1)}% on ${pairs} DEX ${pairs === 1 ? 'pair' : 'pairs'}${tax.admin ? ` · admin ${tax.admin}` : ''} - sells need slippage above ${sell.toFixed(1)}%, otherwise they fail`,
    vi: `mua ${buy.toFixed(1)}% · bán ${sell.toFixed(1)}% trên ${pairs} cặp DEX${tax.admin ? ` · admin ${tax.admin}` : ''} - lệnh bán cần slippage trên ${sell.toFixed(1)}%, nếu không sẽ thất bại`,
  };
  const out = [];
  const check = (key, label, labelVi, weight, hit) => out.push({ key, label, labelVi, category: 'trading', weight, hit: !!hit, ...bilingualDetail(hit ? detail : null) });
  check('taxExtreme', 'Buy/sell tax is 30% or higher', 'Thuế mua/bán từ 30% trở lên', 25, max >= 30);
  check('taxHigh', 'Buy/sell tax is 10-30%', 'Thuế mua/bán 10-30%', 12, max >= 10 && max < 30);
  check('taxLow', 'Token charges a buy/sell tax on DEX trades', 'Token thu thuế mua/bán khi giao dịch trên DEX', 5, max > 0 && max < 10);
  return out;
}

export function scoreFromFactors(factors) {
  const raw = factors.filter((f) => f.hit).reduce((s, f) => s + f.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, level: score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low', factors };
}

// A confirmed malicious signal outweighs any number of passed hygiene checks.
export const CONFIRMED_MALICIOUS = new Set(['honeypot', 'cannotSellAll', 'cannotBuy', 'nonTransferable', 'defaultFrozen', 'fakeStorageMethod', 'sellsFailing', 'privilegedCallsOnHolders']);
// A locked (keyless) contract is only reassuring if its code has no backdoor.
const BACKDOOR_KEYS = new Set(['fakeStorageMethod', 'sellsFailing', 'privilegedCallsOnHolders']);
export const hasBackdoor = (factors) => factors.some((f) => f.hit && BACKDOOR_KEYS.has(f.key));

/** Trust = "hygiene" (up to 70: share of non-trust risk checks that came back clean) + external validation (up to 30). */
export function trustScoreFromFactors(factors) {
  const riskChecks = factors.filter((f) => f.category !== 'trust' && f.weight > 0);
  const passed = riskChecks.filter((f) => !f.hit).length;
  const hygiene = riskChecks.length ? (passed / riskChecks.length) * 70 : 0;
  const trustFactors = factors.filter((f) => f.category === 'trust');
  const trustMax = trustFactors.reduce((s, f) => s + Math.abs(f.weight), 0);
  const trustRaw = trustFactors.filter((f) => f.hit).reduce((s, f) => s + Math.abs(f.weight), 0);
  const signal = trustMax > 0 ? (trustRaw / trustMax) * 30 : 0;
  const critical = factors.some((f) => f.hit && CONFIRMED_MALICIOUS.has(f.key));
  const score = Math.min(critical ? 10 : 100, Math.max(0, Math.round(hygiene + signal)));
  return { score, level: score >= 70 ? 'high' : score >= 40 ? 'medium' : score >= 15 ? 'low' : 'unrated', factors: trustFactors, hygienePct: riskChecks.length ? Math.round((passed / riskChecks.length) * 100) : null };
}
