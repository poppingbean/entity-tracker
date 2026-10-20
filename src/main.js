// near-entity-tracker: worker (collect + analyse) and web UI in one process.
//   node src/main.js                 worker + web
//   node src/main.js --web-only      only the UI / API (reads MongoDB)
//   node src/main.js --worker-only   only the background loop (run exactly one of these)
import { config, validateConfig } from './config.js';
import { connectDb, closeDb } from './db.js';
import { enableDbLog, flushLogs, info, error } from './log.js';
import { runWorker, runtime } from './worker.js';
import { startWeb } from './web/server.js';

const webOnly = process.argv.includes('--web-only'), workerOnly = process.argv.includes('--worker-only');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = validateConfig({ needWeb: !workerOnly });
for (const e of errs) error(`config error: ${e}`);
// Never exit just because MongoDB is unreachable or misconfigured: a host would only show "Application failed to respond".
// Serve the UI first (its /api/health says whether the database is connected), then keep trying to connect.
let server = null;
if (!workerOnly) server = startWeb();

let dbReady = false;
const dbUp = (async () => {
  if (errs.length) return;
  for (let i = 0; !runtime.stopping; i++) {
    try { await connectDb(); enableDbLog(); dbReady = true; info(`connected to MongoDB "${config.mongo.dbName}"`); return; }
    catch (e) { error(`MongoDB connection failed: ${e.message.split('\n')[0]} - retrying in 15 s (check MONGODB_URI and the Atlas Network Access list)`); await sleep(15000); }
  }
})();

const stop = async (sig) => {
  if (runtime.stopping) return;
  runtime.stopping = true; info(`${sig}: shutting down`);
  server?.close();
  if (dbReady) { await flushLogs(); await closeDb(); }
  process.exit(0);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('unhandledRejection', (e) => error(`unhandled rejection: ${e?.message || e}`));
process.on('uncaughtException', (e) => error(`uncaught exception: ${e?.message || e}`));

if (webOnly) info('web-only mode: no background work in this process');
else { await dbUp; if (dbReady) await runWorker(); else await new Promise(() => {}); /* config error: stay up and answer health checks */ }
