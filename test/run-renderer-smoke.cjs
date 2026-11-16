'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const flags = process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [];
// Compositor captures/resizes add work beyond the interaction-only smoke run.
const timeout = env.SQLPRO_REVIEW_SCREENSHOT_DIR || env.SQLPRO_SCREENSHOT_DIR ? 120000 : 60000;
const result = spawnSync(require('electron'), [...flags, path.join(__dirname, 'renderer-smoke.cjs')], {
  env, encoding: 'utf8', windowsHide: true, timeout
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error.message);
// Windows may report exit code zero even when Electron fails during startup.
process.exit(result.status === 0 && /Renderer smoke: \d+\/\d+ passed/.test(result.stdout || '') ? 0 : 1);
