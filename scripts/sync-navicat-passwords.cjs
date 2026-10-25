'use strict';

// Retired: the legacy writer bypassed the store repository and SSH trust confirmation.
// Keep a safe entry point for old commands; never read profiles, launch Python or write keys.
function main() {
  process.stderr.write('Direct Navicat password sync is disabled. Use SqlPro: File > Import Navicat connections with a .ncx/JSON export. No credentials or local files were changed.\n');
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
