'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.join(__dirname, 'renderer-smoke.cjs')], {
  env, encoding: 'utf8', windowsHide: true, timeout: 60000
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error.message);
// Windows may report exit code zero even when Electron fails during startup.
process.exit(result.status === 0 && /Renderer smoke: \d+\/\d+ passed/.test(result.stdout || '') ? 0 : 1);
