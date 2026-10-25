'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request } = require('./helpers.cjs');

test('internal dependency failures do not disclose exception text, stack or details through logs or responses', async (t) => {
  const context = await startServer({ logErrors: true });
  t.after(() => context.close());
  const captured = [];
  const oldConsoleError = console.error;
  console.error = (...args) => captured.push(args);
  try {
    context.db.prepare = () => {
      const error = new Error('synthetic-private-credential-marker');
      error.details = { secret: 'synthetic-private-credential-marker' };
      throw error;
    };
    const result = await request(context.baseUrl, '/healthz');
    assert.equal(result.status, 500);
    assert.equal(result.data.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify([captured, result.data]).includes('synthetic-private-credential-marker'), false);
    assert.deepEqual(captured, [['[sqlpro-server]', 'INTERNAL_ERROR']]);
  } finally { console.error = oldConsoleError; }
});
