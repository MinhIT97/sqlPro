'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('../server/test/helpers.cjs');

async function run() {
  const context = await startServer({ websiteDir: path.join(__dirname, '../website') });
  const env = { ...process.env, WEBSITE_TEST_URL: context.baseUrl };
  delete env.ELECTRON_RUN_AS_NODE;
  let output = '';
  try {
    const status = await new Promise((resolve, reject) => {
      const flags = process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [];
      const child = spawn(require('electron'), [...flags, path.join(__dirname, 'website-smoke.cjs')], { env, windowsHide: true });
      const timeout = setTimeout(() => child.kill(), 60000);
      child.stdout.on('data', (data) => { output += data; process.stdout.write(data); });
      child.stderr.on('data', (data) => process.stderr.write(data));
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('close', (code) => { clearTimeout(timeout); resolve(code); });
    });
    process.exitCode = status === 0 && /Website smoke: \d+\/\d+ passed/.test(output) ? 0 : 1;
  } finally {
    await context.close();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
