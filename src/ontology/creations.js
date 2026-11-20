// Accounts as the chain creates them (the ontology layer's forward path, docs/ontology-layer-research.md section 5, "coverage"): every block the deploy watcher
// already reads is scanned for CreateAccount actions. A sub-account (`x.parent.near`) can only be created by its parent, so who created an account is a chain fact;
// when the creator is a known factory, what the account is follows from the factory (a staking pool, a DAO, a launchpad token), and the ontology learns it the moment it exists.
//   accountsInBlock(b)        pure: the CreateAccount actions of successful receipts in one neardata block
//   classifyCreation(c)       pure: { class, why, rule } when the creator is a known factory, else null
// The watcher stores them (collection `account_creations`); the writer `account_creations` (backfill.js) turns them into facts, like every other writer.

/** Factories and what the accounts they create are. Every entry is a contract that creates `<name>.<factory>` sub-accounts and deploys one kind of contract into them. */
export const FACTORIES = {
  'poolv1.near': { cls: 'contract/staking', what: 'a validator staking pool', by: 'the staking pool factory' },
  'pool.near': { cls: 'contract/staking', what: 'a validator staking pool', by: 'the staking pool factory' },
  'sputnik-dao.near': { cls: 'contract/dao', what: 'a DAO', by: 'the Sputnik DAO factory' },
  'tkn.near': { cls: 'contract/token', what: 'a token', by: 'the tkn.near token factory' },
  'nearlytrade.near': { cls: 'contract/token', what: 'a token', by: 'the Nearly.trade launchpad' },
  'v2-launchpad.justhoot.near': { cls: 'contract/token', what: 'a token', by: 'the Justhoot v2 launchpad' },
  'launchpad.justhoot.near': { cls: 'contract/token', what: 'a token', by: 'the Justhoot launchpad' },
  'meme-cooking.near': { cls: 'contract/token', what: 'a token', by: 'the Meme.cooking launchpad' },
  'factory.bridge.near': { cls: 'contract/token', what: 'a bridged token', by: 'the Rainbow bridge token factory' },
  'omft.near': { cls: 'contract/token', what: 'a NEAR Intents bridged token', by: 'the Intents token factory' },
};

const isCreate = (a) => a === 'CreateAccount' || (a && typeof a === 'object' && a.CreateAccount !== undefined);

/** The accounts created in one neardata block: [{ account, creator, signer, tx, receipt, height, ts }]. Failed receipts are left out. */
export function accountsInBlock(b) {
  const out = [], height = b?.block?.header?.height, ts = Number(b?.block?.header?.timestamp_nanosec) / 1e6;
  for (const s of b?.shards || []) for (const ro of s.receipt_execution_outcomes || []) {
    const rc = ro.receipt, act = rc?.receipt?.Action;
    if (!act || ro.execution_outcome?.outcome?.status?.Failure) continue;
    if (!(act.actions || []).some(isCreate)) continue;
    out.push({ account: rc.receiver_id, creator: rc.predecessor_id, signer: act.signer_id || null, tx: ro.tx_hash || null, receipt: rc.receipt_id || null, height, ts });
  }
  return out;
}

/** What an account is, from who created it. Only a sub-account of the factory counts (`x.poolv1.near`): the factory itself is the only account that can create it. */
export function classifyCreation(c) {
  const f = FACTORIES[c?.creator];
  if (!f || !c.account || !c.account.endsWith(`.${c.creator}`)) return null;
  return { class: f.cls, rule: c.creator, why: `${f.what} created by ${f.by} (${c.creator})` };
}

/**
 * Store the creations of known factories in a batch of blocks and tell the ontology at once (writers.js syncFacts). Never throws: the watcher's own work comes first.
 * Returns how many accounts were recorded.
 */
export async function recordCreations(blocks) {
  const docs = blocks.flatMap(creationsToStore);
  if (!docs.length) return 0;
  const { col } = await import('../db.js');
  await col('account_creations').bulkWrite(docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
  await (await import('./writers.js')).syncFacts(['account_creations'], { scope: { account_creations: { ids: docs.map((d) => d._id) } } });
  return docs.length;
}

/** The documents to store for a block: creations by a known factory, with the class they imply. */
export const creationsToStore = (b) => accountsInBlock(b).map((c) => ({ c, k: classifyCreation(c) })).filter((x) => x.k).map(({ c, k }) => ({ _id: c.account, creator: c.creator, signer: c.signer, tx: c.tx, height: c.height, ts: c.ts, class: k.class, rule: k.rule, why: k.why }));
