// One-off: wire the Binance-hack laundering memecoins into the case, firewall, ontology and scanner blacklist.
//   node _w.mjs [--dry]
import 'dotenv/config';
import fs from 'fs';
import { connectDb, closeDb, col } from './src/db.js';
import { assert, whatIs, clearCache } from './src/ontology/index.js';
import { backfill } from './src/ontology/backfill.js';
import { blacklistCreator } from './src/scanner/pipeline.js';
const DRY = process.argv.includes('--dry');
await connectDb();
const CASE = 'inc:efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af', BY = 'trace/binance-hack-laundering-tokens', GRP = 'grp:binance-hack-laundering-tokens';
const edges = JSON.parse(fs.readFileSync('_edges.json', 'utf8'));
const hub = 'd368b0079b34b0700b650eed72417b66467020fde05b8bf8a1fc8a375dc84484';
const funders = ['85f0680ac65f94793877c17b87b4b526644a4219caee3c56ee47a4570da37129', 'e907855c9f35142d29811f286a9d047ded276b6b88eea96c1a9aaa7b01a81632', 'c74b910582db56a4d784c56c2ff63e34801a5c3b42be0b0b0f034590468c694c', '58d03c8d194b3c39e64e1e949a8a2e8ab85cb365e1bf1178ff5828f4e882adc9', 'ff137d9f9206dcf31e63a03255c0d00c0cc8dedc26174c286975971c2c65049a'];
// woxixi.near (already a cash-out wallet of the case) -> uixii.near -> hub -> 96eb… -> cdvve.near -> 9c00… -> normalherb1811.near
const chain = ['uixii.near', '96eb4cb6d330538588d8f4781df86fcaa52eec6c97c07d6392dbb51868080603', 'cdvve.near', '9c0060831c9bd843ed94277b76d8b66393d845a0eec5ccd5d0956f31deee7dc5'];
const buyers = ['normalherb1811.near', 'deepkingdom2311.near', 'weirdglove364.near', 'soliddress8221.near', 'greenmuseum9245.near', 'sharpicon3186.near', 'freejacket4246.near', 'redlemon6015.near'];
const firm = [hub, ...funders, ...chain, ...buyers];
const signers = { 'smoothward1740.near': 'fuk-3.smithii.near', 'toughuni8251.near': 'olccl-4.smithii.near', 'sourbelt7061.near': 'meili-5.smithii.near', 'sadfield5984.near': 'mmli-6.smithii.near', 'swiftblog5330.near': 'dabi-7.smithii.near', 'thinos1181.near': 'sinu-8.smithii.near' };
const ringF = ['thickhare3997.near', 'farstreet4572.near', 'leftflour7482.near', '3014c80b3f1bb8d29dc9afa48e3e714bad2af9be43638a97e8fd5e5aeac756d3'];

// 1) the case: the traced wallets become its cash-out wallets (follow-ups keep them; flags and role_in facts come from here)
const inc = await col('incidents').findOne({ _id: CASE });
const have = new Set(inc.accounts.map((a) => a.account));
const add = firm.filter((a) => !have.has(a)).map((account) => ({ account, role: 'cash_out_wallet', ts: Date.now(), added_by: BY }));
console.log('case accounts to add', add.length, 'already there', firm.length - add.length);
if (!DRY && add.length) await col('incidents').updateOne({ _id: CASE }, { $push: { accounts: { $each: add } }, $set: { updated_ts: Date.now() } });

// 2) firewall flags, worded exactly as the incident's own flagAccounts does for a cash_out_wallet
const what = `received the money drained from ${inc.drain?.exchange || 'an exchange'}'s hot wallets${inc.started_ts ? ` on ${new Date(inc.started_ts).toISOString().slice(0, 10)}` : ''} (~$${Math.round(inc.stolen_usd).toLocaleString('en-US')} taken)`;
let fl = 0, kept = 0;
for (const a of firm) {
  const other = await col('firewall_flags').findOne({ _id: a });
  if (other && !(other.source === 'incident' && other.incident === CASE)) { kept++; continue; } // a flag from another source stays
  if (!DRY) await col('firewall_flags').updateOne({ _id: a }, { $set: { severity: 'high', reason: what.slice(0, 120), detail: `Received money from an attacker that ${what}.`, source: 'incident', incident: CASE }, $setOnInsert: { ts: Date.now() } }, { upsert: true });
  fl++;
}
console.log('high flags', fl, 'other-source flags kept', kept);

// 3) scanner: the six creators are refused from now on (no token field: these are laundering tokens, not dev rugs)
let bl = 0;
for (const [a, tok] of Object.entries(signers)) if (!DRY && await blacklistCreator(a, { account: a, laundering_token: tok, case: CASE, reason: `created ${tok}, a memecoin bought almost only by wallets funded from the Binance hack` })) bl++;
console.log('blacklisted', bl);

// 4) ontology: this writer's own facts (edges, group, suspected roles); role_in and flagged come from the real backfill writers
const facts = [];
for (const e of edges) if (e.tx && e.from !== 'majorjuice6994.near') facts.push({ subject: e.from, predicate: 'funded', object: e.to, source: 'trace', confidence: 0.9, evidence: `${e.near.toFixed(2)} NEAR in ${e.n} transfer(s), first ${e.tx}`, near: e.near, tx: e.tx, ts: e.ts, by: BY });
for (const a of ['woxixi.near', ...firm]) facts.push({ subject: a, predicate: 'member_of', object: GRP, source: 'trace', confidence: 0.8, evidence: `funded from the Binance hack attacker account through ${hub.slice(0, 8)}…; the buyers bought the FUK/OLCCL/MEILI/MMLI/DABI/SINU memecoins`, by: BY });
for (const [a, tok] of Object.entries(signers)) {
  const why = `token creator: made ${tok}, whose buying came almost only from wallets funded from the Binance hack attacker account; linked by trading, no traced payment`;
  facts.push({ subject: a, predicate: 'member_of', object: GRP, source: 'trace', confidence: 0.6, evidence: why, by: BY });
  facts.push({ subject: a, predicate: 'role_in', object: CASE, role: 'accomplice', status: 'suspected', kind: inc.kind, source: 'trace', confidence: 0.6, evidence: why, by: BY, valid_to: null });
}
for (const a of ringF) facts.push({ subject: a, predicate: 'member_of', object: GRP, source: 'trace', confidence: 0.4, evidence: 'funded the creators of the laundering memecoins; its own funding is not traced to the hack', by: BY });
facts.push({ subject: 'clearurial9207.near', predicate: 'member_of', object: GRP, source: 'trace', confidence: 0.4, evidence: 'bought 4,600 wNEAR of MMLI beside the hack-funded buyers; its funding (majorjuice6994.near, from aggregatedex.near) is not traced to the hack', by: BY });
if (DRY) { console.log('facts to write', facts.length); await closeDb(); process.exit(0); }
const del = await col('ontology_facts').deleteMany({ by: BY });
console.log('old facts of this writer removed', del.deletedCount, '· written', await assert(facts), 'of', facts.length);
const r = await backfill({ only: ['incidents', 'firewall_flags'] });
console.log('backfill', JSON.stringify({ per: r.per, written: r.written, retired: r.retired, entities: r.entities, rejected: r.rejected.length }));
clearCache();
for (const a of [hub, 'uixii.near', 'normalherb1811.near', 'deepkingdom2311.near', 'smoothward1740.near', 'clearurial9207.near']) {
  const w = await whatIs(a);
  console.log(a.slice(0, 22), JSON.stringify({ class: w.class, roles: (w.roles || []).map((x) => `${x.role}/${x.status}`), groups: w.groups, flagged: w.flagged?.severity ?? w.flagged ?? null }));
}
await closeDb();
