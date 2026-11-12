// NFT Collectibles listing collections from the deploy watcher (src/nft/sync.js): which platform a deploy belongs to, and what is synced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformOfDeploy, ingestable } from '../src/nft/sync.js';

test('a deploy by HOT Craft or near.cooking is one of their collections', () => {
  assert.equal(platformOfDeploy({ account: 'gnom2017.nfts.tg', by: 'nfts.tg', signer: 'x.craft.tg' }), 'hotcraft');
  // near.cooking creates a collection with its own key, no method call: the deploy watcher still sees it
  assert.equal(platformOfDeploy({ account: 'cosmickats.nft.cookon.near', by: 'nft.cookon.near', signer: 'nft.cookon.near' }), 'cookon');
  assert.equal(platformOfDeploy({ account: 'jollycrates.dnft.cookon.near', by: 'dnft.cookon.near' }), 'cookon');
  assert.equal(platformOfDeploy({ account: 'jollycrates.dnft.cookon.near' }), 'cookon', 'by its name when the deployer is not known');
  assert.equal(platformOfDeploy({ account: 'nft.cookon.near', by: 'nft.cookon.near' }), null, 'the factory itself is not a collection');
  assert.equal(platformOfDeploy({ account: 'fuk-3.smithii.near', by: 'smithii.near' }), null);
});

test('a collection found from its deploy is synced like the platforms\' ones (unless it is spam)', () => {
  assert.equal(ingestable({ source: 'deploy' }), true);
  assert.equal(ingestable({ source: 'deploy', spam: true }), false);
  assert.equal(ingestable({ source: 'hotcraft' }), true);
  assert.equal(ingestable({ source: 'nearblocks', nb: { transfers_day: 0 } }), false, 'unchanged: an idle NearBlocks listing is not mined');
});
