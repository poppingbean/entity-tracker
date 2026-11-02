// Automated contract audit: classification from exports and the power inventory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyContract, standardsOf } from '../src/audit/classify.js';
import { powerInventory, unknownWrites } from '../src/audit/powers.js';

const FT = ['ft_transfer', 'ft_transfer_call', 'ft_total_supply', 'ft_balance_of', 'ft_metadata', 'storage_deposit', 'storage_balance_of', 'new'];
const NFT = ['nft_transfer', 'nft_transfer_call', 'nft_token', 'nft_tokens_for_owner', 'nft_metadata', 'nft_approve', 'nft_revoke', 'nft_payout', 'nft_mint', 'new'];

test('classify: standards and role are separate; a protocol role wins over the token standard', () => {
  assert.deepEqual(standardsOf(NFT).sort(), ['nep171', 'nep178', 'nep199']);
  assert.equal(classifyContract(FT).role, 'token');
  assert.equal(classifyContract(NFT).role, 'nft');
  const lst = classifyContract([...FT, 'deposit_and_stake', 'unstake', 'withdraw_unstaked', 'epoch_stake', 'get_st_near_price']);
  assert.equal(lst.role, 'liquid_staking');
  assert.ok(lst.standards.includes('nep141'));
  assert.equal(classifyContract(['deposit_and_stake', 'get_reward_fee_fraction', 'on_stake_action', 'vote', 'unstake_all', 'new']).role, 'staking_pool');
  assert.equal(classifyContract(['add_liquidity', 'remove_liquidity', 'get_pools', 'swap', 'ft_on_transfer', 'withdraw']).role, 'amm');
  assert.equal(classifyContract(['add_proposal', 'act_proposal', 'get_policy', 'new']).role, 'dao');
  assert.equal(classifyContract(['new', 'add_public_key', 'contract_source_metadata']).role, 'account');
  assert.equal(classifyContract(['__contract']).role, 'unknown', 'a JS contract has too few exports');
  assert.equal(classifyContract(FT, { knownRole: 'token' }).confidence, 'high');
});

test('classify: a half match is no role (a token with a liquidity callback is not an AMM)', () => {
  assert.equal(classifyContract([...FT, 'on_dcl_liquidity_added', 'swap_undistributed_tokens', 'repay_dcl_storage_loan']).role, 'token');
});

test('powers: the same method is judged by the contract role', () => {
  const tokenP = powerInventory([...FT, 'mint', 'pause', 'add_to_blacklist', 'upgrade', 'set_owner'], 'token');
  assert.deepEqual(tokenP.filter((p) => p.severity === 'high').map((p) => p.power).sort(), ['freeze', 'mint', 'upgrade']);
  const bridge = powerInventory(['finish_deposit', 'force_withdraw', 'pa_pause_feature', 'pa_is_paused'], 'bridge');
  assert.equal(bridge.find((p) => p.power === 'move_user_funds').severity, 'medium');
  assert.equal(bridge.find((p) => p.power === 'move_user_funds').normal_for_role, true);
  assert.deepEqual(bridge.find((p) => p.power === 'freeze').methods, ['pa_pause_feature'], 'pa_is_paused is a view');
  const meme = powerInventory([...FT, 'force_withdraw'], 'token');
  assert.equal(meme.find((p) => p.power === 'move_user_funds').severity, 'critical');
  const wallet = powerInventory(['new', 'add_public_key'], 'account');
  assert.equal(wallet[0].power, 'account_control');
});

test('powers: NFT owner powers (mint, metadata, royalties, freeze), the fake-storage backdoor, unknown writes', () => {
  const p = powerInventory([...NFT, 'set_base_uri', 'set_royalties', 'pause_transfers'], 'nft');
  const by = Object.fromEntries(p.map((x) => [x.power, x.severity]));
  assert.deepEqual(by, { metadata_control: 'high', freeze: 'high', mint: 'medium', royalty_control: 'medium' });
  const hp = powerInventory(FT, 'token', { fakeStorage: ['storage_unstake'] });
  assert.equal(hp[0].power, 'move_user_funds');
  assert.deepEqual(hp[0].methods, ['storage_unstake']);
  const std = new Set(FT);
  assert.deepEqual(unknownWrites([...FT, 'adjust_user', 'get_thing', 'on_done'], powerInventory([...FT, 'adjust_user'], 'token'), std), ['adjust_user']);
  assert.equal(powerInventory([...FT, 'claim_fees', 'withdraw_fee'], 'token').length, 0, 'claiming or withdrawing fees is not a power');
});

test('findings: a power is judged by who holds it; flagged owners and deployers; backdoors are critical', async () => {
  const { auditFindings } = await import('../src/audit/findings.js');
  const code = { role: 'token', powers: powerInventory([...FT, 'mint', 'upgrade'], 'token'), source: null };
  const wallet = auditFindings({ code, control: { full_keys: 0, controllers: [{ account: 'dev.near', kind: 'wallet', via: 'owner', flags: [] }] } });
  assert.equal(wallet.level, 'high');
  const dao = auditFindings({ code, control: { full_keys: 0, controllers: [{ account: 'x.sputnik-dao.near', kind: 'dao', via: 'owner', flags: [] }, { account: 'g.near', kind: 'wallet', via: 'guardians', flags: [] }] } });
  assert.equal(dao.level, 'medium', 'a DAO owner governs; a guardian wallet does not change that');
  assert.match(dao.findings[0].detail, /owned by a DAO/);
  const rugger = auditFindings({ code, control: { full_keys: 0, controllers: [{ account: 'rug.near', kind: 'wallet', via: 'owner', flags: ['on the dev-rug blacklist'] }] } });
  assert.equal(rugger.level, 'critical');
  assert.ok(rugger.findings.some((f) => f.key === 'flagged_owner'));
  const dep = auditFindings({ code: { role: 'token', powers: [] }, deploy: { deployer: 'lp.near', deployer_flags: ['rug.near: created 3 tokens, 3 rugged'] } });
  assert.match(dep.findings.find((f) => f.key === 'flagged_deployer').title, /rug\.near/);
  const honeypot = auditFindings({ code: { role: 'token', powers: powerInventory(FT, 'token', { fakeStorage: ['storage_unstake'] }), fake_storage: ['storage_unstake'] } });
  assert.equal(honeypot.level, 'critical');
  assert.equal(honeypot.findings.filter((f) => /storage_unstake/.test(f.detail)).length, 1, 'reported once');
  const plain = auditFindings({ code: { role: 'token', powers: [], source: { link: 'https://github.com/x/y' } }, control: { full_keys: 0, controllers: [] } });
  assert.equal(plain.level, 'low');
});

test('wasm capabilities: host calls reached from each export; SDK promise dispatchers are not entered', async () => {
  const { capabilitiesFromWat } = await import('../src/audit/wasm.js');
  const wat = [
    '(module',
    '  (import "env" "predecessor_account_id" (func $env.predecessor_account_id (type $t0)))',
    '  (import "env" "promise_batch_action_deploy_contract" (func $env.promise_batch_action_deploy_contract (type $t0)))',
    '  (import "env" "promise_batch_action_transfer" (func $env.promise_batch_action_transfer (type $t0)))',
    '  (import "env" "promise_batch_action_add_key_with_full_access" (func $env.promise_batch_action_add_key_with_full_access (type $t0)))',
    '  (import "env" "promise_batch_action_delete_account" (func $env.promise_batch_action_delete_account (type $t0)))',
    '  (func $upgrade (export "upgrade") (type $t0)', '    call $check_owner', '    call $env.promise_batch_action_deploy_contract)',
    '  (func $check_owner (type $t0)', '    call $env.predecessor_account_id)',
    '  (func $claim (export "claim") (type $t0)', '    call $env.promise_batch_action_add_key_with_full_access)',
    '  (func $ft_transfer_call (export "ft_transfer_call") (type $t0)', '    call $check_owner', '    call $run_actions)',
    '  (func $run_actions (type $t0)', '    call $env.promise_batch_action_transfer', '    call $env.promise_batch_action_deploy_contract', '    call $env.promise_batch_action_delete_account)',
    '  (func $mint (export "mint") (type $t0)', '    nop)',
    '  (table $T0 1 1 funcref))',
  ].join('\n');
  const c = capabilitiesFromWat(wat);
  assert.deepEqual(c.upgrade.caps, ['deploy_code', 'reads_caller']);
  assert.deepEqual(c.claim.caps, ['add_full_access_key']);
  assert.deepEqual(c.ft_transfer_call.caps, ['generic_promise', 'reads_caller'], 'the generic action runner is not entered');
  assert.deepEqual(c.mint.caps, []);
  const { auditFindings } = await import('../src/audit/findings.js');
  const r = auditFindings({ code: { role: 'token', powers: powerInventory([...FT, 'mint', 'upgrade'], 'token'), capabilities: { claim: c.claim, upgrade: c.upgrade, mint: { caps: [], dynamic: false } } } });
  assert.ok(r.findings.some((f) => f.key === 'hidden_power' && /claim adds a full-access key/.test(f.title)));
  assert.ok(r.findings.some((f) => f.key === 'unguarded_power' && /^mint/.test(f.title)), 'mint never reads the caller');
  assert.ok(!r.findings.some((f) => f.key === 'unguarded_power' && /^upgrade/.test(f.title)));
});

test('AI findings: kept only with evidence the pipeline can check; never critical (rules decide that)', async () => {
  const { verifiedFindings } = await import('../src/ai/tools/verify.js');
  const out = verifiedFindings([
    { severity: 'critical', title: 'Owner can wipe balances', detail: 'x', evidence: 'set_balance' },
    { severity: 'high', title: 'Invented method', detail: 'x', evidence: 'drain_everything' },
    { severity: 'medium', title: 'Fee up to 100 %', detail: 'x', evidence: 'fee must be below 10000' },
    { severity: 'low', title: 'No evidence', detail: 'x' },
  ], { exports: ['set_balance', 'ft_transfer'], strings: ['panicked: fee must be below 10000 bps'] });
  assert.deepEqual(out.map((f) => [f.title, f.severity]), [['Owner can wipe balances', 'high'], ['Fee up to 100 %', 'medium']]);
  assert.ok(out.every((f) => f.ai && f.key === 'ai_finding'));
});

test('deploy watcher: deploys in a block, from successful action receipts only', async () => {
  const { deploysInBlock } = await import('../src/audit/watcher.js');
  const rc = (id, receiver, actions, failed = false) => ({ receipt: { receipt_id: id, receiver_id: receiver, predecessor_id: 'factory.near', receipt: { Action: { signer_id: 'dev.near', actions } } }, execution_outcome: { outcome: { status: failed ? { Failure: {} } : { SuccessValue: '' } } } });
  const block = { block: { header: { height: 7, timestamp_nanosec: '1000000000000' } }, shards: [{ receipt_execution_outcomes: [
    rc('r1', 'tok.factory.near', ['CreateAccount', { Transfer: { deposit: '1' } }, { UseGlobalContract: { contract_identifier: { AccountId: 'tpl.near' } } }]),
    rc('r2', 'x.near', [{ DeployContract: { code: 'AGFzbQ==' } }], true),
    rc('r3', 'y.near', [{ FunctionCall: { method_name: 'ft_transfer' } }]),
    rc('r4', 'w.craft.tg', [{ UseGlobalContractByAccountId: { account_id: 'trading-zone-gc.tg' } }]),
  ] }] };
  const d = deploysInBlock(block);
  assert.deepEqual(d.map((x) => [x.account, x.kind, x.created]), [['tok.factory.near', 'UseGlobalContract', true], ['w.craft.tg', 'UseGlobalContractByAccountId', false]]);
  assert.equal(d[0].signer, 'dev.near');
  assert.equal(d[0].ts, 1000000);
});

test('function review: views, calls, callbacks and risks from what the code can do', async () => {
  const { describeFunctions } = await import('../src/audit/functions.js');
  const f = Object.fromEntries(describeFunctions(['get', 'register', 'on_claim', 'new', 'withdraw', 'upgrade'], {
    get: { effects: ['reads_state', 'writes_state', 'returns'] }, register: { effects: ['writes_state', 'reads_deposit'] }, on_claim: { effects: ['callback', 'writes_state'] },
    new: { effects: ['writes_state'] }, withdraw: { effects: ['writes_state', 'send_near', 'reads_caller'] }, upgrade: { effects: ['deploy_code', 'reads_caller'] } }).map((x) => [x.method, x]));
  assert.equal(f.get.kind, 'view'); assert.equal(f.get.risk, 'none');
  assert.equal(f.register.kind, 'call'); assert.equal(f.register.risk, 'low');
  assert.equal(f.on_claim.kind, 'callback');
  assert.equal(f.new.kind, 'setup');
  assert.equal(f.withdraw.risk, 'medium'); assert.ok(f.withdraw.does.includes('sends NEAR out'));
  assert.equal(f.upgrade.risk, 'high'); assert.ok(f.upgrade.does.includes('can replace contract code'));
});
