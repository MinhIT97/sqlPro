'use strict';

const { readConfig } = require('./config.cjs');
const { openDatabase } = require('./db.cjs');
const { purgeExpiredSessions } = require('./auth.cjs');
const { createApp } = require('./app.cjs');

const config = readConfig();
const db = openDatabase(config.databasePath);
purgeExpiredSessions(db);
const app = createApp({ db, config });

const server = app.listen(config.port, config.host, () => {
  console.log(`[sqlpro-server] listening on http://${config.host}:${config.port}`);
  console.log(`[sqlpro-server] database: ${config.databasePath}`);
});

function shutdown(signal) {
  console.log(`[sqlpro-server] ${signal} received, shutting down`);
  server.close(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
