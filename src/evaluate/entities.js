// Entities: every account the early investors are tied to, exchange wallets included. A group is a set of early investors; an
// entity is any account in their funding / money-flow graph (exchange hot wallets, NEAR Intents accounts, relayers, ordinary
// funder wallets, and the destinations their NEAR goes to), with what it did to the early market: how many early wallets it
// funded, how much, which tokens they bought, how those wallets did, and which good / bad groups they belong to.
import { col, bulkReplace } from '../db.js';
import { info } from '../log.js';
import { classifyAccount, isGenericKind } from '../graph/profile.js';
import { describe } from '../labels.js';
import { creatorIndex, creatorAnchors } from './creators.js';

const CAP = 80; // wallets listed per entity

/** What an entity did for token creators: how many it funded (and how they did), and how many sent their NEAR to it. */
function creatorStats(e, credOf) {
  const funded = [...e.creators.values()].map((c) => ({ ...c, ...credOf(c.creator) })), sinks = [...e.creatorSinks.values()].map((c) => ({ ...c, ...credOf(c.creator) }));
  const bad = (c) => c.rugged > 0 || c.blacklisted;
  const launches = funded.reduce((s, c) => s + c.launches, 0), rugged = funded.reduce((s, c) => s + c.rugged, 0);
  return {
    creators_funded_n: funded.length, creators_rugged_n: funded.filter(bad).length, creators_funded_near: funded.reduce((s, c) => s + (c.near || 0), 0),
    creator_launches: launches, creator_rugged_tokens: rugged, creator_rug_rate: launches ? rugged / launches : null,
    creators_funded: funded.sort((a, b) => b.rugged - a.rugged || b.launches - a.launches).slice(0, CAP),
    creator_sink_n: sinks.length, creator_sink_near: sinks.reduce((s, c) => s + (c.near || 0), 0), creator_sink_rugged_n: sinks.filter(bad).length,
    creator_sinks: sinks.sort((a, b) => b.near - a.near).slice(0, CAP),
  };
}

export async function buildEntities() {
  const wallets = await col('wallets').find({ is_early: true, profiled: true }, { projection: { funders: 1, chain: 1, cluster_id: 1, cluster_verdict: 1, tag: 1, stats: 1, first_seen_ts: 1 } }).toArray();
  const creatorWallets = await col('wallets').find({ is_creator: true, profiled: true }, { projection: { funders: 1, chain: 1, flow_out: 1 } }).toArray();
  if (!wallets.length && !creatorWallets.length) return { entities: 0 };
  const wmap = new Map(wallets.map((w) => [w._id, w]));
  const entries = await col('entries').find({ wallet: { $in: [...wmap.keys()] } }, { projection: { wallet: 1, token: 1, symbol: 1 } }).toArray();
  const tokensOf = new Map();
  for (const e of entries) (tokensOf.get(e.wallet) || tokensOf.set(e.wallet, new Set()).get(e.wallet)).add(e.token);

  const fundEdges = await col('edges').find({ type: 'fund', to: { $in: [...wmap.keys()] } }, { projection: { from: 1, to: 1, hash: 1 } }).toArray();
  const hashOf = new Map(fundEdges.map((x) => [`${x.from}|${x.to}`, x.hash]));
  const manual = Object.fromEntries((await col('labels').find().toArray()).map((l) => [l._id, l]));
  const ents = new Map();
  const get = (id) => { let e = ents.get(id); if (!e) { e = { _id: id, roles: new Set(), kind: null, tx_count: null, funded: new Map(), sinks: new Map(), creators: new Map(), creatorSinks: new Map() }; ents.set(id, e); } return e; };

  // funders: first-level funders and every hop of the first funder's chain
  for (const w of wallets) {
    for (const f of w.funders || []) {
      const e = get(f.account); e.roles.add('funder'); e.kind = e.kind || f.kind; e.tx_count = e.tx_count ?? f.tx_count;
      const cur = e.funded.get(w._id) || { wallet: w._id, near: 0, ts: f.ts, hash: f.hash || hashOf.get(`${f.account}|${w._id}`) || null, via: f.via || null, hop: 1 };
      cur.near += f.near || 0; e.funded.set(w._id, cur);
    }
    for (const c of w.chain || []) {
      if (c.hop === 1) continue; // already counted as a first-level funder
      const e = get(c.account); e.roles.add('funder'); e.kind = e.kind || c.kind; e.tx_count = e.tx_count ?? c.tx_count;
      if (!e.funded.has(w._id)) e.funded.set(w._id, { wallet: w._id, near: c.near || 0, ts: null, via: null, hop: c.hop });
    }
  }
  // sinks: where the early wallets sent NEAR
  const flows = await col('edges').find({ type: 'flow', from: { $in: [...wmap.keys()] } }).toArray();
  for (const f of flows) {
    if (wmap.has(f.to)) continue; // flows between early wallets are group links, not entities
    const e = get(f.to); e.roles.add('sink');
    const cur = e.sinks.get(f.from) || { wallet: f.from, near: 0, n: 0 }; cur.near += f.near || 0; cur.n += f.n || 0; e.sinks.set(f.from, cur);
  }

  // token creators: who funded them (first level and up the chain) and where they sent NEAR (cash-outs)
  for (const w of creatorWallets) {
    const a = creatorAnchors(w, (acc) => classifyAccount(acc, null));
    for (const x of a.up) {
      if (x.account === w._id) continue;
      const e = get(x.account); e.roles.add('creator_funder'); e.kind = e.kind || x.kind;
      if (!e.creators.has(w._id)) e.creators.set(w._id, { creator: w._id, near: x.near || 0, hop: x.hop, ts: x.ts, hash: x.hash, via: x.via });
    }
    for (const x of a.down) { const e = get(x.account); e.roles.add('creator_sink'); e.kind = e.kind || x.kind; e.creatorSinks.set(w._id, { creator: w._id, near: x.near, n: x.n }); }
  }
  const crec = creatorWallets.length ? await creatorIndex(creatorWallets.map((w) => w._id)) : new Map();
  const credOf = (id) => { const c = crec.get(id); return { launches: c?.launches ?? 0, rugged: c?.rugged ?? 0, blacklisted: !!c?.blacklisted }; };

  const docs = [];
  for (const e of ents.values()) {
    const kind = e.kind || classifyAccount(e._id, null);
    const onlySink = [...e.roles].every((r) => r === 'sink' || r === 'creator_sink');
    if (onlySink && e.sinks.size + e.creatorSinks.size < 2 && isGenericKind(kind) === false) continue; // a destination one wallet paid once is noise
    const funded = [...e.funded.values()], sinkers = [...e.sinks.values()];
    const verdicts = { win80: 0, win50: 0, win30: 0, sniper: 0, loss: 0, unrated: 0 };
    const tokens = new Set();
    let pnl = 0, buy = 0, wins = 0, judged = 0;
    for (const f of funded) {
      const w = wmap.get(f.wallet); if (!w) continue;
      verdicts[w.tag in verdicts ? w.tag : 'unrated']++;
      for (const t of tokensOf.get(w._id) || []) tokens.add(t);
      if (w.stats?.tokens_n) { pnl += w.stats.pnl_near || 0; buy += w.stats.total_buy_near || 0; judged++; if ((w.stats.win_rate ?? 0) >= 0.5) wins++; }
    }
    const d = describe(e._id, kind, manual);
    docs.push({
      _id: e._id, kind, label: d.label, type: d.type, label_source: d.source, roles: [...e.roles], tx_count: e.tx_count,
      funded_n: funded.length, funded_near: funded.reduce((s, f) => s + (f.near || 0), 0), funded_wallets: funded.sort((a, b) => (b.near || 0) - (a.near || 0)).slice(0, CAP).map((f) => ({ ...f, cluster_id: wmap.get(f.wallet)?.cluster_id ?? null, tag: wmap.get(f.wallet)?.tag ?? null })),
      funded_verdicts: verdicts, tokens_n: tokens.size, funded_pnl_near: pnl, funded_buy_near: buy, funded_roi: buy ? pnl / buy : null, funded_winners: wins, funded_judged: judged,
      ...creatorStats(e, credOf),
      sink_senders_n: sinkers.length, sink_near: sinkers.reduce((s, x) => s + x.near, 0), sink_wallets: sinkers.sort((a, b) => b.near - a.near).slice(0, CAP),
      updated_ts: Date.now(),
    });
  }
  await bulkReplace('entities', docs);
  const keep = docs.map((x) => x._id);
  await col('entities').deleteMany({ _id: { $nin: keep } });
  const by = (t) => docs.filter((x) => x.type === t).length;
  info(`ENTITIES ${docs.length} (exchange ${by('exchange')}, service ${by('service')}, bridge ${by('bridge')}, wallet ${by('wallet')}, other ${docs.length - by('exchange') - by('service') - by('bridge') - by('wallet')})`);
  return { entities: docs.length };
}
