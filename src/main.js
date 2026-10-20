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
const errs = validateConfig({ needWeb: !workerOnly });
if (errs.length) { for (const e of errs) console.error(`config error: ${e}`); process.exit(1); }

await connectDb();
enableDbLog();
info(`connected to MongoDB "${config.mongo.dbName}"`);

let server = null;
if (!workerOnly) server = startWeb();

const stop = async (sig) => {
  if (runtime.stopping) return;
  runtime.stopping = true; info(`${sig}: shutting down`);
  server?.close();
  await flushLogs(); await closeDb();
  process.exit(0);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('unhandledRejection', (e) => error(`unhandled rejection: ${e?.message || e}`));

if (webOnly) info('web-only mode: no background work in this process');
else await runWorker();
