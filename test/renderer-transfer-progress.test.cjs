'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

test('backup hiển thị màn tiến trình và số dòng đã ghi', () => {
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const detail = { textContent: '' };
  const size = { textContent: '' };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog], ['#transferDetail', detail], ['#transferSize', size],
    ['#transferBar', { value: 0 }], ['#modal [data-transfer-running]', { dataset: { transferRunning: 'backup' } }]
  ]) });
  r.evaluate("showTransferProgress('backup', 'sample')");
  r.evaluate("updateTransferProgress({ operation: 'backup', rows: 1200, objects: 3, bytes: 4096 })");
  assert.match(dialog.innerHTML, /Đang sao lưu database/);
  assert.match(detail.textContent, /1[,.]200 dòng/);
  assert.match(size.textContent, /4\.0 KB/);
});

test('restore cập nhật phần trăm theo dung lượng tệp', () => {
  const bar = { value: 0 };
  const detail = { textContent: '' };
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog],
    ['#modal [data-transfer-running]', { dataset: { transferRunning: 'restore' } }],
    ['#transferDetail', detail], ['#transferSize', { textContent: '' }], ['#transferBar', bar]
  ]) });
  r.evaluate("showTransferProgress('restore', 'sample')");
  r.evaluate("updateTransferProgress({ operation: 'restore', executed: 10, bytes: 50, totalBytes: 200 })");
  assert.equal(bar.value, 25);
  assert.match(detail.textContent, /10 câu lệnh/);
});

test('export hiển thị số dòng và dung lượng đã ghi', () => {
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const detail = { textContent: '' };
  const size = { textContent: '' };
  const step = { textContent: '' };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog],
    ['#modal [data-transfer-running]', { dataset: { transferRunning: 'export' } }],
    ['#transferDetail', detail], ['#transferSize', size], ['#transferBar', { value: 0 }],
    ['#taskCurrentStep', step]
  ]) });
  r.evaluate("showTransferProgress('export', 'sample.users')");
  r.evaluate("updateTransferProgress({ operation: 'export', rows: 1200, bytes: 4096, format: 'csv' })");
  assert.match(dialog.innerHTML, /Đang xuất dữ liệu/);
  assert.match(detail.textContent, /1[,.]200 dòng đã xuất/);
  assert.equal(size.textContent, 'Đã ghi 4.0 KB');
  assert.equal(step.textContent, '● Đang ghi tệp');
});

test('import hiển thị dòng đọc, ghi, trùng và phần trăm theo dung lượng tệp', () => {
  const bar = { value: 0 };
  const detail = { textContent: '' };
  const size = { textContent: '' };
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog],
    ['#modal [data-transfer-running]', { dataset: { transferRunning: 'import' } }],
    ['#transferDetail', detail], ['#transferSize', size], ['#transferBar', bar],
    ['#taskCurrentStep', { textContent: '' }]
  ]) });
  r.evaluate("showTransferProgress('import', 'sample.users', { taskId: 'task-i', profileId: 'profile-i' })");
  r.evaluate("updateTransferProgress({ operation: 'import', taskId: 'task-i', profileId: 'profile-i', rows: 500, written: 480, committed: 450, duplicates: 20, bytes: 50, totalBytes: 200, transaction: 'batch' })");
  assert.equal(bar.value, 25);
  assert.match(detail.textContent, /500 dòng đã đọc · 450 đã ghi · 20 trùng/);
  assert.equal(size.textContent, '50 B / 200 B');
  r.evaluate("updateTransferProgress({ operation: 'import', taskId: 'task-i', profileId: 'profile-i', rows: 600, written: 600, committed: 0, duplicates: 0, bytes: 100, totalBytes: 200, transaction: 'all' })");
  assert.equal(bar.value, 50);
  assert.match(detail.textContent, /600 dòng đã đọc · 600 đã ghi$/);
});

test('bỏ qua tiến trình của task hoặc profile khác', () => {  const detail = { textContent: '' };
  const size = { textContent: '' };
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog],
    ['#modal [data-transfer-running]', { dataset: { transferRunning: 'backup' } }],
    ['#transferDetail', detail], ['#transferSize', size], ['#transferBar', { value: 0 }]
  ]) });
  r.evaluate("showTransferProgress('backup', 'sample', { taskId: 'task-a', profileId: 'profile-a' })");
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'task-b', profileId: 'profile-a', rows: 5, bytes: 10 })");
  assert.equal(detail.textContent, '');
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'task-a', profileId: 'profile-b', rows: 5, bytes: 10 })");
  assert.equal(detail.textContent, '');
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'task-a', profileId: 'profile-a', rows: 5, bytes: 10 })");
  assert.match(detail.textContent, /5 dòng/);
});

test('nút hủy gửi đúng profileId và taskId', async () => {
  const calls = [];
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const r = loadRenderer({
    desktop: {
      db: {
        cancelTask: async (profileId, taskId) => {
          calls.push({ profileId, taskId });
          return { ok: true, data: { canceled: true } };
        }
      }
    },
    elements: new Map([['#modal', dialog]])
  });
  r.evaluate("showTransferProgress('backup', 'sample', { taskId: 'task-x', profileId: 'profile-x' })");
  await r.evaluate('cancelActiveTransfer()');
  assert.deepEqual(calls, [{ profileId: 'profile-x', taskId: 'task-x' }]);
  assert.match(r.messages.at(-1).message, /Đã yêu cầu hủy tác vụ/);
});
