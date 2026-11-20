'use strict';

const { calculateNextRun, parseCron } = require('./backup-calendar-calculator.cjs');
const HOUR = 3600000;
function scheduleTiming(value) {
  const mode = value.mode === undefined ? 'interval' : value.mode;
  if (mode === 'cron') {
    if (typeof value.cron !== 'string' || value.cron.length > 128 || value.timeOfDay !== undefined) throw new Error('Cron phải có 5 trường và tối đa 128 ký tự.');
    parseCron(value.cron);
    return { mode, cron: value.cron.trim().replace(/\s+/g, ' ') };
  }
  if (mode === 'daily') {
    if (typeof value.timeOfDay !== 'string' || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.timeOfDay)
      || value.cron !== undefined) throw new Error('Giờ backup phải có dạng HH:mm; chưa nhận cron tùy ý.');
    return { mode, timeOfDay: value.timeOfDay };
  }
  if (mode !== 'interval' || value.timeOfDay !== undefined || value.cron !== undefined
    || !Number.isInteger(value.intervalHours) || value.intervalHours < 1 || value.intervalHours > 168) {
    throw new Error('Lịch backup không hợp lệ. Chọn chu kỳ 1–168 giờ hoặc lịch hằng ngày.');
  }
  return { intervalHours: value.intervalHours };
}
function nextScheduledAt(value, now = Date.now()) {
  const timing = scheduleTiming(value);
  if (!Number.isFinite(now)) throw new Error('Đồng hồ lịch backup không hợp lệ.');
  if (timing.mode === 'daily' || timing.mode === 'cron') {
    if (typeof value.timeZone !== 'string' || !value.timeZone || value.timeZone.length > 100) {
      throw new Error('Múi giờ lịch backup không hợp lệ.');
    }
    if (timing.mode === 'cron') return calculateNextRun(timing.cron, new Date(now), value.timeZone).toISOString();
    const [hour, minute] = timing.timeOfDay.split(':').map(Number);
    // Bounded daily grammar reuses the DST-aware calculator; no annual scan.
    return calculateNextRun(`${minute} ${hour} * * *`, new Date(now), value.timeZone).toISOString();
  }
  const due = Date.parse(value.nextRunAt), interval = timing.intervalHours * HOUR;
  if (!Number.isFinite(due)) throw new Error('Thời điểm chạy backup không hợp lệ.');
  return new Date(due + (Math.floor(Math.max(0, now - due) / interval) + 1) * interval).toISOString();
}
async function nextScheduledAtAsync(value, now = Date.now()) {
  const timing = scheduleTiming(value);
  if (timing.mode !== 'cron') return nextScheduledAt(value, now);
  if (typeof value.timeZone !== 'string' || !value.timeZone || value.timeZone.length > 100) throw new Error('Múi giờ lịch backup không hợp lệ.');
  const { Worker } = require('node:worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(require.resolve('./backup-schedule-worker.cjs'), { workerData: { ...timing, timeZone: value.timeZone, now } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Tính lịch vượt 15 giây; chưa thay đổi lịch đã lưu.')), 15000);
    worker.once('message', message => {
      if (message.error) finish(new Error('Cron/múi giờ không có kỳ chạy phù hợp trong 366 ngày.'));
      else if (typeof message.next !== 'string' || !Number.isFinite(Date.parse(message.next)) || Date.parse(message.next) <= now) finish(new Error('Kỳ chạy cron không hợp lệ.'));
      else finish(null, message.next);
    });
    worker.once('error', () => finish(new Error('Không tính được lịch cron; chưa thay đổi lịch đã lưu.')));
    worker.once('exit', () => { if (!settled) finish(new Error('Bộ tính lịch dừng trước khi có kết quả.')); });
  });
}
module.exports = { scheduleTiming, nextScheduledAt, nextScheduledAtAsync };
