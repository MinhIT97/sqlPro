'use strict';

const fs = require('node:fs/promises');

async function saveBackupFile(filePath, produce) {
  const temporary = `${filePath}.part-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    const stats = await produce(async (chunk) => handle.writeFile(chunk));
    await handle.sync();
    await handle.close();
    handle = null;
    const temporaryStats = await fs.stat(temporary);
    if (!temporaryStats.isFile() || temporaryStats.size !== stats.bytes) {
      throw new Error('Tệp chưa được ghi đầy đủ. Hãy kiểm tra dung lượng ổ đĩa và thử lại.');
    }
    await fs.rename(temporary, filePath);
    return stats;
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore close error */ }
    }
    try { await fs.unlink(temporary); } catch { /* ignore cleanup error */ }
    throw error;
  }
}

module.exports = { saveBackupFile };
