// MongoDB: the main (and only) database. One connection per process; collections are created on first write.
import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client = null, db = null;

export async function connectDb() {
  if (db) return db;
  client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 30000, maxPoolSize: 10, appName: 'near-entity-tracker' });
  await client.connect();
  db = client.db(config.mongo.dbName);
  await ensureIndexes();
  return db;
}

export const getDb = () => { if (!db) throw new Error('database not connected'); return db; };
export const col = (name) => getDb().collection(name);
export async function closeDb() { try { await client?.close(); } catch {} db = null; client = null; }

async function ensureIndexes() {
  const ix = (c, spec, opts) => db.collection(c).createIndex(spec, opts).catch(() => {});
  await Promise.all([
    ix('tokens', { live_ts: -1 }), ix('tokens', { status: 1, live_ts: 1 }), ix('tokens', { status: 1, ledger_next_ts: 1 }), ix('tokens', { launchpad: 1 }), ix('tokens', { symbol: 1 }),
    ix('trades', { token: 1, ts: 1 }), ix('trades', { trader: 1 }),
    ix('entries', { token: 1, rank: 1 }), ix('entries', { wallet: 1 }), ix('entries', { first_buy_ts: -1 }),
    ix('wallets', { cluster_id: 1 }), ix('wallets', { funder: 1 }), ix('wallets', { is_creator: 1 }), ix('wallets', { 'funders.account': 1 }), ix('wallets', { 'chain.account': 1 }), ix('wallets', { 'flow_out.to': 1 }), ix('wallets', { profiled: 1 }), ix('wallets', { score: -1 }),
    ix('edges', { from: 1 }), ix('edges', { to: 1 }), ix('edges', { type: 1 }),
    ix('clusters', { verdict: 1, score: -1 }), ix('clusters', { size: -1 }), ix('clusters', { updated_ts: -1 }),
    ix('cluster_history', { cluster_id: 1, ts: -1 }),
    ix('entities', { type: 1, funded_n: -1 }), ix('entities', { funded_n: -1 }), ix('entities', { label: 1 }),
    ix('scans', { token: 1, ts: -1 }), ix('scans', { ts: -1 }), ix('scans', { kind: 1, pass: 1, ts: -1 }), ix('followups', { token: 1 }),
    ix('sim_positions', { status: 1, opened_ts: -1 }), ix('sim_positions', { token: 1 }), ix('sim_fills', { position_id: 1, ts: 1 }), ix('sim_equity', { ts: 1 }),
    ix('events', { ts: -1 }), ix('events', { at: 1 }, { expireAfterSeconds: 30 * 86400 }), // log lines expire after 30 days
  ]);
}

export async function metaGet(key, fallback = null) { return (await col('meta').findOne({ _id: key }))?.value ?? fallback; }
export async function metaSet(key, value) { await col('meta').replaceOne({ _id: key }, { _id: key, value, ts: Date.now() }, { upsert: true }); }

/** Upsert many documents (each with its own _id) in batches. */
export async function bulkReplace(collection, docs, batch = 500) {
  for (let i = 0; i < docs.length; i += batch) {
    const part = docs.slice(i, i + batch);
    if (part.length) await col(collection).bulkWrite(part.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
  }
}
