// Entities: every account the early investors are tied to, exchange wallets included. A group is a set of early investors; an
// entity is any account in their funding / money-flow graph (exchange hot wallets, NEAR Intents accounts, relayers, ordinary
// funder wallets, and the destinations their NEAR goes to), with what it did to the early market: how many early wallets it
// funded, how much, which tokens they bought, how those wallets did, and which good / bad groups they belong to.
import { col, bulkReplace } from '../db.js';
import { info } from '../log.js';
import { classifyAccount, isGenericKind } from '../graph/profile.js';
import { describe } from '../labels.js';

const CAP = 80; // wallets listed per entity

export async function buildEntities() {
  const wallets = await col('wallets').find({ is_early: true, profiled: true }, { projection: { funders: 1, chain: 1, cluster_id: 1, cluster_verdict: 1, stats: 1, first_seen_ts: 1 } }).toArray();
  if (!wallets.length) return { entities: 0 };
  const wmap = new Map(wallets.map((w) => [w._id, w]));
  const entries = await col('entries').find({ wallet: { $in: [...wmap.keys()] } }, { projection: { wallet: 1, token: 1, symbol: 1 } }).toArray();
  const tokensOf = new Map();
  for (const e of entries) (tokensOf.get(e.wallet) || tokensOf.set(e.wallet, new Set()).get(e.wallet)).add(e.token);

  const manual = Object.fromEntries((await col('labels').find().toArray()).map((l) => [l._id, l]));
  const ents = new Map();
  const get = (id) => { let e = ents.get(id); if (!e) { e = { _id: id, roles: new Set(), kind: null, tx_count: null, funded: new Map(), sinks: new Map() }; ents.set(id, e); } return e; };

  // funders: first-level funders and every hop of the first funder's chain
  for (const w of wallets) {
    for (const f of w.funders || []) {
      const e = get(f.account); e.roles.add('funder'); e.kind = e.kind || f.kind; e.tx_count = e.tx_count ?? f.tx_count;
      const cur = e.funded.get(w._id) || { wallet: w._id, near: 0, ts: f.ts, via: f.via || null, hop: 1 };
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

  const docs = [];
  for (const e of ents.values()) {
    const kind = e.kind || classifyAccount(e._id, null);
    if (e.roles.size === 1 && e.roles.has('sink') && e.sinks.size < 2 && isGenericKind(kind) === false) continue; // a destination one wallet paid once is noise
    const funded = [...e.funded.values()], sinkers = [...e.sinks.values()];
    const verdicts = { good: 0, bad: 0, neutral: 0, unknown: 0, solo: 0 };
    const tokens = new Set();
    let pnl = 0, buy = 0, wins = 0, judged = 0;
    for (const f of funded) {
      const w = wmap.get(f.wallet); if (!w) continue;
      verdicts[w.cluster_verdict || 'solo']++;
      for (const t of tokensOf.get(w._id) || []) tokens.add(t);
      if (w.stats?.tokens_n) { pnl += w.stats.pnl_near || 0; buy += w.stats.total_buy_near || 0; judged++; if ((w.stats.win_rate ?? 0) >= 0.5) wins++; }
    }
    const d = describe(e._id, kind, manual);
    docs.push({
      _id: e._id, kind, label: d.label, type: d.type, label_source: d.source, roles: [...e.roles], tx_count: e.tx_count,
      funded_n: funded.length, funded_near: funded.reduce((s, f) => s + (f.near || 0), 0), funded_wallets: funded.sort((a, b) => (b.near || 0) - (a.near || 0)).slice(0, CAP).map((f) => ({ ...f, cluster_id: wmap.get(f.wallet)?.cluster_id ?? null, verdict: wmap.get(f.wallet)?.cluster_verdict ?? null })),
      funded_verdicts: verdicts, tokens_n: tokens.size, funded_pnl_near: pnl, funded_buy_near: buy, funded_roi: buy ? pnl / buy : null, funded_winners: wins, funded_judged: judged,
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
