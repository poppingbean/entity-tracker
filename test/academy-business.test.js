// The Academy's business (src/academy/business.js) and the agent's signer (src/near/sign.js): the pure parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { orderAmounts, matchOrder, splitShares, costUsd, extraCalls, grant, payoutPolicy, payoutTx, transferKind, notReady, paymentsIn, withoutOwnTokenRisk } from '../src/academy/business.js';
import { keyPair, encodeTransaction, signTransaction, base58Decode } from '../src/near/sign.js';
import { decodeBorsh, base58 } from '../src/firewall/decode.js';

const R = { enabled: true, treasury: 'academy.sputnik-dao.near', usdc: 'usdc.near', reserve_account: 'ai-reserve.near', contributors: ['a.near', 'b.near'], limits: { max_usd_per_payout: 25, max_usd_per_day: 50 } };

test('an order\'s amounts carry its number in the smallest units', () => {
  const a = orderAmounts(1, 2.5, 7);
  assert.equal(a.usdc_raw, '1000007');                       // $1 + 7 micro-USDC
  assert.equal(a.near_yocto, (4000n * 10n ** 20n + 7n).toString()); // $1 / $2.5 = 0.4 NEAR, + 7 yocto
  assert.equal(orderAmounts(3, 0, 1).near_yocto, null);       // no NEAR price: no NEAR amount
  assert.throws(() => orderAmounts(0, 1, 1)); assert.throws(() => orderAmounts(1, 1, 1000));
});

test('a payment matches its order by the exact amount, or by memo for USDC', () => {
  const orders = [{ _id: 'o1', status: 'open', usdc_raw: '1000007', near_yocto: '400000000000000000000007', ref_code: 'SN-7' }, { _id: 'o2', status: 'paid', usdc_raw: '3000009' }];
  assert.equal(matchOrder(orders, { currency: 'usdc', raw: '1000007' })._id, 'o1');
  assert.equal(matchOrder(orders, { currency: 'near', raw: '400000000000000000000007' })._id, 'o1');
  assert.equal(matchOrder(orders, { currency: 'usdc', raw: '1000008' }), null);           // one micro-USDC off
  assert.equal(matchOrder(orders, { currency: 'usdc', raw: '1200000', memo: 'SN-7' })._id, 'o1'); // memo + paid at least the price
  assert.equal(matchOrder(orders, { currency: 'usdc', raw: '900000', memo: 'SN-7' }), null);      // memo but short
  assert.equal(matchOrder(orders, { currency: 'usdc', raw: '3000009' }), null);            // already paid
});

test('the split: the reserve, the contributors in equal parts, the treasury keeps the rest', () => {
  const s = splitShares('1000001', { reserve: 0.5, contributors: 0.3, treasury: 0.2 }, { reserveAccount: 'r.near', contributors: ['a.near', 'b.near'] });
  assert.deepEqual(s, [{ role: 'reserve', to: 'r.near', raw: '500000' }, { role: 'contributor', to: 'a.near', raw: '150000' }, { role: 'contributor', to: 'b.near', raw: '150000' }, { role: 'treasury', to: null, raw: '200001' }]);
  assert.equal(s.reduce((t, x) => t + BigInt(x.raw), 0n), 1000001n); // nothing lost to rounding
  assert.deepEqual(splitShares('100', { reserve: 0.5, contributors: 0.3 }, {}), [{ role: 'treasury', to: null, raw: '100' }]); // no payees: all kept
});

test('AI cost and the extra calls the reserve buys', () => {
  const inf = { usd_per_million_input_tokens: 0.15, usd_per_million_output_tokens: 0.6, usd_per_ai_call: 0.002, max_extra_ai_calls_per_day: 200 };
  assert.equal(costUsd({ prompt: 2e6, completion: 1e6 }, inf), 0.9);
  assert.equal(extraCalls(0.1, inf), 50);
  assert.equal(extraCalls(100, inf), 200);
  assert.equal(extraCalls(-5, inf), 0);
});

test('a purchase grants a certificate or extends a pass', () => {
  const now = 1e12, DAY = 86400e3;
  assert.equal(grant({}, 'exam_certificate', 30, now).certificates, 1);
  assert.equal(grant({}, 'training_pass', 30, now).training_until, now + 30 * DAY);
  assert.equal(grant({ dataset_until: now + DAY }, 'dataset_pass', 30, now).dataset_until, now + 31 * DAY); // stacks on a pass still running
  assert.throws(() => grant({}, 'gold', 30, now));
});

test('payouts: the guard\'s policy, the transaction it checks, the DAO proposal', () => {
  const p = payoutPolicy(R);
  assert.deepEqual(p.allowed_receivers, ['usdc.near', 'ai-reserve.near', 'a.near', 'b.near']);
  assert.equal(p.max_usd_per_tx, 25); assert.deepEqual(p.block_on, ['block', 'warn']);
  assert.deepEqual(payoutTx(R, { to: 'a.near', currency: 'near', raw: '5' }), { signer_id: R.treasury, receiver_id: 'a.near', actions: [{ Transfer: { deposit: '5' } }] });
  assert.equal(payoutTx(R, { to: 'a.near', currency: 'usdc', raw: '5' }).actions[0].FunctionCall.args.receiver_id, 'a.near');
  assert.deepEqual(transferKind(R, { to: 'a.near', currency: 'usdc', raw: '5' }), { Transfer: { token_id: 'usdc.near', receiver_id: 'a.near', amount: '5', msg: null } });
  assert.equal(transferKind(R, { to: 'a.near', currency: 'near', raw: '5' }).Transfer.token_id, '');
});

test('the business does not run when off, paused or without a treasury', () => {
  assert.equal(notReady(R), null);
  assert.match(notReady({ ...R, enabled: false }), /off/);
  assert.match(notReady(R, { paused: true }), /paused/);
  assert.match(notReady({ ...R, treasury: '' }), /treasury/);
});

test('payments into the treasury are read from a raw transaction: NEAR receipts and USDC events', () => {
  const t = {
    transaction: { hash: 'H' },
    receipts: [
      { receipt: { receiver_id: R.treasury, predecessor_id: 'buyer.near', receipt: { Action: { actions: [{ Transfer: { deposit: '400000000000000000000007' } }] } } }, execution_outcome: { outcome: { executor_id: R.treasury, logs: [], status: { SuccessValue: '' } } } },
      { receipt: { receiver_id: R.treasury, predecessor_id: 'system', receipt: { Action: { actions: [{ Transfer: { deposit: '99' } }] } } }, execution_outcome: { outcome: { executor_id: R.treasury, logs: [], status: {} } } }, // a gas refund
      { receipt: { receiver_id: 'usdc.near', predecessor_id: 'buyer.near', receipt: { Action: { actions: [] } } }, execution_outcome: { outcome: { executor_id: 'usdc.near', status: { SuccessValue: '' }, logs: [
        'EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: 'buyer.near', new_owner_id: R.treasury, amount: '1000007', memo: 'SN-7' }, { old_owner_id: 'buyer.near', new_owner_id: 'other.near', amount: '5' }] })] } } },
      { receipt: { receiver_id: 'fake.near', predecessor_id: 'x.near', receipt: { Action: { actions: [] } } }, execution_outcome: { outcome: { executor_id: 'fake.near', status: {}, logs: [
        'EVENT_JSON:' + JSON.stringify({ standard: 'nep141', event: 'ft_transfer', data: [{ old_owner_id: 'x.near', new_owner_id: R.treasury, amount: '1000007' }] })] } } }, // a fake token's event: not USDC
    ],
  };
  const p = paymentsIn(t, R.treasury, 'usdc.near');
  assert.deepEqual(p.map((x) => [x.currency, x.raw, x.from, x.memo ?? null]), [['near', '400000000000000000000007', 'buyer.near', null], ['usdc', '1000007', 'buyer.near', 'SN-7']]);
  assert.equal(new Set(p.map((x) => x.id)).size, 2);
});

test('the signer: a function-call transaction the firewall decodes, signed so the signature verifies', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const kp = keyPair('ed25519:' + base58(Buffer.concat([seed, pub])));
  assert.equal(kp.publicKey, 'ed25519:' + base58(pub));
  assert.equal(keyPair('ed25519:' + base58(seed)).publicKey, kp.publicKey); // the 32-byte seed form too
  assert.ok(Buffer.from(base58Decode(base58(pub))).equals(pub));
  assert.throws(() => keyPair('ed25519:' + base58(Buffer.concat([seed, Buffer.alloc(32, 1)]))), /does not match/);
  assert.throws(() => keyPair('secp256k1:abc'));
  const tx = encodeTransaction({ signerId: 'agent.near', publicKey: kp.pub, nonce: 7n, receiverId: R.treasury, blockHash: Buffer.alloc(32, 9), calls: [{ method: 'act_proposal', args: { id: 3, action: 'VoteApprove' }, gas: '200000000000000' }] });
  const { signed, hash } = signTransaction(tx, kp);
  const d = decodeBorsh(signed.toString('base64'));
  assert.equal(d.format, 'signed_transaction'); assert.equal(d.signer, 'agent.near'); assert.equal(d.receiver, R.treasury);
  assert.deepEqual(d.actions.map((a) => [a.kind, a.method, a.args.id, String(a.deposit ?? '0')]), [['function_call', 'act_proposal', 3, '0']]);
  assert.ok(verify(null, createHash('sha256').update(tx).digest(), publicKey, signed.subarray(tx.length + 1)));
  assert.equal(hash, base58(createHash('sha256').update(tx).digest()));
});

test('the guard ignores only "the rules\' own USDC is a high-risk contract", never a finding about the recipient', () => {
  const U = 'usdc.near';
  const own = { severity: 'high', code: 'risky_contract', title: `${U} is a high-risk contract` };
  const bad = { severity: 'critical', code: 'flagged', title: 'payee.near: received the money drained from …' };
  assert.deepEqual(withoutOwnTokenRisk({ verdict: 'warn', findings: [own] }, U), { verdict: 'ok', findings: [] });
  assert.deepEqual(withoutOwnTokenRisk({ verdict: 'block', findings: [own, bad] }, U), { verdict: 'block', findings: [bad] });
  const other = { severity: 'high', code: 'risky_contract', title: 'other.near is a high-risk contract' };
  const c = { verdict: 'warn', findings: [other] };
  assert.equal(withoutOwnTokenRisk(c, U), c); // another contract's risk stays
});
