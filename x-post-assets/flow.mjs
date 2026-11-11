// Money-flow image for the X thread (5:2, 2000x800). node x-post-assets/flow.mjs -> flow.svg + flow.html
import fs from 'fs';
import path from 'path';
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const W = 2000, H = 800;
const C = { bg: '#0b0f17', panel: '#131a26', line: '#2a3446', text: '#e8edf5', dim: '#8b97ab', red: '#ff5a5f', redDim: '#ff5a5f55', amber: '#f5b041', mono: 'Consolas, "Cascadia Mono", monospace', sans: '"Segoe UI", Arial, sans-serif' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
let s = '';
const box = (x, y, w, h, { stroke = C.line, fill = C.panel, r = 10 } = {}) => { s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`; };
const text = (x, y, t, { size = 15, fill = C.text, weight = 400, font = C.sans, anchor = 'start' } = {}) => { s += `<text x="${x}" y="${y}" font-family='${font}' font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(t)}</text>`; };
const hex2 = (x, y, h, size = 12.5) => { text(x, y, h.slice(0, 32), { size, font: C.mono }); text(x, y + size + 4, h.slice(32), { size, font: C.mono }); }; // full address, wrapped, never cut
const arrow = (x1, y1, x2, y2, { color = C.red, width = 2.5, label = null, lx = null, ly = null, curve = true } = {}) => {
  const mx = (x1 + x2) / 2;
  const d = curve ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` : `M${x1},${y1} L${x2},${y2}`;
  s += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" marker-end="url(#ah)"/>`;
  if (label) { const tx = lx ?? mx, ty = ly ?? (y1 + y2) / 2 - 8; text(tx, ty, label, { size: 13.5, fill: C.text, weight: 600, anchor: 'middle' }); }
};

const ATT = 'efd224256518a7cacd209867963276efed302a8e222c013c43f4b1bd369ae5af';
const HUB = 'd368b0079b34b0700b650eed72417b66467020fde05b8bf8a1fc8a375dc84484';
const F = [['85f0680ac65f94793877c17b87b4b526644a4219caee3c56ee47a4570da37129', '31,716'], ['e907855c9f35142d29811f286a9d047ded276b6b88eea96c1a9aaa7b01a81632', '20,287'], ['42a790dc8319d1487be0c0a5799165bfed7bc81cb48069e8fb60e471f37c8600', '19,720'], ['c74b910582db56a4d784c56c2ff63e34801a5c3b42be0b0b0f034590468c694c', '13,782'], ['58d03c8d194b3c39e64e1e949a8a2e8ab85cb365e1bf1178ff5828f4e882adc9', '9,707'], ['ff137d9f9206dcf31e63a03255c0d00c0cc8dedc26174c286975971c2c65049a', '9,123']];
// [name, NEAR received, funder indexes; -1 = the relay row, -2 = the clearurial row]
const B = [['deepkingdom2311.near', '2,302', [0]], ['redlemon6015.near', '1,717', [0]], ['weirdglove364.near', '4,400', [1, 2]], ['soliddress8221.near', '1,400', [1]], ['greenmuseum9245.near', '1,700', [3]], ['sharpicon3186.near', '1,100', [4]], ['freejacket4246.near', '1,800', [5]], ['normalherb1811.near', '200', [-1]], ['clearurial9207.near', '5,620', [-2]]];
const T = [['$FUK', 'fuk-3.smithii.near'], ['$OLCCL', 'olccl-4.smithii.near'], ['$MEILI', 'meili-5.smithii.near'], ['$MMLI', 'mmli-6.smithii.near'], ['$DABI', 'dabi-7.smithii.near'], ['$SINU', 'sinu-8.smithii.near']];

// title
text(40, 56, 'Binance hot-wallet drain → six NEAR memecoins', { size: 34, weight: 700 });
text(40, 88, 'How the attacker\'s NEAR reached the only real buyers of $FUK $OLCCL $MEILI $MMLI $DABI $SINU · Nov 5–9, 2026', { size: 18, fill: C.dim });

// column 1: the drain
box(30, 290, 210, 100, { stroke: C.line });
text(135, 322, '3 Binance', { size: 17, weight: 700, anchor: 'middle' }); text(135, 344, 'hot wallets', { size: 17, weight: 700, anchor: 'middle' });
text(135, 372, 'emptied Oct 29', { size: 14, fill: C.dim, anchor: 'middle' });
// column 2: attacker
box(290, 290, 270, 100, { stroke: C.red });
text(305, 314, 'ATTACKER', { size: 13, fill: C.red, weight: 700 }); hex2(305, 338, ATT);
text(305, 378, 'received ~12.41M NEAR (~$45.7M)', { size: 13, fill: C.dim });
arrow(240, 340, 290, 340, { width: 4, curve: false });
// column 3: hub
box(640, 290, 270, 100, { stroke: C.red });
text(655, 314, 'HUB', { size: 13, fill: C.red, weight: 700 }); hex2(655, 338, HUB);
text(655, 378, 'sent ~104,300 NEAR on to 6 funders', { size: 13, fill: C.dim });
arrow(560, 340, 640, 340, { width: 5, curve: false, label: '117,197', lx: 600, ly: 326 });
text(600, 364, 'NEAR · Nov 6', { size: 11.5, fill: C.dim, anchor: 'middle' });

// seed path at the top: woxixi.near -> uixii.near -> hub
box(30, 132, 210, 54); text(45, 155, 'woxixi.near', { size: 15, weight: 600, font: C.mono }); text(45, 175, 'cash-out wallet of the drain', { size: 12, fill: C.dim });
box(290, 132, 270, 54); text(305, 155, 'uixii.near', { size: 15, weight: 600, font: C.mono }); text(305, 175, 'seeded the hub the day before', { size: 12, fill: C.dim });
arrow(240, 159, 290, 159, { curve: false, width: 2 });
arrow(560, 159, 775, 290, { width: 2, label: '618 NEAR · Nov 5', lx: 690, ly: 188 });

// column 4: six funders
const fy = (i) => 122 + i * 74;
F.forEach(([h, n], i) => {
  box(1000, fy(i), 280, 66, { stroke: C.redDim });
  hex2(1014, fy(i) + 21, h, 12.5); text(1014, fy(i) + 57, `${n} NEAR from the hub`, { size: 13, fill: C.red, weight: 700 });
  arrow(910, 340, 1000, fy(i) + 33, { width: 1.5 + Math.sqrt(Number(n.replace(',', ''))) / 45 });
});

// relay row: hub -> 96eb… -> cdvve.near -> 9c00… -> normalherb1811.near
const R1 = '96eb4cb6d330538588d8f4781df86fcaa52eec6c97c07d6392dbb51868080603', R3 = '9c0060831c9bd843ed94277b76d8b66393d845a0eec5ccd5d0956f31deee7dc5';
box(560, 584, 240, 50); hex2(573, 605, R1, 12);
box(850, 584, 140, 50); text(920, 614, 'cdvve.near', { size: 15, weight: 600, font: C.mono, anchor: 'middle' });
box(1040, 584, 240, 50); hex2(1053, 605, R3, 12);
arrow(740, 390, 680, 584, { width: 2, label: '608 NEAR · Nov 5', lx: 640, ly: 488 });
arrow(800, 609, 850, 609, { width: 2, curve: false, label: '300', lx: 825, ly: 599 });
arrow(990, 609, 1040, 609, { width: 2, curve: false, label: '300', lx: 1015, ly: 599 });

// clearurial row: attacker -> 24fbd6… -> narrowram4672.near -> clearurial9207.near
const C1 = '24fbd6d8cf1c5344328cfafae979062b1528018c652a72f36d8b9352370bd45e';
box(300, 648, 240, 50); hex2(313, 669, C1, 12);
box(1040, 648, 240, 50); text(1160, 678, 'narrowram4672.near', { size: 15, weight: 600, font: C.mono, anchor: 'middle' });
arrow(400, 390, 420, 648, { width: 2.5, label: '61,006 NEAR · Nov 8', lx: 470, ly: 520 });
arrow(540, 673, 1040, 673, { width: 2, curve: false, label: '10,837 NEAR · Nov 8', lx: 700, ly: 664 });

// column 5: nine buyers
const by = (i) => 122 + i * 50;
B.forEach(([name, n, from], i) => {
  const cy = by(i) + 19;
  box(1390, by(i), 270, 38, { stroke: C.redDim });
  text(1404, by(i) + 25, name, { size: 14.5, weight: 600, font: C.mono }); text(1648, by(i) + 25, n, { size: 13.5, fill: C.red, weight: 700, anchor: 'end' });
  for (const f of from) {
    if (f >= 0) arrow(1280, fy(f) + 33, 1390, cy, { width: 2 });
    else if (f === -1) arrow(1280, 609, 1390, cy, { width: 2, label: '200', lx: 1318, ly: 560 });
    else arrow(1280, 673, 1390, cy, { width: 2, label: '5,620 · Nov 9', lx: 1335, ly: 640 });
  }
  arrow(1660, cy, 1720, 340, { width: 1.5, color: '#ff5a5f99' });
});
text(1525, 112, 'BUYERS · NEAR received', { size: 12.5, fill: C.dim, weight: 700, anchor: 'middle' });
text(1140, 112, 'FUNDERS (fresh accounts)', { size: 12.5, fill: C.dim, weight: 700, anchor: 'middle' });

// column 6: the six tokens
box(1720, 122, 255, 438, { stroke: C.amber });
text(1736, 152, 'BOUGHT: 6 MEMECOINS', { size: 13, fill: C.amber, weight: 700 }); text(1736, 172, 'token contracts on smithii', { size: 12.5, fill: C.dim });
T.forEach(([sym, c], i) => { text(1736, 214 + i * 52, sym, { size: 17, weight: 700 }); text(1736, 234 + i * 52, c, { size: 13.5, font: C.mono, fill: C.text }); });
text(1736, 546, 'creators: suspected, trading link only', { size: 12, fill: C.amber });

// bottom bar
box(30, 714, 1945, 66, { fill: '#1a1013', stroke: C.redDim });
text(52, 757, '99.7%', { size: 30, weight: 800, fill: C.red });
text(160, 744, 'of all buying in these six tokens came from 9 wallets, all of them funded from the attacker.', { size: 17, weight: 600 });
text(160, 767, 'No outside buyers. Every wallet is written out in full. Amounts are NEAR from on-chain transfers. All 22 wallets are flagged in Safety Check.', { size: 14, fill: C.dim });
text(1955, 760, 'TrustFlow', { size: 22, weight: 800, anchor: 'end' });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.red}"/></marker></defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>${s}</svg>`;
fs.writeFileSync(path.join(dir, 'flow.svg'), svg);
fs.writeFileSync(path.join(dir, 'flow.html'), `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:${C.bg};overflow:hidden}</style></head><body>${svg}</body></html>`);
console.log('ok');
