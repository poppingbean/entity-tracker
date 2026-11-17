// Ontology layer, Stage 0 (docs/ontology-layer-research.md): canonical ids, published vocabularies that cannot drift, and the bulk export formats.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { caip10, didPkh, normalizeId, idScope, accountIri, CAIP2 } from '../src/ontology/caip.js';
import { ORGS, orgInfo } from '../src/ontology/orgs.js';
import { vocabularyTurtle, shapesTurtle, contextJsonLd, NS, classIri, predIri, sourceIri } from '../src/ontology/vocab.js';
import { factQuads, orgQuads, csvRow, CSV_HEADER, oliRows, stixIndicator, stixBundle, uuid5, objectTerm, isLive } from '../src/ontology/export.js';
import { CLASSES, PREDICATES, SOURCE_RANK } from '../src/ontology/classes.js';
import { isEoa } from '../src/ontology/index.js';

const read = (f) => fs.readFileSync(new URL(`../docs/ontology/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('CAIP-10: NEAR accounts and the chains with a checked mapping; anything else is null, never a guess', () => {
  assert.equal(caip10('alice.near'), 'near:mainnet:alice.near');
  assert.equal(caip10('51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'), 'near:mainnet:51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe');
  assert.equal(caip10('eth:0x770b10b273fc44fe9197d6bf20f145c2e98463ee'), 'eip155:1:0x770b10b273fc44fe9197d6bf20f145c2e98463ee');
  assert.equal(caip10('base:0x770b10b273fc44fe9197d6bf20f145c2e98463ee'), 'eip155:8453:0x770b10b273fc44fe9197d6bf20f145c2e98463ee');
  assert.equal(caip10('btc:bc1q05x2asa57q4re28y5w487jx7ausx4ddkw7m5jr'), 'bip122:000000000019d6689c085ae165831e93:bc1q05x2asa57q4re28y5w487jx7ausx4ddkw7m5jr');
  assert.equal(caip10('xrp:rwNhefsz1UQEusxhCvHip3RANinWi4CTck'), 'xrpl:0:rwNhefsz1UQEusxhCvHip3RANinWi4CTck');
  assert.equal(caip10('tron:TBWNguTTgezw9dVorX441C6nDrZpRxYwKD'), 'tron:0x2b6653dc:TBWNguTTgezw9dVorX441C6nDrZpRxYwKD');
  assert.equal(caip10('sol:AffzFDKZbyMiU11zmVBoAqD25ugpr7xoWWyRyGigBEaU'), 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:AffzFDKZbyMiU11zmVBoAqD25ugpr7xoWWyRyGigBEaU');
  assert.equal(caip10('zec:t1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVG'), null, 'Zcash: no CAIP-2 reference was checked');
  assert.equal(caip10('Not A Near Account!'), null);
  assert.equal(caip10(''), null);
  assert.equal(didPkh('alice.near'), 'did:pkh:near:mainnet:alice.near');
  assert.equal(didPkh('zec:t1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVG'), null);
  assert.equal(accountIri('zec:t1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVG'), 'urn:safenear:account:zec%3At1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVG', 'an unmapped chain still gets a stable IRI');
  for (const [k, [ns, ref]] of Object.entries(CAIP2)) assert.match(`${ns}:${ref}`, /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, `${k} is a valid CAIP-2 chain id`);
});

test('ids: a NEAR account is lower case, an EVM address too, an XRP, Tron or Bitcoin address keeps its case (the bug in the old lower-casing)', () => {
  assert.equal(normalizeId(' Alice.NEAR '), 'alice.near');
  assert.equal(normalizeId('eth:0x770B10B273FC44FE9197D6BF20F145C2E98463EE'), 'eth:0x770b10b273fc44fe9197d6bf20f145c2e98463ee');
  assert.equal(normalizeId('xrp:rwNhefsz1UQEusxhCvHip3RANinWi4CTck'), 'xrp:rwNhefsz1UQEusxhCvHip3RANinWi4CTck');
  assert.equal(normalizeId('tron:TBWNguTTgezw9dVorX441C6nDrZpRxYwKD'), 'tron:TBWNguTTgezw9dVorX441C6nDrZpRxYwKD');
  assert.equal(normalizeId('0x770B10B273FC44FE9197D6BF20F145C2E98463EE'), '0x770b10b273fc44fe9197d6bf20f145c2e98463ee', 'a bare 0x… is a NEAR-shaped string here: lower case');
  assert.equal(idScope('alice.near'), 'near');
  assert.equal(idScope('eth:0x1'.padEnd(46, 'a')), 'evm_any_chain_if_eoa');
  assert.equal(idScope('base:0x' + 'a'.repeat(40)), 'one_evm_chain');
  assert.equal(idScope('btc:bc1q05x2asa57q4re28y5w487jx7ausx4ddkw7m5jr'), 'one_chain');
});

test('is_eoa: certain only where the class says so', () => {
  assert.equal(isEoa('person/wallet'), true); assert.equal(isEoa('person/app_user'), true);
  assert.equal(isEoa('person/smart_wallet'), false); assert.equal(isEoa('contract/token'), false);
  assert.equal(isEoa('exchange/hot_wallet'), null); assert.equal(isEoa('unknown'), null);
});

test('organisations: every Wikidata id is a Q-number; none is invented for an organisation that was not looked up', () => {
  for (const [id, o] of Object.entries(ORGS)) { assert.match(id, /^org:[a-z0-9-]+$/); if (o.wikidata) assert.match(o.wikidata, /^Q\d+$/, id); }
  assert.equal(orgInfo('org:binance').same_as, 'https://www.wikidata.org/entity/Q51403327');
  assert.equal(orgInfo('org:near-intents').same_as, null);
  assert.deepEqual(orgInfo('org:unknown-thing'), { id: 'org:unknown-thing', name: 'unknown-thing', same_as: null });
});

test('the published vocabularies are exactly what the code generates (docs/ontology/*), so they cannot drift', () => {
  assert.equal(read('near-ontology.ttl'), vocabularyTurtle(), 'run: node -e "import(\'./src/ontology/vocab.js\').then(v=>require(\'fs\').writeFileSync(\'docs/ontology/near-ontology.ttl\',v.vocabularyTurtle()))"');
  assert.equal(read('near-shapes.ttl'), shapesTurtle());
  assert.equal(read('context.jsonld'), JSON.stringify(contextJsonLd(), null, 1) + '\n');
});

test('the vocabulary covers the whole class tree, every predicate and every source with its rank; the top classes are disjoint', () => {
  const ttl = vocabularyTurtle();
  for (const [top, subs] of Object.entries(CLASSES)) { assert.ok(ttl.includes(`<${classIri(top)}> a owl:Class`), top); for (const s of subs) assert.ok(ttl.includes(`<${classIri(`${top}/${s}`)}> a owl:Class`), `${top}/${s}`); }
  assert.ok(ttl.includes(`<${classIri('unknown')}> a owl:Class`));
  for (const p of PREDICATES) assert.ok(ttl.includes(`<${predIri(p)}> a owl:`), p);
  for (const [s, r] of Object.entries(SOURCE_RANK)) assert.ok(ttl.includes(`<${sourceIri(s)}> a skos:Concept`) && ttl.includes(`"${r}"^^xsd:integer`), s);
  assert.match(ttl, /owl:AllDisjointClasses ; owl:members \( .*class\/person> .*class\/exchange> .*class\/service> .*class\/contract> .*class\/system> \)/);
  const sh = shapesTurtle();
  for (const p of PREDICATES) assert.ok(sh.includes(`<${predIri(p)}>`), `shape lists ${p}`);
  for (const s of Object.keys(SOURCE_RANK)) assert.ok(sh.includes(`<${sourceIri(s)}>`), `shape lists ${s}`);
});

test('the Turtle files are well formed: every prefix used is declared, statements end with a full stop, brackets balance', () => {
  for (const [name, ttl] of [['vocabulary', vocabularyTurtle()], ['shapes', shapesTurtle()]]) {
    const declared = new Set([...ttl.matchAll(/^@prefix (\w+):/gm)].map((m) => m[1]));
    const body = ttl.replace(/^@prefix .*$/gm, '').replace(/"""[\s\S]*?"""/g, '""').replace(/<[^<>\s]*>/g, '<>');
    for (const m of body.matchAll(/(?<![\w<"/#:])(\w+):[A-Za-z]\w*/g)) assert.ok(declared.has(m[1]), `${name}: undeclared prefix ${m[1]} in ${m[0]}`);
    assert.equal((ttl.match(/\[/g) || []).length, (ttl.match(/\]/g) || []).length, `${name}: [ ] balance`);
    assert.equal((ttl.match(/\(/g) || []).length - (ttl.match(/"""[\s\S]*?"""/g) || []).join('').split('(').length + 1, (ttl.match(/\)/g) || []).length - (ttl.match(/"""[\s\S]*?"""/g) || []).join('').split(')').length + 1, `${name}: ( ) balance outside strings`);
    assert.ok(ttl.trimEnd().endsWith('.'), `${name}: the last statement ends with a full stop`);
  }
});

const F = (o) => ({ _id: 'abc123', subject: 'eth:0x770b10b273fc44fe9197d6bf20f145c2e98463ee', predicate: 'flagged', object: 'critical', source: 'public_report', confidence: 0.9, evidence: 'Bitget "attacker"\nline two\\end', by: 'external:bitget-2026-09-24', observed_ts: 1790000000000, valid_from: null, valid_to: null, ...o });
const NQUAD = /^<[^<>"{}|^`\\\s]*> <[^<>"{}|^`\\\s]*> (<[^<>"{}|^`\\\s]*>|"(?:[^"\\\n\r]|\\["\\nrt])*"(\^\^<[^<>\s]*>)?) <[^<>"{}|^`\\\s]*> \.$/;

test('N-Quads: every line is valid, a fact is a typed node with its context, a fact in force is also a plain triple, awkward characters are escaped', () => {
  const lines = factQuads(F({}), 1790000000001);
  for (const l of lines) assert.match(l, NQUAD, l);
  const has = (p, o) => lines.some((l) => l.includes(`<${p}>`) && (o === undefined || l.includes(o)));
  assert.ok(has('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `<${NS}Fact>`));
  assert.ok(has(`${NS}subject`, '<did:pkh:eip155:1:0x770b10b273fc44fe9197d6bf20f145c2e98463ee>'));
  assert.ok(has(`${NS}predicate`, `<${predIri('flagged')}>`));
  assert.ok(has(`${NS}source`, `<${sourceIri('public_report')}>`));
  assert.ok(has(`${NS}confidence`, '"0.9"^^<http://www.w3.org/2001/XMLSchema#decimal>'));
  assert.ok(has(`${NS}evidence`, '\\"attacker\\"\\nline two\\\\end'), 'quotes, newline and backslash escaped');
  assert.ok(has('http://www.w3.org/ns/prov#generatedAtTime', '^^<http://www.w3.org/2001/XMLSchema#dateTime>'));
  const live = lines.filter((l) => l.endsWith(`<${NS}graph/live> .`));
  assert.equal(live.length, 1); assert.ok(live[0].includes(`<${predIri('flagged')}> "critical"`));
  const closed = factQuads(F({ valid_to: 1790000000000 }), 1790000000001);
  assert.equal(closed.filter((l) => l.endsWith(`<${NS}graph/live> .`)).length, 0, 'a closed fact is history only');
  assert.ok(closed.some((l) => l.includes(`<${NS}validTo>`)));
  assert.equal(isLive({ valid_to: null }), true);
});

test('N-Quads: the object term follows the predicate (class, label, boolean, organisation, case, group, account)', () => {
  assert.equal(objectTerm({ predicate: 'is_a', object: 'exchange/hot_wallet' }), `<${NS}class/exchange/hot_wallet>`);
  assert.equal(objectTerm({ predicate: 'label', object: 'NEAR Intents' }), '"NEAR Intents"');
  assert.equal(objectTerm({ predicate: 'pass_through', object: true }), '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>');
  assert.equal(objectTerm({ predicate: 'operated_by', object: 'org:binance' }), `<${NS}org/binance>`);
  assert.equal(objectTerm({ predicate: 'role_in', object: 'inc:abc' }), `<${NS}case/inc:abc>`);
  assert.equal(objectTerm({ predicate: 'funded', object: 'bob.near' }), '<did:pkh:near:mainnet:bob.near>');
  for (const l of orgQuads()) assert.match(l, NQUAD, l);
  assert.ok(orgQuads().some((l) => l.includes('owl#sameAs') && l.includes('wikidata.org/entity/Q51403327')));
});

test('CSV: one row per fact, quotes and commas escaped, the same columns as the header', () => {
  const row = csvRow(F({ evidence: 'a, "b"' }), 1790000000001);
  assert.ok(row.includes('"a, ""b"""'));
  assert.equal(CSV_HEADER.length, 16);
  assert.ok(row.startsWith('eth:0x770b'));
  assert.ok(row.includes('eip155:1:0x770b') && row.includes(',6,') && row.endsWith(',true'), 'caip10, source rank 6, in force');
});

test('OLI rows: is_eoa from the class, the strongest source wins, closed facts and unmapped chains are left out', () => {
  const f = (o) => ({ _id: Math.random().toString(36), source: 'audit', confidence: 0.8, valid_to: null, ...o });
  const rows = oliRows([
    f({ subject: 'bob.near', predicate: 'is_a', object: 'person/wallet' }),
    f({ subject: 'bob.near', predicate: 'is_a', object: 'person/wallet', source: 'behaviour' }),
    f({ subject: 'tok.near', predicate: 'is_a', object: 'contract/token' }), f({ subject: 'tok.near', predicate: 'label', object: 'Tok' }),
    f({ subject: 'hot.near', predicate: 'is_a', object: 'exchange/hot_wallet' }), f({ subject: 'hot.near', predicate: 'operated_by', object: 'org:binance' }),
    f({ subject: 'old.near', predicate: 'is_a', object: 'person/wallet', valid_to: 1 }),
    f({ subject: 'zec:t1WgMdtND8NF7NDUuYmq8MpMj1NTCXkMDVG', predicate: 'is_a', object: 'person/wallet' }),
  ], 1790000000000);
  const by = (a, t) => rows.find((r) => r.address === a && r.tag_id === t);
  assert.equal(by('bob.near', 'is_eoa').tag_value, true); assert.equal(by('bob.near', 'is_eoa').chain_id, 'near:mainnet');
  assert.equal(rows.filter((r) => r.address === 'bob.near' && r.tag_id === 'is_eoa').length, 1, 'one row per account and tag');
  assert.equal(by('bob.near', 'is_eoa').source, 'audit', 'audit beats behaviour');
  assert.equal(by('tok.near', 'is_eoa').tag_value, false); assert.equal(by('tok.near', 'contract_name').tag_value, 'Tok');
  assert.equal(by('hot.near', 'is_eoa'), undefined, 'an exchange wallet: not certain');
  assert.equal(by('hot.near', 'owner_project').tag_value, 'binance');
  assert.equal(by('old.near', 'is_eoa'), undefined, 'a closed fact');
  assert.ok(!rows.some((r) => r.address.startsWith('t1Wg')), 'Zcash has no CAIP-2 id');
});

test('STIX: uuid v5 matches the standard test vector; an indicator carries confidence, validity and a pattern; a closed flag is not exported', () => {
  assert.equal(uuid5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  const i = stixIndicator(F({ valid_to: 1790000900000 }));
  assert.equal(i.type, 'indicator'); assert.equal(i.spec_version, '2.1'); assert.match(i.id, /^indicator--[0-9a-f-]{36}$/);
  assert.equal(i.pattern, "[cryptocurrency-wallet:address = '0x770b10b273fc44fe9197d6bf20f145c2e98463ee']");
  assert.equal(i.confidence, 90); assert.ok(Date.parse(i.valid_until) > Date.parse(i.valid_from));
  assert.equal(stixIndicator(F({ subject: 'evil.near' })).pattern, "[user-account:user_id = 'evil.near']");
  assert.equal(stixIndicator(F({})).id, stixIndicator(F({})).id, 'the same fact gives the same id');
  assert.equal(stixIndicator(F({ subject: "a'b.near" })).pattern, "[user-account:user_id = 'a\\'b.near']");
  const b = stixBundle([F({}), F({ _id: 'x', predicate: 'is_a', object: 'person/wallet' }), F({ _id: 'y', valid_to: 1 })], 1790000000000);
  assert.equal(b.type, 'bundle'); assert.equal(b.objects.length, 1);
});

test('JSON-LD context: it defines the keys of the entity answer', () => {
  const c = contextJsonLd()['@context'];
  assert.ok(c['@vocab'].startsWith(NS));
  for (const k of ['caip10', 'did', 'is_eoa', 'operator_org', 'same_as', 'confidence', 'edges']) assert.ok(k in c, k);
  assert.equal(c.same_as['@type'], '@id');
});
