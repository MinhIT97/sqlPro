'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

test('trang Backups hiển thị danh sách và bật thao tác khi chọn bản sao lưu', () => {
  const workspace = { innerHTML: '' };
  const r = loadRenderer({ elements: new Map([['#workspace', workspace]]) });
  r.evaluate(`app.database='sample'; app.backups=[{
    id:'20261023120000-1234abcd.sql', name:'20261023120000',
    bytes:2048, createdAt:'2026-10-23T12:00:00.000Z'
  }]; renderBackupsView();`);
  assert.match(workspace.innerHTML, /20261023120000/);
  assert.match(workspace.innerHTML, /2\.0 KB/);
  assert.match(workspace.innerHTML, /data-backup-action="restore" disabled/);
  assert.match(workspace.innerHTML, /data-backup-action="copy-backup" disabled/);
  assert.match(workspace.innerHTML, /data-backup-action="paste-backup" disabled/);
  assert.match(workspace.innerHTML, /data-backup-action="copy-to-db" disabled/);
  r.evaluate("app.selectedBackupId='20261023120000-1234abcd.sql'; renderBackupsView();");
  assert.doesNotMatch(workspace.innerHTML, /data-backup-action="restore" disabled/);
  assert.doesNotMatch(workspace.innerHTML, /data-backup-action="copy-backup" disabled/);
  assert.doesNotMatch(workspace.innerHTML, /data-backup-action="copy-to-db" disabled/);
  assert.match(workspace.innerHTML, /backup-row selected/);

  // Test copySelectedBackupToClipboard enables paste-backup
  r.evaluate("copySelectedBackupToClipboard('20261023120000-1234abcd.sql'); renderBackupsView();");
  assert.doesNotMatch(workspace.innerHTML, /data-backup-action="paste-backup" disabled/);
});

test('menu chuột phải của backup có thao tác phục hồi và xuất SQL', () => {
  const r = loadRenderer();
  const itemMenu = r.evaluate('backupContextMenuHtml(true)');
  assert.match(itemMenu, /data-backup-menu="restore"/);
  assert.match(itemMenu, /data-backup-menu="copy-backup"/);
  assert.match(itemMenu, /data-backup-menu="copy-to-db"/);
  assert.match(itemMenu, /data-backup-menu="export"/);
  assert.match(itemMenu, /data-backup-menu="folder"/);
  const groupMenu = r.evaluate('backupContextMenuHtml(false)');
  assert.doesNotMatch(groupMenu, /data-backup-menu="delete"/);
  assert.doesNotMatch(groupMenu, /data-backup-menu="copy-backup"/);
  assert.doesNotMatch(groupMenu, /data-backup-menu="copy-to-db"/);
  assert.match(groupMenu, /data-backup-menu="create"/);
});
