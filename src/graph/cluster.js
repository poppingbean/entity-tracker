// Group wallets by on-chain relationships. Pure functions (unit-tested); persistence lives in graph/persist.js.
//
// Two wallets are linked when:
//   funder   - they share a non-generic funder somewhere up their funding chain (exchanges, relayers, intents and "distributor"
//              wallets that fund dozens of unrelated early buyers are ignored: sharing them proves nothing)
//   flow     - one sent NEAR to the other, or they both sent NEAR to the same non-generic destination
//   cobuy    - they bought within a few seconds of each other in at least COBUY_MIN_TOKENS different tokens
//   creator  - a token's creator funded them or they sent NEAR to the creator (insider)
import { classifyAccount, isGenericKind } from './profile.js';

export const DISTRIBUTOR_MAX_CHILDREN = 40; // a funder of more early wallets than this is a distributor, not an owner
export const SINK_MAX_SENDERS = 12;         // a destination that many early wallets pay is an exchange deposit or a service, not an owner
export const SINK_MIN_NEAR = 2;             // each wallet must have sent at least this much: dust to a bot / fee address (e.g. a trading bot) is not ownership

class UF {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); let c = x; while (this.p.get(c) !== r) { const n = this.p.get(c); this.p.set(c, r); c = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

/**
 * wallets: [{ _id, chain:[{account, kind, hop}], flow_out:[{to, near}] }]   (early, profiled wallets)
 * entries: [{ token, wallet, first_buy_ts }]      tokens: Map token -> { creator }
 * cfg: { cobuySeconds, cobuyMinTokens }
 * Returns { groups: [{ members, nodes, links }], walletGroup: Map }, members = early wallets only.
 */
export function buildGroups(wallets, entries, tokens, cfg) {
  const uf = new UF();
  const early = new Set(wallets.map((w) => w._id));
  for (const w of wallets) uf.find(w._id);
  const links = new Map(); // key -> { type, anchor, wallets:Set }
  const addLink = (type, anchor, ...ws) => { const k = `${type}|${anchor}`; const l = links.get(k) || { type, anchor, wallets: new Set() }; ws.forEach((x) => l.wallets.add(x)); links.set(k, l); };

  // --- funder links: every non-generic account on a wallet's chain is an anchor; count how many early wallets each anchor reaches
  const reach = new Map(); // anchor -> Set(early wallets)
  for (const w of wallets) for (const c of w.chain || []) { if (isGenericKind(c.kind)) break; (reach.get(c.account) || reach.set(c.account, new Set()).get(c.account)).add(w._id); }
  for (const [anchor, ws] of reach) {
    if (ws.size < 2 && !early.has(anchor)) continue;            // an anchor reaching one wallet links nothing (unless it is itself an early wallet)
    if (ws.size > DISTRIBUTOR_MAX_CHILDREN) continue;           // distributor
    for (const w of ws) uf.union(w, anchor);
    addLink(early.has(anchor) ? 'funded_by_member' : 'shared_funder', anchor, ...ws);
  }

  // --- flow links: between early wallets, and into a shared non-generic destination
  const senders = new Map(); // destination -> Map(wallet -> near)
  for (const w of wallets) for (const f of w.flow_out || []) {
    if (f.to === w._id) continue;
    if (early.has(f.to)) { uf.union(w._id, f.to); addLink('flow_between_members', `${w._id}>${f.to}`, w._id, f.to); continue; }
    if (isGenericKind(classifyAccount(f.to, null)) || f.near < SINK_MIN_NEAR) continue;
    (senders.get(f.to) || senders.set(f.to, new Map()).get(f.to)).set(w._id, f.near);
  }
  for (const [dest, m] of senders) {
    if (m.size < 2 || m.size > SINK_MAX_SENDERS) continue;
    for (const w of m.keys()) uf.union(w, dest);
    addLink('shared_destination', dest, ...m.keys());
  }

  // --- creator links (insiders)
  const insiderEntries = new Set();
  const byWallet = new Map(wallets.map((w) => [w._id, w]));
  for (const e of entries) {
    const creator = tokens.get(e.token)?.creator; if (!creator) continue;
    const w = byWallet.get(e.wallet); if (!w) continue;
    const funded = (w.chain || []).slice(0, 2).some((c) => c.account === creator);
    const paid = (w.flow_out || []).some((f) => f.to === creator);
    if (e.wallet === creator || funded || paid) { uf.union(e.wallet, creator); addLink('creator_linked', creator, e.wallet); insiderEntries.add(`${e.token}|${e.wallet}`); }
  }

  // --- co-buy links: same token, within a few seconds, repeated over several tokens
  const byToken = new Map();
  for (const e of entries) (byToken.get(e.token) || byToken.set(e.token, []).get(e.token)).push(e);
  const pairTokens = new Map();
  for (const list of byToken.values()) {
    list.sort((a, b) => a.first_buy_ts - b.first_buy_ts);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if ((list[j].first_buy_ts - list[i].first_buy_ts) / 1000 > cfg.cobuySeconds) break;
      if (list[i].wallet === list[j].wallet) continue;
      const k = list[i].wallet < list[j].wallet ? `${list[i].wallet}|${list[j].wallet}` : `${list[j].wallet}|${list[i].wallet}`;
      pairTokens.set(k, (pairTokens.get(k) || 0) + 1);
    }
  }
  let cobuyPairs = 0;
  for (const [k, n] of pairTokens) {
    if (n < cfg.cobuyMinTokens) continue;
    const [a, b] = k.split('|'); uf.union(a, b); cobuyPairs++; addLink('cobuy', k, a, b);
  }

  // --- collect groups
  const groups = new Map();
  for (const x of uf.p.keys()) {
    const r = uf.find(x);
    const g = groups.get(r) || { members: [], nodes: [], linkKeys: new Set() };
    g.nodes.push(x); if (early.has(x)) g.members.push(x);
    groups.set(r, g);
  }
  const out = [];
  const walletGroup = new Map();
  for (const g of groups.values()) {
    if (!g.members.length) continue;
    const memberSet = new Set(g.members);
    const gl = [];
    for (const l of links.values()) { const ws = [...l.wallets].filter((x) => memberSet.has(x)); if (ws.length) gl.push({ type: l.type, anchor: l.anchor, wallets: ws }); }
    g.members.sort(); g.nodes.sort();
    out.push({ members: g.members, nodes: g.nodes, links: gl });
  }
  out.forEach((g, i) => g.members.forEach((m) => walletGroup.set(m, i)));
  return { groups: out, walletGroup, insiderEntries, cobuyPairs };
}
