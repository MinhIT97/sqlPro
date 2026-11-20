'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { nextScheduledAt } = require('./backup-schedule-timing.cjs');
try { parentPort.postMessage({ next: nextScheduledAt(workerData, workerData.now) }); }
catch { parentPort.postMessage({ error: true }); }
