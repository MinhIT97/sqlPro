'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

test('chi tiết backup hiển thị metadata, danh sách đối tượng và escape tên', () => {
  const r = loadRenderer();
  const html = r.evaluate(`backupDetailsHtml({
    id:'20261111000000-1234abcd.sql', name:'Trước cập nhật <script>', bytes:2048,
    createdAt:'2026-11-11T00:00:00Z', source:{database:'sample',serverVersion:'8.0'},
    selection:{includeStructure:true,includeData:true,dropTables:true,tables:['users','<img>'],routines:['rebuild'],events:['daily']},
    result:{tables:2,rows:100}, verification:{checksum:'verified'},checksum:'abc'
  })`);
  for (const value of ['users', '&lt;img&gt;', '&lt;script&gt;', 'rebuild', 'daily', 'sample', '8.0', 'Cấu trúc', 'Dữ liệu', 'Có lệnh DROP', '100 dòng', 'SHA-256: abc']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<script>|<img>/);
  assert.match(html, /data-backup-action="inspect"/);
  assert.equal(r.evaluate('backupDetailsHtml(null)'), '');
  assert.match(r.evaluate(`backupDetailsHtml({id:'old',name:'Old',bytes:1,createdAt:'2026-11-11'})`), /Backup cũ chưa có danh sách/);
});

test('đọc nội dung backup không cập nhật kết quả vào bản vừa chọn khác', async () => {
  let complete;
  const output = { dataset: {}, textContent: '' };
  const r = loadRenderer({
    desktop: { db: { inspectBackup: () => new Promise((resolve) => { complete = resolve; }) } },
    elements: new Map([['#backupInventory', output]])
  });
  r.evaluate("app.selectedBackupId='first'; app.database='db'; app.connection={id:'conn'};");
  const pending = r.evaluate("runBackupManagerAction('inspect')");
  r.evaluate("app.selectedBackupId='second'");
  complete({ tables: [{name:'secret'}], objects: [], statements: 1 });
  await pending;
  assert.doesNotMatch(output.innerHTML, /secret/);
  assert.match(output.innerHTML, /Hủy quét/);
});

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
