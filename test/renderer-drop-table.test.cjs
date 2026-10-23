'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

test('xóa bảng hiển thị màn chạy và màn hoàn tất', async () => {
  let finish;
  const requests = [];
  const dialog = { className: '', innerHTML: '', open: false,
    showModal() { this.open = true; }, close() { this.open = false; } };
  const r = loadRenderer({ desktop: { db: { query: (payload) => {
    requests.push(payload);
    return new Promise((resolve) => { finish = resolve; });
  } } }, elements: new Map([['#modal', dialog], ['#status', { textContent: '' }]]) });
  r.evaluate("app.database='sample'; table='items'; confirmAction=async()=>true; selectDatabase=async()=>{};");
  const pending = r.evaluate("dropTableAction('items')");
  await Promise.resolve();
  assert.match(dialog.innerHTML, /Đang xóa bảng/);
  assert.equal(requests[0].sql, 'DROP TABLE `sample`.`items`;');
  finish({ ok: true, data: { kind: 'ok' } });
  await pending;
  assert.match(dialog.innerHTML, /Đã xóa bảng/);
});

test('lỗi khi xóa bảng vẫn hiển thị trong hộp thoại', async () => {
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const r = loadRenderer({ desktop: { db: { query: async () => ({ ok: false, error: { message: 'permission denied' } }) } },
    elements: new Map([['#modal', dialog], ['#status', { textContent: '' }]]) });
  r.evaluate("app.database='sample'; confirmAction=async()=>true;");
  await r.evaluate("dropTableAction('items')");
  assert.match(dialog.innerHTML, /Xóa bảng thất bại/);
  assert.match(dialog.innerHTML, /permission denied/);
});
