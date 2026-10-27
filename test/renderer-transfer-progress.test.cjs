'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

test('backup hiển thị màn tiến trình và số dòng đã ghi', () => {
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const workspace = { innerHTML: '' };
  const detail = { textContent: '' };
  const size = { textContent: '' };
  const bar = { value: 0 };
  const percent = { textContent: '' };
  const currentObject = { textContent: '', title: '' };
  const log = { innerHTML: '', scrollHeight: 100, scrollTop: 0, clientHeight: 100 };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog], ['#workspace', workspace], ['#transferDetail', detail], ['#transferSize', size],
    ['#transferBar', bar], ['#transferPercent', percent], ['#transferObject', currentObject], ['#transferLog', log],
    ['#workspace [data-transfer-running]', { dataset: { transferRunning: 'backup' } }]
  ]) });
  r.evaluate("view=async(nextMode)=>{mode=nextMode;renderTransferView()};startTaskClock=()=>{}");
  r.evaluate("showTransferProgress('backup', 'sample')");
  r.evaluate("updateTransferProgress({ operation: 'backup', rows: 1200, objects: 3, bytes: 4096, percent: 42, stage: 'table-data', objectName: 'users', objectIndex: 2, objectTotal: 5, events: [{ stage: 'table-data', objectName: 'users' }] })");
  assert.match(workspace.innerHTML, /Đang sao lưu database/);
  assert.equal(dialog.open, false);
  assert.match(detail.textContent, /1[,.]200 dòng/);
  assert.match(size.textContent, /4\.0 KB/);
  assert.equal(bar.value, 42);
  assert.match(percent.textContent, /~42%/);
  assert.equal(currentObject.textContent, 'Dữ liệu bảng: users (2/5)');
  assert.match(log.innerHTML, /Sao lưu dữ liệu bảng: users/);
  r.evaluate("updateTransferProgress({ operation: 'backup', rows: 1201, bytes: 5000, events: [{ stage: 'table-data', objectName: '<img src=x>' }] })");
  assert.match(log.innerHTML, /&lt;img src=x&gt;/);
  assert.doesNotMatch(log.innerHTML, /<img/);
  r.evaluate("updateTransferProgress({ operation: 'backup', events: Array.from({ length: 250 }, (_, index) => ({ stage: 'table-data', objectName: `table_${index}` })) })");
  assert.equal(r.evaluate('transferView.logs.length'), 200);
});

test('restore phân biệt lượt kiểm tra và lượt thực thi SQL', () => {
  const bar = {
    value: 0,
    attributes: new Set(['value']),
    removeAttribute(name) { this.attributes.delete(name); }
  };
  const detail = { textContent: '' };
  const currentObject = { textContent: '', title: '' };
  const percent = { textContent: '' };
  const elapsed = { textContent: '' };
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const workspace = { innerHTML: '' };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog], ['#workspace', workspace],
    ['#workspace [data-transfer-running]', { dataset: { transferRunning: 'restore' } }],
    ['#transferDetail', detail], ['#transferSize', { textContent: '' }], ['#transferBar', bar],
    ['#taskCurrentStep', { textContent: '' }], ['#transferObject', currentObject], ['#transferPercent', percent],
    ['#taskElapsed', elapsed]
  ]) });
  r.evaluate("view=async(nextMode)=>{mode=nextMode;renderTransferView()}");
  r.evaluate("showTransferProgress('restore', 'sample')");
  assert.doesNotMatch(workspace.innerHTML, /id="transferBar"[^>]*value=/);
  r.evaluate("updateTransferProgress({ operation: 'restore', phase: 'scan', statements: 10, executed: 0, bytes: 100, totalBytes: 200, currentObject: 'items', currentCommand: 'CREATE' })");
  assert.equal(bar.value, 25);
  assert.match(detail.textContent, /10 câu lệnh đã kiểm tra/);
  assert.equal(currentObject.textContent, 'Kiểm tra CREATE: items');
  assert.match(percent.textContent, /~25% tổng tiến trình/);
  assert.match(percent.textContent, /ước tính/);
  r.evaluate("updateTransferProgress({ operation: 'restore', phase: 'execute', executed: 10, bytes: 50, totalBytes: 200, currentObject: 'items', currentCommand: 'INSERT' })");
  assert.equal(bar.value, 63);
  assert.match(detail.textContent, /10 câu lệnh đã chạy/);
  assert.equal(currentObject.textContent, 'Thực thi INSERT: items');

  r.evaluate("transferView.startedAt = Date.now() - 65000; startTaskClock()");
  assert.match(elapsed.textContent, /01:05/);
  assert.equal(currentObject.title, 'Thực thi INSERT: items');
});

test('restore chưa biết tổng dung lượng dùng tiến trình không xác định thay vì 0%', () => {
  const bar = {
    value: 0,
    attributes: new Set(['value']),
    removeAttribute(name) { this.attributes.delete(name); }
  };
  const percent = { textContent: '' };
  const detail = { textContent: '' };
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog],
    ['#workspace', { innerHTML: '' }],
    ['#workspace [data-transfer-running]', { dataset: { transferRunning: 'restore' } }],
    ['#transferDetail', detail], ['#transferSize', { textContent: '' }], ['#transferBar', bar],
    ['#transferPercent', percent], ['#taskCurrentStep', { textContent: '' }],
    ['#transferObject', { textContent: '', title: '' }]
  ]) });
  r.evaluate("view=async(nextMode)=>{mode=nextMode};startTaskClock=()=>{}");
  r.evaluate("showTransferProgress('restore', 'sample', { taskId: 'r1', profileId: 'p1' })");
  r.evaluate("updateTransferProgress({ operation: 'restore', taskId: 'r1', profileId: 'p1', phase: 'scan', statements: 0, executed: 0, bytes: 0, totalBytes: 0 })");
  assert.equal(bar.attributes.has('value'), false);
  assert.match(percent.textContent, /không xác định/);
  assert.doesNotMatch(percent.textContent, /\b0%/);
  r.evaluate("updateTransferProgress({ operation: 'restore', taskId: 'r1', profileId: 'p1', phase: 'scan', statements: 3, executed: 0, bytes: 100, totalBytes: 200 })");
  assert.equal(bar.value, 25);
  assert.match(percent.textContent, /~25%/);
});

test('backup chưa đủ dữ liệu ước tính không hiển thị phần trăm giả', () => {
  const bar = {
    value: 0,
    attributes: new Set(['value']),
    removeAttribute(name) { this.attributes.delete(name); }
  };
  const percent = { textContent: '' };
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog],
    ['#workspace', { innerHTML: '' }],
    ['#workspace [data-transfer-running]', { dataset: { transferRunning: 'backup' } }],
    ['#transferDetail', { textContent: '' }], ['#transferSize', { textContent: '' }],
    ['#transferBar', bar], ['#transferPercent', percent],
    ['#taskCurrentStep', { textContent: '' }], ['#transferObject', { textContent: '', title: '' }]
  ]) });
  r.evaluate("view=async(nextMode)=>{mode=nextMode};startTaskClock=()=>{}");
  r.evaluate("showTransferProgress('backup', 'sample', { taskId: 'b1', profileId: 'p1' })");
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'b1', profileId: 'p1', rows: 0, objects: 0, bytes: 0, percent: null, stage: 'prepare', events: [] })");
  assert.equal(bar.attributes.has('value'), false);
  assert.match(percent.textContent, /chưa đủ dữ liệu/);
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'b1', profileId: 'p1', rows: 10, objects: 2, bytes: 100, percent: 42, estimated: true, stage: 'table-data', objectName: 'items', objectIndex: 1, objectTotal: 4, events: [] })");
  assert.equal(bar.value, 42);
  assert.match(percent.textContent, /~42%/);
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
  const workspace = { innerHTML: '' };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog], ['#workspace', workspace],
    ['#workspace [data-transfer-running]', { dataset: { transferRunning: 'backup' } }],
    ['#transferDetail', detail], ['#transferSize', size], ['#transferBar', { value: 0 }]
  ]) });
  r.evaluate("view=async(nextMode)=>{mode=nextMode;renderTransferView()};startTaskClock=()=>{}");
  r.evaluate("showTransferProgress('backup', 'sample', { taskId: 'task-a', profileId: 'profile-a' })");
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'task-b', profileId: 'profile-a', rows: 5, bytes: 10 })");
  assert.equal(detail.textContent, '');
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'task-a', profileId: 'profile-b', rows: 5, bytes: 10 })");
  assert.equal(detail.textContent, '');
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'task-a', profileId: 'profile-a', rows: 5, bytes: 10 })");
  assert.match(detail.textContent, /5 dòng/);
  r.evaluate("updateTransferProgress({ operation: 'backup', profileId: 'profile-a', rows: 9, bytes: 99 })");
  assert.match(detail.textContent, /5 dòng/);
  r.evaluate("finishBackgroundTransfer('success', 'Sao lưu hoàn tất', '<p>cũ</p>', 'task-a')");
  r.evaluate("showTransferProgress('backup', 'sample', { taskId: 'task-c', profileId: 'profile-a' })");
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'task-a', profileId: 'profile-a', rows: 7, bytes: 77 })");
  assert.equal(r.evaluate('transferView.progress'), null);
  r.evaluate("updateTransferProgress({ operation: 'backup', profileId: 'profile-a', rows: 8, bytes: 88 })");
  assert.equal(r.evaluate('transferView.progress'), null);
  r.evaluate("updateTransferProgress({ operation: 'backup', taskId: 'task-c', profileId: 'profile-a', rows: 6, bytes: 66 })");
  assert.equal(r.evaluate('transferView.progress.rows'), 6);
});

test('nút hủy gửi đúng profileId và taskId, chỉ hoàn tất khi main báo dừng', async () => {
  const calls = [];
  const button = { disabled: false, textContent: 'Hủy tác vụ' };
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
    elements: new Map([['#modal', dialog], ['#workspace', { innerHTML: '' }], ['[data-cancel-transfer]', button]])
  });
  r.evaluate("view=async(nextMode)=>{mode=nextMode}");
  r.evaluate("showTransferProgress('backup', 'sample', { taskId: 'task-x', profileId: 'profile-x' })");
  await r.evaluate('cancelActiveTransfer()');
  assert.deepEqual(calls, [{ profileId: 'profile-x', taskId: 'task-x' }]);
  assert.match(r.messages.at(-1).message, /Đã gửi yêu cầu hủy/);
  assert.equal(r.evaluate('transferView.state'), 'running');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Đang hủy…');
  assert.notEqual(r.evaluate('activeTransfer'), null);
  r.evaluate("finishBackgroundTransfer('canceled', 'Đã hủy sao lưu', '<p>Đã dừng</p>', 'task-x')");
  assert.equal(r.evaluate('transferView.state'), 'canceled');
  assert.equal(r.evaluate('activeTransfer'), null);
});

test('main từ chối hủy thì nút được mở lại và tác vụ vẫn chạy', async () => {
  const button = { disabled: false, textContent: 'Hủy tác vụ' };
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const r = loadRenderer({
    desktop: { db: { cancelTask: async () => ({ ok: true, data: { canceled: false } }) } },
    elements: new Map([['#modal', dialog], ['[data-cancel-transfer]', button]])
  });
  r.evaluate("view=async(nextMode)=>{mode=nextMode};renderTransferTab=()=>{}");
  r.evaluate("showTransferProgress('backup', 'sample', { taskId: 'task-y', profileId: 'profile-y' })");
  await r.evaluate('cancelActiveTransfer()');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Hủy tác vụ');
  assert.equal(r.evaluate('activeTransfer.canceling'), false);
  assert.match(r.messages.at(-1).message, /đã dừng trước khi/);
});

test('tác vụ tiếp tục cập nhật khi người dùng chuyển sang query và kết quả nằm trong tab', () => {
  const tab = { hidden: true, textContent: '', classList: { toggle() {} } };
  const workspace = { innerHTML: '' };
  const log = { innerHTML: '', scrollHeight: 100, scrollTop: 0, clientHeight: 100 };
  const dialog = { className: '', innerHTML: '', open: false, showModal() { this.open = true; } };
  const r = loadRenderer({ elements: new Map([
    ['#modal', dialog], ['#workspace', workspace], ['#transferTab', tab],
    ['#workspace [data-transfer-running]', { dataset: { transferRunning: 'backup' } }],
    ['#transferDetail', { textContent: '' }], ['#transferSize', { textContent: '' }],
    ['#transferBar', { value: 0 }], ['#transferLog', log]
  ]) });
  r.evaluate("view=async(nextMode)=>{mode=nextMode;if(nextMode==='transfer')renderTransferView()};startTaskClock=()=>{}");
  r.evaluate("showTransferProgress('backup','sample',{taskId:'b1',profileId:'a'})");
  assert.equal(tab.hidden, false);
  r.evaluate("mode='query';updateTransferProgress({operation:'backup',taskId:'b1',profileId:'a',rows:500,bytes:1024,events:[{stage:'table-data',objectName:'users'}]})");
  assert.equal(r.evaluate('transferView.progress.rows'), 500);
  assert.equal(r.evaluate('transferView.logs.length'), 1);
  r.evaluate("finishBackgroundTransfer('error','Tác vụ cũ','<p>Không đúng</p>','old-task')");
  assert.equal(r.evaluate('transferView.state'), 'running');
  r.evaluate("finishBackgroundTransfer('success','Sao lưu hoàn tất','<p>Đã ghi 500 dòng</p>','b1')");
  assert.equal(r.evaluate('mode'), 'query');
  assert.equal(dialog.open, false);
  r.evaluate("mode='transfer';renderTransferView()");
  assert.match(workspace.innerHTML, /Đã ghi 500 dòng/);
  assert.match(log.innerHTML, /Sao lưu dữ liệu bảng: users/);
  assert.match(tab.textContent, /✓ Sao lưu/);
});
