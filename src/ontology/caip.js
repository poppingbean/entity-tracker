// Canonical, chain-agnostic ids for the ontology (docs/ontology-layer-research.md, Stage 0).
// Inside Safe Near an account is `alice.near` (NEAR) or `<chain>:<address>` (`eth:0x…`, `xrp:r…`). Outside, accounts are named with CAIP-10
// (`near:mainnet:alice.near`, `eip155:1:0x…`), and as a DID with `did:pkh:` + the CAIP-10 id, so any other tool can join on them.
// Only chains whose CAIP-2 reference was checked are mapped; any other chain answers null rather than a guess.
import { parseChainId, chainId } from './chains.js';

// chain key (src/incident/oneclick.js CHAIN) -> [CAIP-2 namespace, reference]
//   eip155: the EVM chain id.   bip122: the first 32 characters of the genesis block hash.   solana: the first 32 characters of the genesis hash.
//   xrpl: the network id (0 = mainnet; the profile is still a draft).   tron: from the CASA tron profile (0x2b6653dc = mainnet).
export const CAIP2 = {
  eth: ['eip155', '1'], op: ['eip155', '10'], bsc: ['eip155', '56'], gnosis: ['eip155', '100'], pol: ['eip155', '137'], base: ['eip155', '8453'], arb: ['eip155', '42161'], avax: ['eip155', '43114'],
  btc: ['bip122', '000000000019d6689c085ae165831e93'], sol: ['solana', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'], xrp: ['xrpl', '0'], tron: ['tron', '0x2b6653dc'],
};
const NEAR_ACCOUNT = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** The id Safe Near stores for what a caller typed: a NEAR account is lower case; a chain address keeps its case (XRP, Tron and Bitcoin addresses are case-sensitive), an EVM address is lower case. */
export function normalizeId(raw) {
  const s = String(raw ?? '').trim();
  const c = parseChainId(s);
  return c ? chainId(c.chain, c.address) || s.toLowerCase() : s.toLowerCase();
}

/** The CAIP-10 id of an account, or null when it is not a NEAR account or a chain Safe Near has a checked mapping for. */
export function caip10(id) {
  const s = String(id || '');
  const c = parseChainId(s);
  if (c) { const m = CAIP2[c.chain]; return m ? `${m[0]}:${m[1]}:${c.address}` : null; }
  return NEAR_ACCOUNT.test(s) ? `near:mainnet:${s}` : null;
}
/** did:pkh of the same account (a DID method defined over CAIP-10). */
export const didPkh = (id) => { const c = caip10(id); return c ? `did:pkh:${c}` : null; };

/**
 * How far the id reaches. `eth:` is an address as seen on Ethereum mainnet: for an ordinary wallet (EOA) it is the same key on every EVM chain, for a contract it is
 * not. Safe Near's own EVM ids come from public hack lists and swap addresses, which are wallets; a contract on another EVM chain must use that chain's key (`base:0x…`).
 */
export function idScope(id) {
  const c = parseChainId(String(id || ''));
  if (!c) return 'near';
  return c.chain === 'eth' ? 'evm_any_chain_if_eoa' : CAIP2[c.chain]?.[0] === 'eip155' ? 'one_evm_chain' : 'one_chain';
}

/** An IRI for an account: its did:pkh when it has a CAIP-10 id, otherwise a urn that always works. */
export const accountIri = (id) => didPkh(id) || `urn:safenear:account:${encodeURIComponent(String(id))}`;
