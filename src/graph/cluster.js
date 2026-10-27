// Group wallets by on-chain relationships. Pure functions (unit-tested); persistence lives in graph/persist.js.
//
// A linked group is wallets one owner controls, shown by MONEY: funding, transfers, a shared personal funder or destination, the same
// exchange withdrawal, a token creator. Services (exchanges, relayers, account factories, trading bots that open their users' accounts,
// reward / treasury contracts) are never a link. Co-buys are behaviour, not ownership: they are kept as WEAK links that may attach a lone
// wallet to a group or pair lone wallets, but never merge two groups that money already holds together. A wallet linked to nobody is
// not a group (it is only in its tag groups, see evaluate/tags.js).
//
// Two wallets are linked when:
//   funder   - they share a non-generic funder somewhere up their funding chain (exchanges, relayers, intents and "distributor"
//              wallets that fund dozens of unrelated early buyers are ignored: sharing them proves nothing)
//   flow     - one sent NEAR to the other, or they both sent NEAR to the same non-generic destination
//   cobuy    - they bought within a few seconds of each other in at least COBUY_MIN_TOKENS different tokens
//   hub_twin - the same exchange hot wallet paid them the same odd amount (e.g. 17.706 NEAR) within an hour
//   creator  - a token's creator funded them or they sent NEAR to the creator (insider)
//   deep     - up to DEEP_DEPTH (3) hops of funding / flow through ordinary wallets lead both to the same account (see graph/deep.js);
//              this also uses the "network" wallets the expander profiled around each group
import { classifyAccount, isGenericKind } from './profile.js';
import { deepAnchors, DEEP_DEPTH } from './deep.js';
import { isService, fundsOwnSubaccounts } from './services.js';

export const DISTRIBUTOR_MAX_CHILDREN = 40; // an early wallet that funded more early wallets than this is a distributor, not an owner
export const SHARED_MAX_WALLETS = 10;       // a shared funder / destination linking more early wallets than this is a service, not an owner
export const SINK_MAX_SENDERS = SHARED_MAX_WALLETS;
export const DEEP_MAX_WALLETS = 10;         // a deep-link meeting point reached by more early wallets than this links nothing
export const HUB_TWIN_MS = 3600e3;         // same odd amount from the same exchange wallet within this time = same person
export const SINK_MIN_NEAR = 2;             // each wallet must have sent at least this much: dust to a bot / fee address (e.g. a trading bot) is not ownership

class UF {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); let c = x; while (this.p.get(c) !== r) { const n = this.p.get(c); this.p.set(c, r); c = n; } return r; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

/**
 * wallets: [{ _id, chain:[{account, kind, hop}], flow_out:[{to, near}] }]   (early, profiled wallets)
 * entries: [{ token, wallet, first_buy_ts }]      tokens: Map token -> { creator }
 * cfg: { cobuySeconds, cobuyMinTokens, deepDepth }      extra: profiled non-early "network" wallets, used only to find deeper links
 * Returns { groups: [{ members, nodes, links, nodeDepth }], walletGroup: Map }, members = early wallets only.
 */
export function buildGroups(wallets, entries, tokens, cfg, extra = []) {
  const svc = (a) => isService(a, cfg.services);
  const maxShared = cfg.maxSharedWallets ?? SHARED_MAX_WALLETS;
  const uf = new UF();
  const early = new Set(wallets.map((w) => w._id));
  for (const w of wallets) uf.find(w._id);
  const links = new Map(); // key -> { type, anchor, wallets:Set }
  const addLink = (type, anchor, ...ws) => { const k = `${type}|${anchor}`; const l = links.get(k) || { type, anchor, wallets: new Set() }; ws.forEach((x) => l.wallets.add(x)); links.set(k, l); return l; };

  // --- funder links: every non-generic account on a wallet's chain is an anchor; count how many early wallets each anchor reaches
  const reach = new Map(); // anchor -> Set(early wallets)
  for (const w of wallets) {
    const anchors = new Set();
    for (const f of w.funders || []) if (!isGenericKind(f.kind) && !f.creator_only) anchors.add(f.account);  // every meaningful first-level funder
    for (const c of w.chain || []) { if (isGenericKind(c.kind)) break; anchors.add(c.account); }              // and the first funder's own funders
    for (const a of anchors) (reach.get(a) || reach.set(a, new Set()).get(a)).add(w._id);
  }
  for (const [anchor, ws] of reach) {
    if (ws.size < 2 && !early.has(anchor)) continue;            // an anchor reaching one wallet links nothing (unless it is itself an early wallet)
    if (svc(anchor) || fundsOwnSubaccounts(anchor, ws)) continue; // a service / a platform opening its users' accounts
    if (ws.size > (early.has(anchor) ? DISTRIBUTOR_MAX_CHILDREN : maxShared)) continue; // distributor
    for (const w of ws) uf.union(w, anchor);
    addLink(early.has(anchor) ? 'funded_by_member' : 'shared_funder', anchor, ...ws);
  }

  // --- hub twins: an exchange hot wallet pays two early wallets the same odd amount within the hour (one person withdrawing twice)
  const byHub = new Map();
  for (const w of wallets) for (const f of w.funders || []) if (f.kind === 'hub' && f.near && f.ts) (byHub.get(f.account) || byHub.set(f.account, []).get(f.account)).push({ w: w._id, near: f.near, ts: f.ts });
  for (const [hub, list] of byHub) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (list[j].ts - list[i].ts > HUB_TWIN_MS) break;
      const a = list[i], b = list[j];
      if (a.w !== b.w && Math.abs(a.near - b.near) <= 0.0005 && Math.abs(a.near - Math.round(a.near)) > 0.001) { uf.union(a.w, b.w); addLink('hub_twin', `${hub}|${a.near.toFixed(3)}`, a.w, b.w); }
    }
  }

  // --- flow links: between early wallets, and into a shared non-generic destination
  const senders = new Map(); // destination -> Map(wallet -> near)
  for (const w of wallets) for (const f of w.flow_out || []) {
    if (f.to === w._id) continue;
    if (early.has(f.to)) { uf.union(w._id, f.to); addLink('flow_between_members', `${w._id}>${f.to}`, w._id, f.to); continue; }
    if (isGenericKind(classifyAccount(f.to, null)) || svc(f.to) || f.near < SINK_MIN_NEAR) continue;
    (senders.get(f.to) || senders.set(f.to, new Map()).get(f.to)).set(w._id, f.near);
  }
  for (const [dest, m] of senders) {
    if (m.size < 2 || m.size > maxShared) continue;
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
  const cobuy = [...pairTokens].filter(([, n]) => n >= cfg.cobuyMinTokens).sort((x, y) => y[1] - x[1]);
  const cobuyPartners = new Map(); // wallet -> [{ wallet, tokens }]
  for (const [k, n] of cobuy) { const [a, b] = k.split('|'); (cobuyPartners.get(a) || cobuyPartners.set(a, []).get(a)).push({ wallet: b, tokens: n }); (cobuyPartners.get(b) || cobuyPartners.set(b, []).get(b)).push({ wallet: a, tokens: n }); }

  // --- deep links: up to 3 hops of funding / flow lead two or more early wallets to the same ordinary account
  const deep = deepAnchors([...early], [...wallets, ...extra], { maxDepth: cfg.deepDepth ?? DEEP_DEPTH, maxReach: cfg.deepMaxWallets ?? DEEP_MAX_WALLETS, isService: svc });
  let deepLinks = 0;
  for (const a of deep.anchors) {
    if (new Set(a.wallets.map((w) => uf.find(w))).size < 2) continue; // already one group through a direct link: nothing new
    for (const w of a.wallets) for (const n of a.paths[w]) uf.union(w, n);
    addLink('deep_link', a.anchor, ...a.wallets).depth = a.depth;
    deepLinks++;
  }

  // --- co-buy links (weak). Ownership is settled first: which wallets money already ties to another early wallet
  const strongRoot = new Map(), strongSize = new Map();
  for (const w of early) { const r = uf.find(w); strongRoot.set(w, r); strongSize.set(r, (strongSize.get(r) || 0) + 1); }
  const isStrong = (w) => (strongSize.get(strongRoot.get(w)) || 0) >= 2;
  const compSize = new Map([...early].map((w) => [uf.find(w), 0])); for (const w of early) compSize.set(uf.find(w), compSize.get(uf.find(w)) + 1);
  const compStrong = new Map(); for (const w of early) if (isStrong(w)) compStrong.set(uf.find(w), true);
  let cobuyPairs = 0;
  for (const [k] of cobuy) {
    const [a, b] = k.split('|'); if (!early.has(a) || !early.has(b)) continue;
    const ra = uf.find(a), rb = uf.find(b); if (ra === rb) continue;
    const sa = compStrong.get(ra), sb = compStrong.get(rb);
    if (sa && sb) continue;                                   // never merges two groups that money holds together
    // into a money group only a lone wallet, and only through a money-linked member (no chains through other co-buy partners)
    if (sa && (!isStrong(a) || compSize.get(rb) > 1)) continue;
    if (sb && (!isStrong(b) || compSize.get(ra) > 1)) continue;
    uf.union(a, b); const r = uf.find(a);
    compSize.set(r, compSize.get(ra) + compSize.get(rb)); if (sa || sb) compStrong.set(r, true);
    cobuyPairs++; addLink('cobuy', k, a, b).weak = true;
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
    for (const l of links.values()) { const ws = [...l.wallets].filter((x) => memberSet.has(x)); if (ws.length) gl.push({ type: l.type, anchor: l.anchor, wallets: ws, ...(l.depth ? { depth: l.depth } : {}), ...(l.weak ? { weak: true } : {}) }); }
    // members tied in by money vs only by co-buys
    const weak = g.members.filter((m) => !isStrong(m));
    g.members.sort(); g.nodes.sort();
    // how far each non-member node is from the nearest member (1 = direct funder / destination, up to DEEP_DEPTH)
    const nodeDepth = {};
    for (const n of g.nodes) if (!memberSet.has(n)) { let best = null; for (const m of g.members) { const d = deep.reaches.get(m)?.get(n)?.d; if (d && (best == null || d < best)) best = d; } nodeDepth[n] = best ?? 1; }
    // strong links first, so a stored (truncated) link list keeps the ownership evidence
    gl.sort((x, y) => (x.weak ? 1 : 0) - (y.weak ? 1 : 0));
    out.push({ members: g.members, nodes: g.nodes, links: gl, nodeDepth, weak_members: weak.sort(), weak_only: weak.length === g.members.length });
  }
  out.forEach((g, i) => g.members.forEach((m) => walletGroup.set(m, i)));
  return { groups: out, walletGroup, insiderEntries, cobuyPairs, deepLinks, cobuyPartners };
}
