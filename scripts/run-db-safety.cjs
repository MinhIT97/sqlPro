'use strict';

// Opt-in against disposable loopback servers. Each suite owns its schema/marker.
// The packet server must be started with max_allowed_packet=32768.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const ports = ['SQLPRO_REVIEW_MYSQL_PORT', 'SQLPRO_REVIEW_MARIA_PORT', 'SQLPRO_TEST_PACKET_PORT'];
if (ports.some(name => !/^[0-9]+$/.test(process.env[name] || '') || Number(process.env[name]) < 1 || Number(process.env[name]) > 65535)) {
  console.error('Cần ba cổng database thử: SQLPRO_REVIEW_MYSQL_PORT, SQLPRO_REVIEW_MARIA_PORT, SQLPRO_TEST_PACKET_PORT (server packet 32 KB).');
  process.exit(1);
}
const common = ['restore-safety-mysql', 'data-diff-integration', 'data-diff-service-integration', 'table-search-integration',
  'selection-engines-integration', 'selection-values-integration', 'selection-text-integration', 'selection-temporal-integration',
  'selection-session-policy-integration', 'target-foreign-keys-integration', 'selection-omitted-integration',
  'selection-checks-integration', 'index-visibility-integration', 'explain-formats-integration'];
const portVariables = ['SQLPRO_RESTORE_TEST_PORT', 'SQLPRO_DATA_DIFF_PORT', 'SQLPRO_DIFF_SERVICE_PORT', 'SQLPRO_TABLE_SEARCH_PORT',
  'SQLPRO_TEST_ENGINE_PORT', 'SQLPRO_TEST_VALUE_PORT', 'SQLPRO_TEST_TEXT_PORT', 'SQLPRO_TEST_TEMPORAL_PORT',
  'SQLPRO_TEST_SESSION_PORT', 'SQLPRO_TEST_FK_PORT', 'SQLPRO_TEST_OMITTED_PORT', 'SQLPRO_TEST_CHECKS_PORT', 'SQLPRO_TEST_INDEX_PORT', 'SQLPRO_TEST_EXPLAIN_PORT'];
const results = [];
function run(name, files, additions = {}) {
  const result = spawnSync(process.execPath, ['--test', ...files.map(file => `test/${file}.test.cjs`)], {
    cwd: root, env: { ...process.env, SQLPRO_RESTORE_TEST_SOCKET: '', ...additions }, encoding: 'utf8', timeout: 180000, maxBuffer: 20 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const count = field => Number(new RegExp(`^# ${field} ([0-9]+)$`, 'm').exec(result.stdout || '')?.[1] || 0);
  const passed = result.status === 0 && !result.error && count('tests') > 0 && count('fail') === 0 && count('skipped') === 0;
  results.push({ name, passed, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped') });
  if (!passed) process.exitCode = 1;
}
for (const kind of ['mysql', 'mariadb']) {
  const port = process.env[kind === 'mysql' ? 'SQLPRO_REVIEW_MYSQL_PORT' : 'SQLPRO_REVIEW_MARIA_PORT'];
  const environment = Object.fromEntries(portVariables.map(name => [name, port]));
  environment.SQLPRO_TEST_INDEX_KIND = kind === 'mysql' ? 'mysql-visible' : 'mariadb-ignored';
  environment.SQLPRO_TEST_EXPLAIN_KIND = kind;
  if (kind === 'mysql') environment.SQLPRO_TEST_MYSQL_PORT = port;
  run(kind, kind === 'mysql' ? [...common, 'mysql-integration'] : common, environment);
}
run('schema-sync-regressions-and-encrypted-restore', ['review-nov19-db', 'review-d-db', 'review-e-db', 'review-f-db', 'backup-encrypted-roundtrip']);
run('packet-32kb', ['selection-packets-integration']);
run('sftp-loopback', ['backup-sftp-integration'], { SQLPRO_TEST_SFTP: '1' });
console.log('Data safety matrix: ' + JSON.stringify(results));
