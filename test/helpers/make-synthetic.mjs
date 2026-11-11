// Regenerates the SYNTHETIC fixtures in test/fixtures/tx/ (built by hand from the shapes the parsers expect). Replace each one with a real
// capture: node src/cli.js fixture-tx <hash> <name> --note "<what it is>". A real capture is never overwritten by this script.
import fs from 'node:fs';
import { rawTx, ev, fc, xfer } from './synth.js';
import { fixtureDoc } from '../../src/near/fixture.js';

const T = 'blackdragon.tkn.near', Y = '1000000000000000000000000';
const HEX = 'a'.repeat(64);
const out = {};
const add = (name, note, tx) => { out[name] = fixtureDoc({ name, note, hash: tx.transaction.hash, tx, synthetic: true, ts: 1794300000000 }); };
const refv2 = (hash, a, b) => rawTx({ hash, signer: 'trader.near', receiver: 'v2.ref-finance.near', actions: [fc('ft_transfer_call')], receipts: [{ pred: 'trader.near', recv: 'v2.ref-finance.near', logs: [`Swapped ${a} for ${b}, total fee 3, admin fee 1`] }] });
add('refv2-sell-wnear', 'Ref v2 sell: the log ends in ", total fee N, admin fee N"', refv2('S1', `1000000000 ${T}`, `${Y} wrap.near`));
add('refv2-buy-wnear', 'Ref v2 buy', refv2('S2', `${Y} wrap.near`, `1000000000 ${T}`));
add('refv2-swap-msg-poolid', 'a Ref v2 swap whose ft_transfer_call message names the pool id', rawTx({ hash: 'S3', signer: 'trader.near', receiver: 'wrap.near',
  actions: [fc('ft_transfer_call', { receiver_id: 'v2.ref-finance.near', amount: Y, msg: JSON.stringify({ actions: [{ pool_id: 4276, token_in: 'wrap.near', token_out: T, amount_in: Y, min_amount_out: '1' }] }) })],
  receipts: [{ pred: 'trader.near', recv: 'v2.ref-finance.near', logs: [`Swapped ${Y} wrap.near for 1000000000 ${T}, total fee 3, admin fee 1`] }] }));
const dclEv = (swapper) => ev('dcl.ref', 'swap', [{ pool_id: `${T}|wrap.near|10000`, token_in: 'wrap.near', amount_in: Y, token_out: T, amount_out: '1000000000', swapper }]);
add('dcl-swap', 'a Ref DCL swap by the trader itself', rawTx({ hash: 'S4', signer: 'bob.near', receiver: 'dclv2.ref-labs.near', actions: [fc('ft_transfer_call')], receipts: [{ pred: 'bob.near', recv: 'dclv2.ref-labs.near', logs: [dclEv('bob.near')] }] }));
add('dcl-swap-via-aggregator', 'a DCL swap whose swapper is the aggregator: the trader is the signer', rawTx({ hash: 'S5', signer: 'carol.near', receiver: 'aggregatedex.near', actions: [fc('ft_transfer_call')], receipts: [{ pred: 'aggregatedex.near', recv: 'dclv2.ref-labs.near', logs: [dclEv('aggregatedex.near')] }] }));
add('launch-nearlytrade', 'a nearly.trade launch event', rawTx({ hash: 'S6', signer: 'dev.near', receiver: 'nearlytrade.near', actions: [fc('launch')],
  receipts: [{ pred: 'dev.near', recv: 'nearlytrade.near', logs: [ev('nearpad', 'launch', [{ id: '1', token: 'moon-1.nearlytrade.near', pool_id: 'moon-1.nearlytrade.near|wrap.near|10000', creator: 'dev.near', name: 'Moon', symbol: 'MOON' }])] }] }));
add('launch-justhoot', 'a justhoot meme_launched event', rawTx({ hash: 'S7', signer: 'dev.near', receiver: 'launchpad.justhoot.near', actions: [fc('launch_meme', { args: { name: 'Hoot', symbol: 'HOOT' } })],
  receipts: [{ pred: 'dev.near', recv: 'launchpad.justhoot.near', logs: [ev('hoot_launcher', 'meme_launched', { token_id: 'hoot.launchpad.justhoot.near', creator_id: 'dev.near', quote_token_id: 'wrap.near', dev_buy_quote: Y })] }] }));
add('launch-memecooking', 'a meme.cooking create_token event with a pool id', rawTx({ hash: 'S8', signer: 'dev.near', receiver: 'meme-cooking.near', actions: [fc('create_token')],
  receipts: [{ pred: 'dev.near', recv: 'meme-cooking.near', logs: [ev('meme-cooking', 'create_token', { token_id: 'cook-1.meme-cooking.near', meme_id: 7, pool_id: 99 })] }] }));
add('launch-tkn', 'a create_token call on tkn.near', rawTx({ hash: 'S9', signer: 'dev.near', receiver: 'tkn.near', actions: [fc('create_token', { args: { owner_id: 'dev.near', metadata: { name: 'Dragon', symbol: 'DRAGON' } } })], receipts: [{ pred: 'dev.near', recv: 'tkn.near' }] }));
add('ft-transfer-wallet-to-wallet', 'a plain token transfer between two wallets', rawTx({ hash: 'S10', signer: 'bob.near', receiver: T, actions: [fc('ft_transfer')],
  receipts: [{ pred: 'bob.near', recv: T, logs: [ev('nep141', 'ft_transfer', [{ old_owner_id: 'bob.near', new_owner_id: 'dave.near', amount: '500000000' }])] }] }));
add('intents-native-withdraw', 'a NEAR Intents withdrawal to another chain', rawTx({ hash: 'S11', signer: 'solver.near', receiver: 'intents.near', actions: [fc('execute_intents')],
  receipts: [{ pred: 'solver.near', recv: 'intents.near', logs: [ev('dip4', 'ft_withdraw', [{ account_id: 'acct1', token: 'eth.omft.near', receiver_id: 'bridge.near', amount: '1000', memo: 'WITHDRAW_TO:0xabc' }])] }] }));
add('oneclick-deposit', 'a NEAR transfer to a 1Click deposit address (64 hex)', rawTx({ hash: 'S12', signer: 'victim.near', receiver: HEX, actions: [xfer('50' + '0'.repeat(24))], receipts: [{ pred: 'victim.near', recv: HEX, actions: [xfer('50' + '0'.repeat(24))] }] }));
add('near-transfer-large', 'a plain NEAR transfer from an exchange hot wallet', rawTx({ hash: 'S13', signer: 'hot.near', receiver: 'fresh.near', actions: [xfer('123456000000000000000000000')], receipts: [{ pred: 'hot.near', recv: 'fresh.near', actions: [xfer('123456000000000000000000000')] }] }));
add('failed-tx', 'a failed transaction', rawTx({ hash: 'S14', signer: 'bob.near', receiver: T, actions: [fc('ft_transfer')], failed: true,
  receipts: [{ pred: 'bob.near', recv: T, logs: [ev('nep141', 'ft_transfer', [{ old_owner_id: 'bob.near', new_owner_id: 'dave.near', amount: '1' }])] }] }));
add('nft-transfer', 'a NEP-171 transfer', rawTx({ hash: 'S15', signer: 'bob.near', receiver: 'art.near', actions: [fc('nft_transfer')],
  receipts: [{ pred: 'bob.near', recv: 'art.near', logs: [ev('nep171', 'nft_transfer', [{ old_owner_id: 'bob.near', new_owner_id: 'dave.near', token_ids: ['7'] }])] }] }));
fs.mkdirSync(new URL('../fixtures/tx/', import.meta.url), { recursive: true });
for (const [name, doc] of Object.entries(out)) {
  const f = new URL(`../fixtures/tx/${name}.json`, import.meta.url);
  if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).synthetic === false) continue; // never overwrite a real capture
  fs.writeFileSync(f, JSON.stringify(doc, null, 1) + '\n');
}
console.log(Object.keys(out).length, 'fixtures');
