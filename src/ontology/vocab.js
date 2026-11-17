// The ontology as published vocabularies (docs/ontology-layer-research.md, Stage 0). Generated from the code that is the source of truth (the class tree in
// classes.js, the predicates and source ranks), so the published files cannot drift: a test compares them to docs/ontology/*.
//   vocabularyTurtle()  the class tree as SKOS concepts and OWL classes, the predicates as OWL properties, the sources and their ranks
//   shapesTurtle()      SHACL shapes for a fact (what `invalid()` in index.js enforces, in a form any SHACL engine can run)
//   contextJsonLd()     the JSON-LD context of the public entity answer
// Fact nodes in an export (export.js) are typed <NS>Fact and carry the properties declared here.
import { CLASSES, PREDICATES, SOURCE_RANK, SEVERITY } from './classes.js';
import { CLASS_WORDS } from './index.js';

export const NS = 'https://app.safe-near.org/ns/';
export const VERSION = '1';
const I = (path) => `<${NS}${path}>`;
export const classIri = (c) => `${NS}class/${c}`;
export const predIri = (p) => `${NS}pred/${p}`;
export const sourceIri = (s) => `${NS}source/${s}`;
const lit = (s) => `"""${String(s).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""@en`;
const PREFIXES = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
`;

const PRED_DOC = {
  sent_to: 'A case sent money to an address on another chain.', is_a: 'The class of the account (the class tree).', operated_by: 'The organisation behind the account.', label: 'A name for the account.',
  controls: 'The account controls another (an owner, DAO or multisig over a contract).', deployed: 'The account deployed a contract.', created_by: 'The account was created by another.',
  funded: 'The account paid another the money it started with.', swept_to: 'The account sends its balance on to another (a hot wallet to its cold wallet).', solver_for: 'The account fills swaps for a service (a NEAR Intents solver).',
  member_of: 'The account belongs to a group of wallets with one owner.', role_in: 'The account has a role in a case (attacker, victim, cash-out wallet ...).', flagged: 'The account is flagged, with a severity.',
  pass_through: 'Money passes through the account; it never links owners.', trusted: 'A dapp users interact with every day.',
};
const DATATYPE_PREDS = new Set(['label', 'flagged', 'pass_through', 'trusted']);
const SEE_ALSO = { person: 'https://followthemoney.tech/explorer/schemata/CryptoWallet/', exchange: 'https://followthemoney.tech/explorer/schemata/CryptoWallet/' };
const NOTE = { 'person/wallet': 'Open Labels Initiative tag is_eoa = true.', 'person/app_user': 'Open Labels Initiative tag is_eoa = true.', 'person/smart_wallet': 'Open Labels Initiative tag is_eoa = false (an account contract).', contract: 'Open Labels Initiative tag is_eoa = false.' };

export function vocabularyTurtle() {
  const out = [PREFIXES];
  out.push(`${I('')} a owl:Ontology ;
  dcterms:title ${lit('Safe Near ontology of NEAR accounts')} ;
  dcterms:description ${lit('What an account is on NEAR (and the addresses on other chains that touch it): one class tree, the predicates that relate accounts, and the ranked sources of every statement. Generated from the code; see docs/ontology-layer-research.md.')} ;
  owl:versionInfo "${VERSION}" .
${I('class/')} a skos:ConceptScheme ; dcterms:title ${lit('Classes of accounts')} .
${I('class/account')} a owl:Class, skos:Concept ; skos:inScheme ${I('class/')} ; skos:prefLabel ${lit('account')} ; skos:definition ${lit('Any account on NEAR, or an address on another chain.')} .`);
  const tops = Object.keys(CLASSES);
  for (const top of tops) {
    out.push(`<${classIri(top)}> a owl:Class, skos:Concept ; rdfs:subClassOf ${I('class/account')} ; skos:broader ${I('class/account')} ; skos:inScheme ${I('class/')} ; skos:prefLabel ${lit(top)} ; skos:definition ${lit(CLASS_WORDS[top] || top)}${SEE_ALSO[top] ? ` ; rdfs:seeAlso <${SEE_ALSO[top]}>` : ''}${NOTE[top] ? ` ; skos:note ${lit(NOTE[top])}` : ''} .`);
    for (const sub of CLASSES[top]) {
      const id = `${top}/${sub}`;
      out.push(`<${classIri(id)}> a owl:Class, skos:Concept ; rdfs:subClassOf <${classIri(top)}> ; skos:broader <${classIri(top)}> ; skos:inScheme ${I('class/')} ; skos:prefLabel ${lit(sub)} ; skos:definition ${lit(CLASS_WORDS[id] || id)}${NOTE[id] ? ` ; skos:note ${lit(NOTE[id])}` : ''} .`);
    }
  }
  out.push(`<${classIri('unknown')}> a owl:Class, skos:Concept ; rdfs:subClassOf ${I('class/account')} ; skos:inScheme ${I('class/')} ; skos:prefLabel ${lit('unknown')} ; skos:definition ${lit(CLASS_WORDS.unknown || 'not classified yet')} .`);
  out.push(`[] a owl:AllDisjointClasses ; owl:members ( ${tops.map((t) => `<${classIri(t)}>`).join(' ')} ) .`);
  out.push(`${I('Fact')} a owl:Class ; rdfs:label ${lit('Fact')} ; rdfs:comment ${lit('One statement about an account, with where it came from: its subject, predicate, object, ranked source, confidence, evidence, writer and the time it holds.')} .`);
  for (const p of [...PREDICATES].sort()) out.push(`<${predIri(p)}> a ${DATATYPE_PREDS.has(p) ? 'owl:DatatypeProperty' : 'owl:ObjectProperty'} ; rdfs:label ${lit(p)} ; rdfs:comment ${lit(PRED_DOC[p] || p)} .`);
  const props = [['subject', 'ObjectProperty'], ['predicate', 'ObjectProperty'], ['object', 'ObjectProperty'], ['source', 'ObjectProperty'], ['confidence', 'DatatypeProperty'], ['evidence', 'DatatypeProperty'], ['by', 'DatatypeProperty'], ['role', 'DatatypeProperty'], ['status', 'DatatypeProperty'], ['kind', 'DatatypeProperty'], ['validFrom', 'DatatypeProperty'], ['validTo', 'DatatypeProperty'], ['rank', 'DatatypeProperty']];
  for (const [p, t] of props) out.push(`${I(p)} a owl:${t} ; rdfs:label ${lit(p)} .`);
  out.push(`${I('source/')} a skos:ConceptScheme ; dcterms:title ${lit('Sources of a statement, strongest first')} .`);
  for (const [s, r] of Object.entries(SOURCE_RANK).sort((a, b) => b[1] - a[1])) out.push(`<${sourceIri(s)}> a skos:Concept ; skos:inScheme ${I('source/')} ; skos:prefLabel ${lit(s)} ; ${I('rank')} "${r}"^^xsd:integer .`);
  return out.join('\n') + '\n';
}

export function shapesTurtle() {
  const preds = [...PREDICATES].sort().map((p) => `<${predIri(p)}>`).join(' '), sources = Object.keys(SOURCE_RANK).map((s) => `<${sourceIri(s)}>`).join(' ');
  const sev = Object.keys(SEVERITY).map((s) => `"${s}"`).join(', ');
  return `${PREFIXES}
# SHACL shapes for a fact (the rules of invalid() in src/ontology/index.js). Run them over an export together with near-ontology.ttl.
${I('shapes/FactShape')} a sh:NodeShape ; sh:targetClass ${I('Fact')} ;
  sh:property [ sh:path ${I('subject')} ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] ;
  sh:property [ sh:path ${I('predicate')} ; sh:minCount 1 ; sh:maxCount 1 ; sh:in ( ${preds} ) ] ;
  sh:property [ sh:path ${I('object')} ; sh:minCount 1 ; sh:maxCount 1 ] ;
  sh:property [ sh:path ${I('source')} ; sh:minCount 1 ; sh:maxCount 1 ; sh:in ( ${sources} ) ] ;
  sh:property [ sh:path ${I('confidence')} ; sh:maxCount 1 ; sh:datatype xsd:decimal ; sh:minInclusive 0 ; sh:maxInclusive 1 ] ;
  sh:property [ sh:path ${I('by')} ; sh:minCount 1 ; sh:maxCount 1 ; sh:datatype xsd:string ] ;
  sh:property [ sh:path ${I('evidence')} ; sh:maxCount 1 ; sh:datatype xsd:string ] ;
  sh:property [ sh:path ${I('validFrom')} ; sh:maxCount 1 ; sh:datatype xsd:dateTime ] ;
  sh:property [ sh:path ${I('validTo')} ; sh:maxCount 1 ; sh:datatype xsd:dateTime ] ;
  sh:sparql [ a sh:SPARQLConstraint ; sh:message "an is_a fact's object must be a class of the tree (load near-ontology.ttl with the data)" ;
    sh:select """SELECT $this ?value WHERE { $this <${NS}predicate> <${predIri('is_a')}> ; <${NS}object> ?value . FILTER NOT EXISTS { ?value a <http://www.w3.org/2002/07/owl#Class> } }""" ] ;
  sh:sparql [ a sh:SPARQLConstraint ; sh:message "a role_in fact needs a role" ;
    sh:select """SELECT $this WHERE { $this <${NS}predicate> <${predIri('role_in')}> . FILTER NOT EXISTS { $this <${NS}role> ?r } }""" ] ;
  sh:sparql [ a sh:SPARQLConstraint ; sh:message "a flagged fact's object must be a severity (${Object.keys(SEVERITY).join(', ')})" ;
    sh:select """SELECT $this ?value WHERE { $this <${NS}predicate> <${predIri('flagged')}> ; <${NS}object> ?value . FILTER (?value NOT IN (${sev})) }""" ] ;
  sh:sparql [ a sh:SPARQLConstraint ; sh:message "a fact that ends (validTo) cannot end before it starts (validFrom)" ;
    sh:select """SELECT $this WHERE { $this <${NS}validFrom> ?a ; <${NS}validTo> ?b . FILTER (?b < ?a) }""" ] .
`;
}

/** The JSON-LD context of GET /api/v1/entity: the answer's keys get global meaning; the answer's own `@id` is the account's did:pkh. */
export function contextJsonLd() {
  return {
    '@context': {
      '@vocab': `${NS}entity#`, ns: NS, owl: 'http://www.w3.org/2002/07/owl#', xsd: 'http://www.w3.org/2001/XMLSchema#', prov: 'http://www.w3.org/ns/prov#',
      caip10: { '@id': `${NS}caip10` }, did: { '@id': `${NS}did` }, id_scope: { '@id': `${NS}idScope` }, is_eoa: { '@id': `${NS}isEoa`, '@type': 'xsd:boolean' },
      confidence: { '@id': `${NS}confidence`, '@type': 'xsd:decimal' }, source: { '@id': `${NS}source` }, evidence: { '@id': `${NS}evidence` }, why: { '@id': `${NS}why` },
      pass_through: { '@id': `${NS}pred/pass_through`, '@type': 'xsd:boolean' }, trusted: { '@id': `${NS}pred/trusted`, '@type': 'xsd:boolean' }, flagged: { '@id': `${NS}pred/flagged` },
      operator_org: { '@id': `${NS}pred/operated_by` }, same_as: { '@id': 'owl:sameAs', '@type': '@id' }, name: { '@id': 'http://www.w3.org/2000/01/rdf-schema#label' },
      edges: { '@id': `${NS}edges` }, cases: { '@id': `${NS}cases` }, groups: { '@id': `${NS}groups` }, overruled: { '@id': `${NS}overruled` },
    },
  };
}
