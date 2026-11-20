// Screening of NEAR Intents swaps against the addresses of known hacks on other chains (docs/external-cases.md).
// Every time Safe Near resolves a 1Click swap (the tracer's exits, the live follow, the money watch), the swap's addresses on the other chains (where the money
// came from: the refund address; where it goes: the recipient) are looked up in the ontology. When one is an address a public hack report named
// (FBI lists, Bitget's published addresses ...), an alert is raised once for that swap. It sees only the swaps that are resolved: it is not a watch of all
// of NEAR Intents.
import { assetChain } from './oneclick.js';
import { chainKey, chainId } from '../ontology/chains.js';

/** The other-chain addresses of a 1Click swap: [{ id: 'eth:0x…', side: 'recipient' | 'origin' }]. NEAR addresses and unknown chains are left out. */
export function swapAddresses(sw) {
  const out = [], add = (asset, address, side) => {
    if (!address || !asset) return;
    const k = chainKey(assetChain(asset).chain), id = k ? chainId(k, address) : null;
    if (id) out.push({ id, side });
  };
  add(sw?.destination_asset, sw?.recipient, 'recipient');
  add(sw?.origin_asset, sw?.refund_to, 'origin');
  return out;
}

/** The alert for a swap when one of its addresses is on a hack's list, or null. `known(id)` → { flagged, roles } from the ontology. */
export function listedAlert(sw, known) {
  const hits = swapAddresses(sw).map((a) => ({ ...a, k: known(a.id) })).filter((a) => a.k?.flagged && (a.k.roles || []).some((r) => String(r.case).startsWith('ext:')));
  if (!hits.length) return null;
  const h = hits[0], role = h.k.roles.find((r) => String(r.case).startsWith('ext:')), caseName = String(role.case).replace(/^ext:/, '');
  const usd = sw.amount_in_usd ? ` (about $${Math.round(sw.amount_in_usd).toLocaleString('en-US')})` : '';
  const what = h.side === 'recipient' ? `a NEAR Intents swap${usd} pays out to ${h.id}` : `a NEAR Intents swap${usd} was paid in from ${h.id}`;
  return {
    key: `listed:${sw.deposit_address}`, ids: hits.map((x) => x.id), case: role.case, status: sw.status || null,
    title: `Address from the ${caseName} hack used NEAR Intents: ${h.id.length > 30 ? h.id.slice(0, 20) + '…' + h.id.slice(-6) : h.id}`,
    text: `${what}; this address is named in the ${caseName} hack (${h.k.flagged.reason || role.role}). Deposit address ${sw.deposit_address}, swap ${sw.status || 'unknown'}. This is a lead, not proof about the whole swap.`,
  };
}

/** Look a swap up and raise the alert (once per deposit address). Never throws: screening must not break a trace. */
export async function screenSwap(sw) {
  try {
    const ids = swapAddresses(sw).map((a) => a.id);
    if (!ids.length) return null;
    const { whatIsMany } = await import('../ontology/index.js'), { raise } = await import('../alerts/store.js');
    const m = await whatIsMany(ids), a = listedAlert(sw, (id) => m.get(id));
    if (!a) return null;
    await raise(a.key, { type: 'listed_address_swap', severity: 'high', title: a.title, text: a.text, url: `/firewall?q=${encodeURIComponent(a.ids[0])}`, related: { wallets: [sw.deposit_address] }, data: { swap: sw, case: a.case, addresses: a.ids } });
    return a;
  } catch { return null; }
}
