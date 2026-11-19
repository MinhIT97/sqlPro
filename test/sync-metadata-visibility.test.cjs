'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { provesMetadataVisibility } = require('../electron/sync-metadata-visibility.cjs');

test('F04: metadata visibility requires direct global SELECT/TRIGGER and rejects partial or role-only grants', () => {
  const rows = (...grants) => grants.map(grant => ({ grants: grant }));
  assert.equal(provesMetadataVisibility(rows("GRANT SELECT, TRIGGER ON *.* TO 'u'@'h'")), true);
  assert.equal(provesMetadataVisibility(rows("GRANT ALL PRIVILEGES ON *.* TO 'u'@'h'")), true);
  for (const value of [undefined, [], [{}], rows("GRANT SELECT ON *.* TO 'u'@'h'"), rows("GRANT SELECT, TRIGGER ON `db`.* TO 'u'@'h'"), rows("GRANT 'SELECT' ON *.* TO 'u'@'h'"), rows("GRANT `admin` TO 'u'@'h'"), rows("GRANT SELECT, TRIGGER ON *.* TO 'u'@'h'", "REVOKE SELECT ON `hidden`.* FROM 'u'@'h'")]) {
    assert.equal(provesMetadataVisibility(value), false);
  }
});

