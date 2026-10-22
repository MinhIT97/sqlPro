'use strict';

const crypto = require('node:crypto');
const { openDatabase } = require('../src/db.cjs');
const { createApp } = require('../src/app.cjs');
const { readConfig } = require('../src/config.cjs');

function randomProof() {
  return crypto.randomBytes(32).toString('base64url');
}

async function startServer(overrides = {}) {
  const defaults = readConfig({});
  const config = {
    ...defaults,
    logErrors: false,
    websiteDir: '/nonexistent-sqlpro-website',
    ...overrides,
    rateLimit: {
      ...defaults.rateLimit,
      enabled: false,
      ...(overrides.rateLimit || {})
    }
  };
  const db = openDatabase(':memory:');
  const app = createApp({ db, config });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    config,
    baseUrl,
    close: () => new Promise((resolve) => {
      server.close(() => {
        try {
          db.close();
        } catch {
          // ignore
        }
        resolve();
      });
    })
  };
}

async function request(baseUrl, path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data, headers: response.headers };
}

module.exports = { startServer, request, randomProof };
