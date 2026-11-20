// External cases (src/incident/external.js): the case files are valid, the facts come out right, and the other-chain addresses are recognised.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateExternal, docFrom, factsOf, ROLES, EXTERNAL_PREFIX, BY } from '../src/incident/external.js';
import { detectChainAddress, chainId } from '../src/ontology/chains.js';

const dir = new URL('../src/incident/external/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const load = (f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));

test('every case file in the repository is valid', () => {
  assert.ok(files.length >= 2, 'the Bitget and Bybit files are there');
  for (const f of files) assert.deepEqual(validateExternal(load(f)), [], f);
});

test('a case file is refused when it lacks sources, a time, an address chain, a role or the Intents note', () => {
  const ok = load('bitget-2026-09-24.json');
  const bad = (m) => validateExternal(m(structuredClone(ok)));
  assert.ok(bad((d) => { d.sources = []; return d; }).some((p) => /sources/.test(p)));
  assert.ok(bad((d) => { d.started_utc = 'yesterday'; return d; }).some((p) => /started_utc/.test(p)));
  assert.ok(bad((d) => { d.addresses[0].chain = 'nochain'; return d; }).some((p) => /unknown chain/.test(p)));
  assert.ok(bad((d) => { d.addresses[0].role = 'hero'; return d; }).some((p) => /role must be/.test(p)));
  assert.ok(bad((d) => { d.addresses[0].source = 'ghost'; return d; }).some((p) => /not in sources/.test(p)));
  assert.ok(bad((d) => { d.addresses[0].confidence = 1; return d; }).some((p) => /confidence/.test(p)));
  assert.ok(bad((d) => { d.addresses.push({ ...d.addresses[0] }); return d; }).some((p) => /listed twice/.test(p)));
  assert.ok(bad((d) => { delete d.intents.checked; return d; }).some((p) => /intents.checked/.test(p)), 'say what was looked at even when nothing was found');
  assert.ok(bad((d) => { d.status = 'suspected'; return d; }).some((p) => /confirmed/.test(p)), 'only confirmed public cases');
});

test('facts: one role_in per address; only the attacker-side roles are flagged; a victim is not', () => {
  const d = load('bybit-2025-02-21.json'), f = factsOf(d, 1000), id = EXTERNAL_PREFIX + d.id;
  const roleIn = f.filter((x) => x.predicate === 'role_in'), flagged = f.filter((x) => x.predicate === 'flagged');
  assert.equal(roleIn.length, d.addresses.length);
  assert.ok(roleIn.every((x) => x.object === id && x.by === BY(d.id) && x.source === 'public_report' && x.status === 'confirmed'));
  const victim = chainId('eth', '0x1Db92e2EeBC8E0c075a02BeA49a2935BcD2dFCF4');
  assert.ok(roleIn.some((x) => x.subject === victim && x.role === 'victim'));
  assert.ok(!flagged.some((x) => x.subject === victim), 'the victim wallet is never flagged');
  assert.equal(flagged.length, d.addresses.filter((a) => ROLES[a.role].flag).length);
  assert.ok(flagged.every((x) => x.object === 'critical' && x.case === id && /FBI|dfns|DFNS|attacker|contract|wallet/.test(x.evidence)));
  assert.ok(roleIn.every((x) => /https?:\/\//.test(x.evidence)), 'every fact carries its source link');
});

test('the Bitget case: the four published addresses are the attacker\'s, the Intents depositor is flagged, the BTC recipient is only high', () => {
  const d = load('bitget-2026-09-24.json'), f = factsOf(d, 1000);
  const by = (addr) => f.filter((x) => x.subject === detectChainAddress(addr));
  for (const a of ['0x770b10b273fc44fe9197d6bf20f145c2e98463ee', 'rwNhefsz1UQEusxhCvHip3RANinWi4CTck', 't1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVG', 'TBWNguTTgezw9dVorX441C6nDrZpRxYwKD']) {
    assert.equal(by(a).find((x) => x.predicate === 'role_in')?.role, 'attacker', a);
    assert.equal(by(a).find((x) => x.predicate === 'flagged')?.object, 'critical', a);
  }
  assert.equal(by('rN9kDsMB1butehgX6shJ5diekvZ4aZaQfn').find((x) => x.predicate === 'role_in')?.role, 'intents_depositor');
  assert.equal(by('bc1q05x2asa57q4re28y5w487jx7ausx4ddkw7m5jr').find((x) => x.predicate === 'flagged')?.object, 'high');
  assert.match(by('bc1q05x2asa57q4re28y5w487jx7ausx4ddkw7m5jr').find((x) => x.predicate === 'role_in').evidence, /never received/);
});

test('the Bitget case records what the Intents team did, with figures, and says what was not found', () => {
  const doc = docFrom(load('bitget-2026-09-24.json'), 5);
  assert.equal(doc._id, 'ext:bitget-2026-09-24');
  assert.deepEqual([doc.intents.blocked_usd, doc.intents.processed_usd, doc.intents.frozen_usd], [50000000, 166000, 503000]);
  assert.equal(doc.intents.orders.length, 1);
  assert.equal(doc.intents.orders[0].status, 'FAILED');
  assert.equal(doc.intents.orders[0].near_txs.length, 3);
  assert.match(doc.intents.checked, /only the 173,819 XRP order was found/);
  assert.ok(doc.intents.statements[0].by.includes('NEAR Intents'));
  assert.equal(doc.other_freezes[0].usd, 318013);
  assert.equal(doc.fingerprint, docFrom(load('bitget-2026-09-24.json'), 99).fingerprint, 'the fingerprint ignores the load time');
});

test('the Bybit case: the 51 FBI addresses, no Intents activity claimed', () => {
  const d = load('bybit-2025-02-21.json');
  const fbi = d.addresses.filter((a) => a.source === 'fbi');
  assert.equal(fbi.length, 51);
  assert.equal(new Set(fbi.map((a) => a.address.toLowerCase())).size, 51);
  assert.ok(fbi.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address) && a.role === 'laundering_wallet'));
  assert.equal(d.intents.activity, 'none found');
  assert.deepEqual(d.intents.orders, []);
  assert.ok(!/PENDING/.test(d.intents.checked), 'the Intents check is finished before the file is loaded');
});

test('other-chain addresses are recognised, and no NEAR input is mistaken for one', () => {
  assert.equal(detectChainAddress('rwNhefsz1UQEusxhCvHip3RANinWi4CTck'), 'xrp:rwNhefsz1UQEusxhCvHip3RANinWi4CTck');
  assert.equal(detectChainAddress('TBWNguTTgezw9dVorX441C6nDrZpRxYwKD'), 'tron:TBWNguTTgezw9dVorX441C6nDrZpRxYwKD');
  assert.equal(detectChainAddress('t1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVG'), 'zec:t1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVG');
  assert.equal(detectChainAddress('0x770B10B273FC44FE9197D6BF20F145C2E98463EE'), 'eth:0x770b10b273fc44fe9197d6bf20f145c2e98463ee', 'EVM ids are lower case');
  for (const near of ['alice.near', 'rabcdefghijklmnopqrstuvwxyz', 't1abcdefghijklmnopqrstuvwxyzabcdefg', '7kiXdCNg6uhiaTsvZZrE5Nj9MBFqzycEdpGKYB8fCkpn', 'a'.repeat(64)]) assert.equal(detectChainAddress(near), null, near);
});

test('the Binance case: the FBI list, 608 Ethereum + 19 Bitcoin + 1 Solana, all distinct, with its caveats written down', () => {
  const d = load('binance-2026-10-29.json');
  const by = (c) => d.addresses.filter((a) => a.chain === c);
  assert.deepEqual([by('eth').length, by('btc').length, by('sol').length], [608, 19, 1]);
  assert.equal(new Set(d.addresses.map((a) => a.address.toLowerCase())).size, 628);
  assert.ok(by('eth').every((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address)));
  assert.ok(d.addresses.every((a) => a.role === 'laundering_wallet' && a.source === 'fbi'));
  assert.ok(d.notes.some((n) => /could not be opened/.test(n)), 'says the FBI page was not read directly');
  assert.ok(d.notes.some((n) => /inc:efd224/.test(n)), 'points at the NEAR case');
});

test('screening: a swap whose recipient or origin address is on a hack list raises an alert; NEAR and unknown chains are ignored', async () => {
  const { swapAddresses, listedAlert } = await import('../src/incident/screen.js');
  const sw = { deposit_address: 'a'.repeat(64), status: 'SUCCESS', origin_asset: 'nep141:eth.omft.near', destination_asset: 'nep141:btc.omft.near', recipient: 'bc1q05x2asa57q4re28y5w487jx7ausx4ddkw7m5jr', refund_to: '0x770B10B273FC44FE9197D6BF20F145C2E98463EE', amount_in_usd: 250000 };
  assert.deepEqual(swapAddresses(sw), [{ id: 'btc:bc1q05x2asa57q4re28y5w487jx7ausx4ddkw7m5jr', side: 'recipient' }, { id: 'eth:0x770b10b273fc44fe9197d6bf20f145c2e98463ee', side: 'origin' }]);
  assert.deepEqual(swapAddresses({ origin_asset: 'nep141:wrap.near', destination_asset: 'nep141:wrap.near', recipient: 'alice.near', refund_to: 'bob.near' }), [], 'NEAR addresses are not screened');
  const listed = { flagged: { severity: 'critical', reason: 'an attacker address in the Bitget hack' }, roles: [{ case: 'ext:bitget-2026-09-24', role: 'attacker' }] };
  const known = (id) => (id.startsWith('eth:0x770b') ? listed : { flagged: null, roles: [] });
  const a = listedAlert(sw, known);
  assert.equal(a.key, `listed:${sw.deposit_address}`);
  assert.match(a.title, /bitget-2026-09-24 hack used NEAR Intents/);
  assert.match(a.text, /paid in from eth:0x770b/);
  assert.match(a.text, /lead, not proof/);
  assert.equal(listedAlert(sw, () => ({ flagged: null, roles: [] })), null, 'nothing listed, no alert');
  assert.equal(listedAlert(sw, () => ({ flagged: { severity: 'high', reason: 'x' }, roles: [{ case: 'inc:abc' }] })), null, 'a flag from a NEAR case is not a hack-list hit');
});
