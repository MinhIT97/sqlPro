'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

test('renderer confirms matched updates and rejects ambiguous or zero-row responses', () => {
  const r = loadRenderer();
  for (const value of [null, {}, { affectedRows: 0, changedRows: 0 }, { status: 'updated' }]) {
    r.context.result = value;
    assert.throws(() => r.evaluate('requireRowUpdate(result)'), { code: 'ROW_NOT_FOUND' });
  }
  for (const value of [{ affectedRows: 1, changedRows: 1 }, { status: 'unchanged', matchedRows: 1, affectedRows: 1, changedRows: 0 }]) {
    r.context.result = value;
    assert.equal(r.evaluate('requireRowUpdate(result)'), value);
  }
});

test('row originals carry binary hashes separately from visible previews and follow edited text', () => {
  const r = loadRenderer();
  const result = r.evaluate(`(() => {
    const row={id:1,note:'before',data:'0x0012… (100 bytes)'};
    rowOriginalHashes.set(row,{data:{kind:'sha256',value:'ab'.repeat(32)}});
    row.note='after';
    return originalRow(row);
  })()`);
  assert.equal(result.note, 'after');
  assert.equal(result.data.kind, 'sha256');
  assert.equal(result.data.value, 'ab'.repeat(32));
});
