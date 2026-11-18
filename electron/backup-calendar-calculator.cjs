'use strict';

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseCronField(fieldStr, min, max) {
  if (typeof fieldStr !== 'string' || !fieldStr || fieldStr.length > 128) throw error('INVALID_CRON_FIELD', 'Trường cron không hợp lệ.');
  const values = new Set();
  for (const part of fieldStr.split(',')) {
    const match = /^(\*|[0-9]+(?:-[0-9]+)?)(?:\/([0-9]+))?$/.exec(part);
    if (!match) throw error('INVALID_CRON_FIELD', 'Cú pháp trường cron không được hỗ trợ.');
    const range = match[1], step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1) throw error('INVALID_CRON_FIELD', 'Bước nhảy cron không hợp lệ.');
    let start = min, end = max;
    if (range !== '*') {
      const bounds = range.split('-').map(Number);
      [start] = bounds; end = bounds[1] ?? start;
      if (match[2] && bounds.length === 1) throw error('INVALID_CRON_FIELD', 'Chỉ hỗ trợ bước nhảy với * hoặc khoảng giá trị.');
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) {
      throw error('INVALID_CRON_FIELD', 'Giá trị cron ngoài khoảng cho phép.');
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }

  return values;
}

function parseCron(expression) {
  if (typeof expression !== 'string' || expression.length > 1024) throw error('INVALID_CRON_EXPRESSION', 'Biểu thức cron không hợp lệ.');
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw error('INVALID_CRON_EXPRESSION', `Biểu thức cron phải có đúng 5 trường (phút, giờ, ngày, tháng, thứ), nhận được: ${expression}`);
  }

  const [minStr, hourStr, domStr, monthStr, dowStr] = tokens;

  const minutes = parseCronField(minStr, 0, 59);
  const hours = parseCronField(hourStr, 0, 23);
  const daysOfMonth = parseCronField(domStr, 1, 31);
  const months = parseCronField(monthStr, 1, 12);
  const daysOfWeek = new Set([...parseCronField(dowStr, 0, 7)].map(day => day % 7));

  return {
    expression,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthWildcard: domStr.startsWith('*'),
    dayOfWeekWildcard: dowStr.startsWith('*')
  };
}

function createFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false, weekday: 'short'
  });
}

function getTimeComponents(date, timeZone, formatter = createFormatter(timeZone)) {
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;

  // Day of week calculation in target timezone
  // Sunday = 0, Monday = 1, ...
  const weekday = map.weekday;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dowMap[weekday] ?? 0;

  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour,
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10),
    dayOfWeek
  };
}

function calculateNextRun(cronExpression, fromDate = new Date(), timeZone = 'UTC') {
  const cron = parseCron(cronExpression);
  if (!(fromDate instanceof Date) || !Number.isFinite(fromDate.getTime())) throw error('INVALID_SCHEDULE_DATE', 'Thời điểm bắt đầu không hợp lệ.');
  let formatter;

  // Validate timezone
  try {
    formatter = createFormatter(timeZone);
    formatter.format(0);
  } catch {
    throw error('INVALID_TIMEZONE', `Múi giờ không hợp lệ: ${timeZone}`);
  }

  // Advance by 1 minute from fromDate to ensure we find future timestamp
  let cursor = new Date(Math.floor(fromDate.getTime() / 60000) * 60000 + 60000);

  // Search forward up to 366 days
  const maxSearch = 366 * 24 * 60; // in minutes
  for (let i = 0; i < maxSearch; i++) {
    const comp = getTimeComponents(cursor, timeZone, formatter);
    const domMatches = cron.daysOfMonth.has(comp.day), dowMatches = cron.daysOfWeek.has(comp.dayOfWeek);
    const dayMatches = cron.dayOfMonthWildcard || cron.dayOfWeekWildcard
      ? domMatches && dowMatches : domMatches || dowMatches;

    if (
      cron.months.has(comp.month) &&
      dayMatches &&
      cron.hours.has(comp.hour) &&
      cron.minutes.has(comp.minute)
    ) {
      return cursor;
    }

    cursor = new Date(cursor.getTime() + 60000);
  }

  throw error('NO_MATCHING_SCHEDULE', 'Không tìm thấy thời điểm chạy kế tiếp trong vòng 366 ngày.');
}

function evaluateMissedRuns(schedule, lastCheckedAt, now = Date.now(), graceMs = 5 * 60 * 1000) {
  if (!schedule || !schedule.nextRunAt) {
    return { missed: false, shouldCatchUp: false };
  }

  const scheduledTime = Date.parse(schedule.nextRunAt);
  if (!Number.isFinite(scheduledTime)) {
    return { missed: false, shouldCatchUp: false };
  }

  // If scheduled time has passed
  if (scheduledTime <= now) {
    const elapsedSinceScheduled = now - scheduledTime;
    const isWithinGrace = elapsedSinceScheduled <= graceMs;

    return {
      missed: !isWithinGrace,
      shouldCatchUp: isWithinGrace,
      scheduledTime,
      elapsedMs: elapsedSinceScheduled
    };
  }

  return { missed: false, shouldCatchUp: false };
}

module.exports = {
  parseCron,
  calculateNextRun,
  evaluateMissedRuns,
  getTimeComponents
};
