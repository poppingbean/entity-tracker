// The token analyst's instructions: TrustFlow Research's on-chain analyst prompt (../prompts/near_onchain_analyst_prompt.md, beside this repo),
// adapted to how this tracker works. The tracker pulls and decodes the full ledger, reads live balances, contracts and funders itself, and
// hands the model one evidence packet; the model writes the investigation (report sections + a Telegram post) from that packet only.
// The data-pulling, decoding and file-writing parts of the original prompt are done by the tracker; its standards, tracing techniques,
// known actors and house style are here.
import { prompt } from '../ai/prompts/index.js';

/** Accounts that look like actors but are not (the prompt's "don't over-claim" list). Used to label accounts in the packet. */
export function accountRole(acc) {
  const a = String(acc || '');
  if (/\.user\.intear\.near$|\.racerbot\.near$|\.trade\.unrlzd\.near$/.test(a)) return 'wallet-app user (trades through an app; real user, not a bot)';
  if (/\.tg$/.test(a)) return 'Telegram-wallet user';
  if (/^reward-distribute\.justhoot\.near$/.test(a)) return 'platform fee bot (converts the transfer fee and pays holders)';
  if (/^(nearlytrade\.near|launchpad\.justhoot\.near|v2-launchpad\.justhoot\.near|v2-pool-creator\.justhoot\.near)$|^lock_.*\.nearlytrade\.near$|^holders\./.test(a)) return 'launchpad contract (UIs often label it "DEV")';
  if (/^(dclv2\.ref-labs|v2\.ref-finance|aggregatedex|dex\.intear|intents)\.near$|^aa-router\.justhoot\.near$|^router\./.test(a)) return 'infrastructure (DEX, router or intents: signs or routes for users)';
  return null;
}

/**
 * Known actors from earlier investigations (the prompt's table). Ids are full names, or the first 8 characters of an implicit (64-hex)
 * account. Only the ones that appear in a packet are given to the model, and it is told to treat them as leads to verify, not facts.
 */
export const KNOWN_ACTORS = [
  { ids: ['onionsage.near', 'gutsah.near', 'smallicon823.near', 'majornecktie8007.near', 'soonlink3248.near'], note: 'HOOT Cluster B: buy the same amount in the same second and sell in identical slices; seen on NINU, DIARHEA, HOOT and THREE' },
  { ids: ['colddress6080.near', 'ef642bbe'], note: 'NEARLY Group A: pre-funded snipers (ef642bbe… is a lockstep pair on ROBIN)' },
  { ids: ['my6bom.tg', 'ba890f40', 'flowwers.near', 'rooti.near', '73bb15d8'], note: 'my6bom network: large SINGULARTY bag' },
  { ids: ['threeis.near', '30a1522a', 'da138627', 'c013f781', 'happyvideo1375.near', 'copperteacup.near', 'redvinegar7169.near', 'widezip4942.near', '60ac1b6d'], note: 'THREE creator and look-alikes: relay-funded (1 N first, then the main amount); copperteacup → 60ac1b6d…, which also holds HOOT' },
  { ids: ['blackdragonmeme.near', 'feeswaps.near', 'b6e44ab3'], note: 'BLACKDRAGON pump-and-dump of 14 Oct (feeswaps.near is a look-alike of feeswap.near; b6e44ab3… front-ran it)' },
  { ids: ['vad22.near', 'buyitall.near', 'jonnyy.near', 'soontea6618.near', 'letgetit.near', '3a5bc6ac', 'rekttin.near', 'futureis.user.intear.near'], note: 'repeat flippers and churners' },
  { ids: ['d45a2ac2', 'c8bde0e9', 'wrapz-z.near', 'b4adf54a', 'ro52.near', 'cockis.near'], note: 'launch-sniper bots (buy in the first seconds)' },
  { ids: ['scorp56.near'], note: 'QCAT creator; sniper; funded NFT-mint wallets' },
  { ids: ['strongzebra1197.near', 'singlecap963.near'], note: 'NEAR Dragons NFT team; self-minted 50 NFTs' },
  { ids: ['451913e6', '5c33c621', 'ccb91e1d', '9c484fa5', '52435fe9', '0d584a4c', 'a9c8669d', 'e5894573', '30d6205b', '282acb8e'], note: 'exchange or hub wallet: funding from it is NOT a link between wallets', hub: true },
];
export const PRIVACY_RELAY = '51e8f94d';
const famous = new Set(['zavodil.near', 'near.near', 'root.near']);

/** Known actors and roles for the accounts that appear in `packet` (any string value that is an account or a shortened implicit id). */
export function actorsIn(packet) {
  const seen = new Set();
  const walk = (v) => { if (typeof v === 'string') seen.add(v.replace(/…$/, '')); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(packet);
  const match = (id) => [...seen].some((s) => s === id || (id.length === 8 && /^[0-9a-f]{8}/.test(s) && s.startsWith(id)));
  const known = KNOWN_ACTORS.flatMap((k) => k.ids.filter(match).map((id) => ({ account: /^[0-9a-f]{8}$/.test(id) ? id + '…' : id, note: k.note, ...(k.hub ? { not_a_link: true } : {}) })));
  const roles = [...seen].filter((s) => /\.(near|tg)$/.test(s)).map((s) => ({ account: s, role: accountRole(s) })).filter((x) => x.role);
  const fam = [...seen].filter((s) => famous.has(s));
  if (match(PRIVACY_RELAY)) known.push({ account: PRIVACY_RELAY + '…', note: 'NEAR Intents privacy relay shared by many users: funding through it is a matching pattern, not proof' });
  return { known_actors: known, account_roles: roles, ...(fam.length ? { famous_accounts: fam } : {}) };
}







export const SYSTEM_INITIAL = prompt('token-analyst'); // src/ai/prompts/token-analyst.md (+ its standards, report and post parts)

export const SYSTEM_UPDATE = prompt('token-analyst-update');
