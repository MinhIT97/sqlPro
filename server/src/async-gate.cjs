'use strict';

const { ApiError } = require('./errors.cjs');

function createTaskGate({ concurrency = 2, maxQueue = 32 } = {}) {
  let active = 0;
  const queue = [];
  function pump() {
    while (active < concurrency && queue.length) {
      const { run, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active -= 1; pump(); });
    }
  }
  return {
    run(work) {
      if (active >= concurrency && queue.length >= maxQueue) {
        return Promise.reject(new ApiError(503, 'AUTH_BUSY', 'Server đang xử lý nhiều yêu cầu đăng nhập. Hãy thử lại sau.'));
      }
      return new Promise((resolve, reject) => { queue.push({ run: work, resolve, reject }); pump(); });
    }
  };
}

module.exports = { createTaskGate };
