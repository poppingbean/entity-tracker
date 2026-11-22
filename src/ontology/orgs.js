// Organisations behind accounts (`operated_by` objects are `org:<slug>`), with the public identity they link to.
// `wikidata` ids were looked up in Wikidata's search on 2026-11-17 and checked against the item's description (cryptocurrency exchange); an organisation with no id
// here has not been looked up: nothing is guessed. HTX is Huobi's new name; Gate.io is listed as Gate.com.
export const ORGS = {
  'org:binance': { name: 'Binance', wikidata: 'Q51403327' },
  'org:bybit': { name: 'Bybit', wikidata: 'Q109424729' },
  'org:bitget': { name: 'Bitget', wikidata: 'Q138641419' },
  'org:okx': { name: 'OKX', wikidata: 'Q55627184' },
  'org:coinbase': { name: 'Coinbase', wikidata: 'Q16972754' },
  'org:kraken': { name: 'Kraken', wikidata: 'Q22906202' },
  'org:kucoin': { name: 'KuCoin', wikidata: 'Q97572932' },
  'org:gate-io': { name: 'Gate.io', wikidata: 'Q120069033' },
  'org:mexc': { name: 'MEXC', wikidata: 'Q131378477' },
  'org:htx': { name: 'HTX (Huobi)', wikidata: 'Q19892740' },
  'org:near-intents': { name: 'NEAR Intents', wikidata: null },
};
// names given to the organisation networks analysts record (org_networks), loaded with the ontology snapshot
const NAMES = new Map();
export const setOrgNames = (pairs) => { NAMES.clear(); for (const [id, name] of pairs) if (name) NAMES.set(id, name); };
export const orgInfo = (id) => {
  const o = ORGS[id];
  return { id, name: o?.name || NAMES.get(id) || String(id).replace(/^org:/, ''), same_as: o?.wikidata ? `https://www.wikidata.org/entity/${o.wikidata}` : null };
};

/** Every organisation an answer ties the account to, in words: "operated by bitmine; also tied to binance, bybit". null when none. */
export function orgsText(r) {
  const list = (r?.operators || []).map((o) => o.org || o.id).filter(Boolean);
  const all = list.length ? list : r?.operator ? [r.operator] : [];
  if (!all.length) return null;
  const n = (o) => orgInfo(o).name;
  return `operated by ${n(all[0])}${all.length > 1 ? `; also tied to ${all.slice(1).map(n).join(', ')}` : ''}`;
}
