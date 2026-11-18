'use strict';

const fail = code => Object.assign(new Error(code), { code });

// Bound every worker phase, including connect/USE/collect and late completion.
// Destroying a connection does not prove an in-flight DDL was rolled back.
function createWorkerGuard(worker, { signal, deadline = Date.now() + 30000 } = {}) {
  const destroy = () => {
    worker.dead = true;
    try { worker.connection?.destroy(); } catch { /* Best effort. */ }
    try { worker.closeSsh?.(); } catch { /* Best effort. */ }
  };
  const close = async () => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => worker.close()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail('MIGRATION_WORKER_CLOSE_FAILED')), 1500); })
      ]);
    } catch (err) { destroy(); throw err; }
    finally { clearTimeout(timer); }
  };
  const run = (operation, timeoutMs = Infinity) => new Promise((resolve, reject) => {
    let settled = false, interrupted = false, timer;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (err) reject(err); else resolve(result);
    };
    const interrupt = code => {
      interrupted = true;
      destroy();
      finish(fail(code));
    };
    const cancel = () => interrupt('QUERY_CANCELED');
    if (signal?.aborted) { cancel(); return; }
    const remaining = Math.min(deadline - Date.now(), timeoutMs);
    if (remaining <= 0) { interrupt('QUERY_TIMEOUT'); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => interrupt('QUERY_TIMEOUT'), remaining);
    Promise.resolve().then(() => {
      if (settled) return;
      return operation();
    }).then(result => {
      if (interrupted) {
        // A connection can finish opening after cancellation/early cleanup.
        destroy();
        void close().catch(() => {});
      } else finish(null, result);
    }, err => {
      if (interrupted) { destroy(); void close().catch(() => {}); }
      else finish(err || fail('MIGRATION_EXECUTION_FAILED'));
    });
  });
  return { run, close, destroy };
}

module.exports = { createWorkerGuard };
