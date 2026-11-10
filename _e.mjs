import 'dotenv/config';
import fs from 'fs';
import { accountRows, fetchTxs } from './src/near/indexer.js';
const A = 'efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af', H = 'd368b0079b34b0700b650eed72417b66467020fde05b8bf8a1fc8a375dc84484';
const F = { a: '85f0680ac65f94793877c17b87b4b526644a4219caee3c56ee47a4570da37129', b: 'e907855c9f35142d29811f286a9d047ded276b6b88eea96c1a9aaa7b01a81632', c: 'c74b910582db56a4d784c56c2ff63e34801a5c3b42be0b0b0f034590468c694c', d: '58d03c8d194b3c39e64e1e949a8a2e8ab85cb365e1bf1178ff5828f4e882adc9', e: 'ff137d9f9206dcf31e63a03255c0d00c0cc8dedc26174c286975971c2c65049a' };
const N1 = '9c0060831c9bd843ed94277b76d8b66393d845a0eec5ccd5d0956f31deee7dc5', N3 = '96eb4cb6d330538588d8f4781df86fcaa52eec6c97c07d6392dbb51868080603';
const edges = [[A, H], ['uixii.near', H], ['woxixi.near', 'uixii.near'], [H, F.a], [H, F.b], [H, F.c], [H, F.d], [H, F.e], [H, N3], [N3, 'cdvve.near'], ['cdvve.near', N1], [N1, 'normalherb1811.near'],
  [F.a, 'deepkingdom2311.near'], [F.a, 'redlemon6015.near'], [F.b, 'weirdglove364.near'], [F.b, 'soliddress8221.near'], [F.c, 'greenmuseum9245.near'], [F.d, 'sharpicon3186.near'], [F.e, 'freejacket4246.near'], ['majorjuice6994.near', 'clearurial9207.near']];
const cache = new Map();
const hist = async (acc) => { if (!cache.has(acc)) { const { rows, count } = await accountRows(acc, { desc: false, maxRows: 120 }); cache.set(acc, { txs: await fetchTxs(rows.map(r => r.hash)), count }); } return cache.get(acc); };
const out = [];
for (const [from, to] of edges) {
  let near = 0, tx = null, ts = null, n = 0;
  for (const side of [to, from]) { const { txs } = await hist(side); for (const t of txs) for (const f of t.inflows) if (f.from === from && f.to === to && f.near > 0.05) { near += f.near; n++; if (!tx) { tx = t.hash; ts = t.ts; } } if (n) break; }
  out.push({ from, to, near: Math.round(near * 100) / 100, n, tx, ts });
  console.log(from.slice(0, 12), '→', to.slice(0, 22), near.toFixed(1), 'NEAR in', n, 'transfers; first', tx, ts && new Date(ts).toISOString().slice(0, 16));
}
// majorjuice: who funded it
const mj = await hist('majorjuice6994.near'); const ins = new Map();
for (const t of mj.txs) for (const f of t.inflows) if (f.to === 'majorjuice6994.near' && f.near >= 5) ins.set(f.from, (ins.get(f.from) || 0) + f.near);
console.log('majorjuice6994.near txs', mj.count, 'funders:', [...ins].map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' | '));
fs.writeFileSync('_edges.json', JSON.stringify(out));
