(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SqlDataDiffJob = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createJob({ db, unwrap, isCurrent, onProgress = () => {},
    pause = () => new Promise(resolve => setTimeout(resolve, 250)), now = Date.now, timeoutMs = 60000 }) {
    let jobId = null;
    let started = false;
    let cancelled = false;
    let cancelSent = false;
    let completed = false;
    let stop;
    const stopped = new Promise(resolve => { stop = resolve; });
    const error = (code, message) => Object.assign(new Error(message), { code });
    async function cancel() {
      cancelled = true;
      stop();
      if (jobId && !cancelSent && !completed) {
        cancelSent = true;
        await unwrap(db.cancelDataDiff({ jobId }));
      }
    }
    function check() {
      if (cancelled || !isCurrent()) throw error('DATA_DIFF_CANCELLED', 'Đã hủy tác vụ so sánh.');
    }
    async function run(scope) {
      if (started) throw error('DATA_DIFF_BUSY', 'Tác vụ này đã được khởi chạy.');
      started = true;
      const deadline = now() + timeoutMs;
      const bounded = async pending => {
        let timer;
        try {
          return await Promise.race([
            pending,
            stopped.then(() => { throw error('DATA_DIFF_CANCELLED', 'Đã hủy tác vụ so sánh.'); }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(error('DATA_DIFF_TIMEOUT', 'Tác vụ so sánh quá thời gian chờ.')), Math.max(0, deadline - now())); })
          ]);
        } finally { clearTimeout(timer); }
      };
      try {
        check();
        // No SQL, profile secrets, schema claims or write authority cross this facade.
        const pendingStart = unwrap(db.startDataDiff({
          sourceProfileId: scope.sourceProfileId, sourceDb: scope.sourceDb, sourceTable: scope.sourceTable,
          targetProfileId: scope.targetProfileId, targetDb: scope.targetDb, targetTable: scope.targetTable,
          rowLimit: scope.rowLimit
        }));
        void Promise.resolve(pendingStart).then(start => {
          if ((cancelled || !isCurrent()) && typeof start?.jobId === 'string') {
            jobId = start.jobId;
            void cancel().catch(() => {});
          }
        }).catch(() => {});
        const start = await bounded(pendingStart);
        if (!start || typeof start.jobId !== 'string' || !start.jobId || start.jobId.length > 160) {
          throw error('DATA_DIFF_FAILED', 'Main không trả về định danh tác vụ hợp lệ.');
        }
        jobId = start.jobId;
        check();
        for (let poll = 0; poll < 240; poll++) {
          check();
          if (now() >= deadline) throw error('DATA_DIFF_TIMEOUT', 'Tác vụ so sánh quá thời gian chờ.');
          const state = await bounded(unwrap(db.dataDiffStatus({ jobId })));
          check();
          if (now() >= deadline) throw error('DATA_DIFF_TIMEOUT', 'Tác vụ so sánh quá thời gian chờ.');
          if (!state || state.jobId !== jobId) throw error('DATA_DIFF_FAILED', 'Kết quả không thuộc tác vụ đang xem.');
          if (state.status === 'completed') {
            if (!state.report || state.report.coverage?.canSynchronize !== false
              || !Array.isArray(state.report.columns) || !Array.isArray(state.report.primaryKeys)) {
              throw error('DATA_DIFF_FAILED', 'Báo cáo thiếu thông tin phạm vi đã xác minh.');
            }
            completed = true;
            return state.report;
          }
          if (state.status === 'failed' || state.status === 'cancelled') {
            throw error(state.error?.code || 'DATA_DIFF_FAILED', state.error?.message || 'So sánh dữ liệu không hoàn tất.');
          }
          if (state.status !== 'running') throw error('DATA_DIFF_FAILED', 'Trạng thái tác vụ không hợp lệ.');
          onProgress(state.progress || {});
          await pause();
        }
        throw error('DATA_DIFF_TIMEOUT', 'Tác vụ so sánh quá thời gian chờ.');
      } finally {
        if (!completed) void cancel().catch(() => {});
      }
    }
    return Object.freeze({ run, cancel });
  }
  return Object.freeze({ createJob });
}));
