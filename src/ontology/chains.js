// Accounts on other chains (WP-14): ids like `eth:0xabc…`, so an address a NEAR case sent money to is an entity Safe Near remembers.
// `<chain>:<address>` with the chain keys of oneclick.js (eth, btc, sol, …); EVM addresses are lower-cased, others unchanged.
import { CHAIN } from '../incident/oneclick.js';

const EVM = new Set(['eth', 'base', 'arb', 'bsc', 'pol', 'gnosis', 'bera', 'avax', 'op', 'monad']);
const BY_NAME = new Map(Object.entries(CHAIN).map(([k, v]) => [v.toLowerCase(), k]));
/** The chain key for a key ("eth") or a display name ("Ethereum"), or null. */
export const chainKey = (c) => { const s = String(c || '').toLowerCase(); return CHAIN[s] ? s : BY_NAME.get(s) || null; };
/** `eth:0xabc…`, or null when the chain is unknown or the address empty. */
export function chainId(chain, address) {
  const k = chainKey(chain), a = String(address || '').trim();
  return k && a ? `${k}:${EVM.has(k) ? a.toLowerCase() : a}` : null;
}
/** { chain: 'eth', name: 'Ethereum', address } for a chain id, or null (a NEAR account is never one). */
export function parseChainId(id) {
  const m = /^([a-z]{2,8}):(\S{6,120})$/.exec(String(id || ''));
  return m && CHAIN[m[1]] ? { chain: m[1], name: CHAIN[m[1]], address: m[2] } : null;
}
/** A pasted chain address: an explicit `eth:0x…` / `btc:…` / `sol:…`, or a bare 0x + 40 hex (Ethereum-style) or a bech32 / legacy Bitcoin address. Returns the id or null. */
export function detectChainAddress(text) {
  const s = String(text || '').trim();
  if (parseChainId(s)) return chainId(s.split(':')[0], s.slice(s.indexOf(':') + 1));
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return chainId('eth', s);
  if (/^(bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(s)) return chainId('btc', s);
  return null; // a bare Solana address looks like a NEAR transaction hash: it needs the `sol:` prefix
}
/** The `sent_to` and `role_in` facts of one case's exits to other chains. */
export function chainFacts(inc) {
  const out = [], seen = new Set();
  for (const e of inc.trail?.exits || []) {
    const id = e.recipient && e.chain && e.chain !== 'NEAR' ? chainId(e.chain, e.recipient) : null;
    if (!id) continue;
    const key = `${id}|${e.tx}`; if (seen.has(key)) continue; seen.add(key);
    const source = inc.confirmed_by?.source ? 'public_report' : 'trace', valid_to = inc.status === 'cleared' ? (inc.cleared?.ts || inc.updated_ts || Date.now()) : null;
    const ev = `swapped ${e.amount ?? ''} ${e.symbol ?? ''} to ${e.asset || 'an asset'} on ${e.chain}${e.tx ? ` (tx ${e.tx})` : ''}`.replace(/\s+/g, ' ');
    out.push({ subject: inc._id, predicate: 'sent_to', object: id, source, confidence: 0.9, evidence: ev, amount_usd: Math.round(e.usd || 0), status: inc.status, valid_to },
      { subject: id, predicate: 'role_in', object: inc._id, role: 'cash_out_address', source, confidence: 0.9, evidence: ev, status: inc.status, kind: inc.kind, valid_to });
  }
  return out;
}
