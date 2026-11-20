// Accounts as the chain creates them (src/ontology/creations.js): the CreateAccount actions of a block, and what a known factory's child is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountsInBlock, classifyCreation, creationsToStore, FACTORIES } from '../src/ontology/creations.js';

const rc = (creator, account, actions, { failed = false, tx = 'T', signer = 'signer.near' } = {}) => ({
  receipt: { receipt_id: 'r-' + account, predecessor_id: creator, receiver_id: account, receipt: { Action: { signer_id: signer, actions } } },
  execution_outcome: { outcome: { status: failed ? { Failure: {} } : { SuccessValue: '' } } }, tx_hash: tx,
});
const block = (...outcomes) => ({ block: { header: { height: 77, timestamp_nanosec: '1790000000000000000' } }, shards: [{ receipt_execution_outcomes: outcomes }] });

test('a block: CreateAccount actions of successful receipts, in either action shape; failed receipts and other actions are left out', () => {
  const b = block(
    rc('poolv1.near', 'good.poolv1.near', ['CreateAccount', { Transfer: { deposit: '1' } }, { DeployContract: { code: 'x' } }]),
    rc('dao.near', 'x.dao.near', [{ CreateAccount: {} }]),
    rc('poolv1.near', 'bad.poolv1.near', ['CreateAccount'], { failed: true }),
    rc('alice.near', 'bob.near', [{ Transfer: { deposit: '1' } }]),
  );
  const got = accountsInBlock(b);
  assert.deepEqual(got.map((c) => [c.account, c.creator]), [['good.poolv1.near', 'poolv1.near'], ['x.dao.near', 'dao.near']]);
  assert.equal(got[0].height, 77); assert.equal(got[0].ts, 1790000000000); assert.equal(got[0].signer, 'signer.near');
  assert.deepEqual(accountsInBlock({}), []); assert.deepEqual(accountsInBlock(null), []);
});

test('what a child of a known factory is: only a sub-account of the factory counts', () => {
  const k = classifyCreation({ account: 'figment.poolv1.near', creator: 'poolv1.near' });
  assert.equal(k.class, 'contract/staking'); assert.equal(k.rule, 'poolv1.near'); assert.match(k.why, /validator staking pool created by the staking pool factory/);
  assert.equal(classifyCreation({ account: 'treasury.sputnik-dao.near', creator: 'sputnik-dao.near' }).class, 'contract/dao');
  assert.equal(classifyCreation({ account: 'fuk.v2-launchpad.justhoot.near', creator: 'v2-launchpad.justhoot.near' }).class, 'contract/token');
  assert.equal(classifyCreation({ account: 'unrelated.near', creator: 'poolv1.near' }), null, 'not a sub-account of the factory');
  assert.equal(classifyCreation({ account: 'x.alice.near', creator: 'alice.near' }), null, 'alice is no factory');
  assert.equal(classifyCreation({ account: 'x.poolv1.near.evil.near', creator: 'evil.near' }), null, 'a name that merely contains the factory is not its child');
  assert.equal(classifyCreation(null), null);
});

test('documents to store: one per factory child, with the class and the reason; nothing for other creations', () => {
  const b = block(rc('sputnik-dao.near', 'club.sputnik-dao.near', ['CreateAccount'], { tx: 'TX1' }), rc('alice.near', 'bob.alice.near', ['CreateAccount']));
  const docs = creationsToStore(b);
  assert.equal(docs.length, 1);
  assert.deepEqual({ ...docs[0] }, { _id: 'club.sputnik-dao.near', creator: 'sputnik-dao.near', signer: 'signer.near', tx: 'TX1', height: 77, ts: 1790000000000, class: 'contract/dao', rule: 'sputnik-dao.near', why: docs[0].why });
});

test('the factory table: every class is a real class of the tree and every key is an account name', async () => {
  const { isClass } = await import('../src/ontology/classes.js');
  for (const [name, f] of Object.entries(FACTORIES)) { assert.ok(isClass(f.cls), `${name}: ${f.cls}`); assert.match(name, /^[a-z0-9._-]+\.near$/); assert.ok(f.what && f.by); }
});
