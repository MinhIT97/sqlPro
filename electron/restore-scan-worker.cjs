'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSession } = require('./database.cjs');

const cancelFlag = new Int32Array(workerData.cancelFlag);
const task = { get canceled() { return Atomics.load(cancelFlag, 0) === 1; } };

async function scan() {
  try {
    const session = new DatabaseSession({});
    const result = await session.scanRestoreInventory({
      filePath: workerData.filePath,
      database: workerData.database,
      totalBytes: workerData.totalBytes,
      dropExisting: workerData.dropExisting,
      readChunkBytes: 1024 * 1024,
      task,
      onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress })
    });
    parentPort.postMessage({ type: 'done', result });
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      error: {
        message: error.message,
        code: error.code,
        partial: error.partial,
        schema: error.schema,
        table: error.table,
        statementNumber: error.statementNumber
      }
    });
  }
}

void scan();
