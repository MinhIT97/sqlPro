'use strict';

const installed = new WeakSet();

// Unhandled failures have no verified owning session/task. Never log messages,
// stacks, SQL, rejection objects or arbitrary properties, and never continue a
// potentially inconsistent Main process as if recovery had succeeded.
function installMainErrorHandlers(target = process, logger = console) {
  if (installed.has(target)) return;
  installed.add(target);
  let terminating = false;
  const terminate = kind => {
    if (terminating) return;
    terminating = true;
    try { logger.error(`[SqlPro] ${kind}; terminating main process (exit 1).`); }
    finally { target.exit(1); }
  };
  target.on('uncaughtException', () => terminate('UNCAUGHT_EXCEPTION'));
  target.on('unhandledRejection', () => terminate('UNHANDLED_REJECTION'));
}

module.exports = { installMainErrorHandlers };
