'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scheduleTiming, nextScheduledAt, nextScheduledAtAsync } = require('./backup-schedule-timing.cjs');

const HOUR = 3600000;
const MAX_SCHEDULES = 50;
const STATES = new Set(['running', 'completed', 'failed', 'canceled', 'missed', 'busy', 'incomplete']);
const WARNINGS = new Set(['MANIFEST_WRITE_FAILED', 'RETENTION_FAILED', 'RETENTION_STOPPED', 'RETENTION_SKIPPED', 'RETENTION_HISTORY_FAILED']);

function scheduleId(profileId, database) {
  if (typeof profileId !== 'string' || !profileId || profileId.length > 120 || typeof database !== 'string' || !database || database.length > 64) throw new Error('Kết nối/database cho lịch backup không hợp lệ.');
  return crypto.createHash('sha256').update(JSON.stringify([profileId, database])).digest('hex');
}

function validateSchedule(value) {
  if (!value || value.id !== scheduleId(value.profileId, value.database) || typeof value.enabled !== 'boolean'
      || typeof value.nextRunAt !== 'string' || !Number.isFinite(Date.parse(value.nextRunAt))
      || typeof value.timeZone !== 'string' || value.timeZone.length > 100
      || typeof value.target !== 'string' || !/^[a-f0-9]{64}$/.test(value.target)
      || typeof value.revision !== 'string' || !/^[a-f0-9]{32}$/.test(value.revision)) throw new Error('Lịch backup không hợp lệ. Giữ nguyên cấu hình để kiểm tra.');
  const timing = scheduleTiming(value);
  new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(0);
  let lastRun = null;
  if (value.lastRun !== null && value.lastRun !== undefined) {
    const run = value.lastRun;
    if (!STATES.has(run.status) || typeof run.scheduledFor !== 'string' || !Number.isFinite(Date.parse(run.scheduledFor))
        || typeof run.startedAt !== 'string' || !Number.isFinite(Date.parse(run.startedAt))
        || run.finishedAt !== null && (typeof run.finishedAt !== 'string' || !Number.isFinite(Date.parse(run.finishedAt)))
        || typeof run.taskId !== 'string' || !/^scheduled-[a-f0-9]{32}$/.test(run.taskId)
        || run.backupId !== null && (typeof run.backupId !== 'string' || !/^\d{14}-[a-f0-9]{8}\.sql$/.test(run.backupId))
        || run.errorCode !== null && (typeof run.errorCode !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(run.errorCode))
        || (run.status === 'running') !== (run.finishedAt === null)
        || run.warnings !== undefined && (!Array.isArray(run.warnings) || run.warnings.length > WARNINGS.size || run.warnings.some(code => !WARNINGS.has(code)))) throw new Error('Kết quả lịch backup không hợp lệ.');
    lastRun = { status: run.status, scheduledFor: run.scheduledFor, startedAt: run.startedAt,
      finishedAt: run.finishedAt, taskId: run.taskId, backupId: run.backupId, errorCode: run.errorCode, warnings: run.warnings || [] };
  }
  return { id: value.id, profileId: value.profileId, database: value.database, enabled: value.enabled,
    ...timing, nextRunAt: value.nextRunAt, timeZone: value.timeZone,
    target: value.target, revision: value.revision, lastRun };
}

function createScheduleStore(root) {
  const file = path.join(root, 'backup-schedules.json');
  function read() {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Tệp lịch backup không hợp lệ hoặc vượt 256 KiB.');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || ![1, 2, 3].includes(data.version) || !Array.isArray(data.schedules) || data.schedules.length > MAX_SCHEDULES) throw new Error('Phiên bản lịch backup chưa được hỗ trợ.');
    if (data.version < 3 && data.schedules.some(item => item.mode === 'cron')) throw new Error('Lịch cron yêu cầu định dạng v3.');
    if (data.version === 1 && data.schedules.some(item => item.mode === 'daily')) throw new Error('Lịch hằng ngày yêu cầu định dạng v2.');
    const schedules = data.schedules.map(validateSchedule);
    if (new Set(schedules.map(item => item.id)).size !== schedules.length) throw new Error('Lịch backup bị trùng mã.');
    return schedules;
  }
  function write(schedules) {
    if (schedules.length > MAX_SCHEDULES) throw new Error('Tối đa 50 lịch backup trên máy này.');
    const normalized = schedules.map(validateSchedule);
    const text = JSON.stringify({ version: normalized.some(item => item.mode === 'cron') ? 3 : normalized.some(item => item.mode === 'daily') ? 2 : 1, schedules: normalized }, null, 2);
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Lịch backup vượt 256 KiB.');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.part`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file);
    }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(temporary, { force: true }); }
  }
  function save(input, now = Date.now()) {
    const next = Date.parse(input.nextRunAt);
    if (!Number.isFinite(next) || next <= now || next > now + 366 * 24 * HOUR) throw new Error('Lần chạy đầu phải trong tương lai, tối đa 366 ngày.');
    const schedules = read();
    const id = scheduleId(input.profileId, input.database);
    const previous = schedules.find(item => item.id === id);
    const value = validateSchedule({ ...input, id, revision: crypto.randomBytes(16).toString('hex'), lastRun: previous?.lastRun || null });
    write([...schedules.filter(item => item.id !== id), value]);
    return value;
  }
  function update(id, revision, change) {
    const schedules = read();
    const index = schedules.findIndex(item => item.id === id && item.revision === revision);
    if (index < 0) throw new Error('Lịch backup đã thay đổi.');
    schedules[index] = validateSchedule(change(schedules[index]));
    write(schedules); return schedules[index];
  }
  function remove(id) { const schedules = read(); write(schedules.filter(item => item.id !== id)); }
  return { read, save, update, remove };
}

class BackupScheduler {
  constructor({ repository, run, isBusy, now = Date.now, graceMs = 60000, nextRun = (item, clock) => scheduleTiming(item).mode === 'cron' ? nextScheduledAtAsync(item, clock) : nextScheduledAt(item, clock) }) {
    Object.assign(this, { repository, run, isBusy, now, graceMs, nextRun });
    this.busy = false; this.stopped = false; this.error = null; this.generation = 0;
  }

  recover() {
    for (const schedule of this.repository.read()) {
      if (schedule.lastRun?.status === 'running') this.repository.update(schedule.id, schedule.revision, item => ({ ...item,
        lastRun: { ...item.lastRun, status: 'incomplete', finishedAt: new Date(this.now()).toISOString(), errorCode: 'BACKUP_INTERRUPTED' } }));
    }
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const schedules = this.repository.read().filter(item => item.enabled && Date.parse(item.nextRunAt) <= this.now())
        .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
      for (const queued of schedules) {
        if (this.stopped || generation !== this.generation) break;
        const schedule = this.repository.read().find(item => item.id === queued.id);
        if (!schedule?.enabled || schedule.revision !== queued.revision || schedule.nextRunAt !== queued.nextRunAt) continue;
        const now = this.now(), due = Date.parse(schedule.nextRunAt);
        if (now < due) continue;
        const busy = this.isBusy();
        if (busy && now - due <= this.graceMs) continue;
        const nextRunAt = await this.nextRun(schedule, now);
        if (this.stopped || generation !== this.generation) break;
        const current = this.repository.read().find(item => item.id === schedule.id);
        if (!current?.enabled || current.revision !== schedule.revision || current.nextRunAt !== schedule.nextRunAt) continue;
        // A very short cron interval may elapse while calculating. Leave it for
        // the next tick rather than claim a past next run or replay twice.
        const claimedAt = this.now();
        if (claimedAt < due || Date.parse(nextRunAt) <= claimedAt) continue;
        // Calendar calculation can yield to a worker. Recheck admission and
        // grace against the current clock before persisting a claim.
        const busyAtClaim = this.isBusy();
        if (busyAtClaim && claimedAt - due <= this.graceMs) continue;
        const status = claimedAt - due > this.graceMs ? busyAtClaim ? 'busy' : 'missed' : 'running';
        const taskId = `scheduled-${crypto.randomBytes(16).toString('hex')}`;
        const startedAt = new Date(claimedAt).toISOString();
        const claimed = this.repository.update(schedule.id, schedule.revision, item => ({ ...item,
          nextRunAt,
          lastRun: { status, scheduledFor: schedule.nextRunAt, startedAt, finishedAt: status === 'running' ? null : startedAt, taskId, backupId: null, errorCode: null } }));
        if (status !== 'running') continue;
        let result;
        try {
          result = await this.run(claimed, taskId);
        } catch (error) {
          this.repository.update(schedule.id, schedule.revision, item => ({ ...item, enabled: error.code === 'SCHEDULE_TARGET_CHANGED' ? false : item.enabled, lastRun: { ...item.lastRun,
            status: 'failed', finishedAt: new Date(this.now()).toISOString(), errorCode: /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'SCHEDULE_BACKUP_FAILED' } }));
          continue;
        }
        const warnings = [];
        if (result.manifestError) warnings.push('MANIFEST_WRITE_FAILED');
        if (['failed', 'stopped', 'skipped'].includes(result.retention?.status)) warnings.push(`RETENTION_${result.retention.status.toUpperCase()}`);
        if (result.retention?.historySaveError) warnings.push('RETENTION_HISTORY_FAILED');
        this.repository.update(schedule.id, schedule.revision, item => ({ ...item, lastRun: { ...item.lastRun,
          status: result.canceled ? 'canceled' : 'completed', backupId: result.id || null, finishedAt: new Date(this.now()).toISOString(), errorCode: null, warnings } }));
      }
      this.error = null;
    } catch (error) { this.error = error.message; this.stop(); }
    finally { this.busy = false; }
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    const generation = ++this.generation;
    const cycle = async () => {
      if (generation !== this.generation || this.stopped) return;
      await this.tick();
      if (generation === this.generation && !this.stopped) {
        this.timer = setTimeout(cycle, 15000); this.timer.unref?.();
      }
    };
    this.timer = setTimeout(cycle, 1000); this.timer.unref?.();
  }

  stop() { this.stopped = true; this.generation++; clearTimeout(this.timer); this.timer = null; }
}

module.exports = { createScheduleStore, BackupScheduler, scheduleId, validateSchedule };
