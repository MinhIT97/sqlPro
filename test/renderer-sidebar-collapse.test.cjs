'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/renderer.cjs');

test('sidebar: active connection can be collapsed and expanded', () => {
  const connectionList = { innerHTML: '', scrollTop: 0 };
  const treeSearch = { value: '' };
  const elements = new Map([
    ['#connectionList', connectionList],
    ['#treeSearch', treeSearch]
  ]);

  const r = loadRenderer({ elements });

  r.evaluate(`
    app.connections = [{
      id: 'conn_1',
      name: 'root@localhost',
      host: 'localhost',
      port: 3306,
      user: 'root',
      database: null,
      ssh: { enabled: false }
    }];
    app.connection = app.connections[0];
    app.databases = ['db_one', 'db_two'];
    renderSidebar();
  `);

  let html = connectionList.innerHTML;
  assert.ok(html.includes('conn-children'), 'Should initially render conn-children');
  assert.ok(html.includes('tree-chevron open'), 'Chevron should be open');
  assert.ok(html.includes('aria-expanded="true"'), 'Should have aria-expanded="true"');

  // Simulate click on connection to collapse
  r.evaluate(`{
    const item = { dataset: { connection: 'conn_1' } };
    const event = {
      target: {
        closest: (selector) => {
          if (selector === '.conn-children') return null;
          if (selector === '[data-menu]') return null;
          if (selector === '[data-toggle-conn]') return null;
          if (selector === '[data-connection]') return item;
          return null;
        }
      },
      stopPropagation: () => {}
    };
    onConnectionClick(event);
  }`);

  html = connectionList.innerHTML;
  assert.ok(!html.includes('conn-children'), 'Should not render conn-children when collapsed');
  assert.ok(!html.includes('tree-chevron open'), 'Chevron should not be open when collapsed');
  assert.ok(html.includes('tree-chevron '), 'Chevron should still exist');
  assert.ok(html.includes('aria-expanded="false"'), 'Should have aria-expanded="false"');

  // Simulate click on chevron to expand again
  r.evaluate(`{
    const chevron = { dataset: { toggleConn: 'conn_1' } };
    const item = { dataset: { connection: 'conn_1' } };
    const event = {
      target: {
        closest: (selector) => {
          if (selector === '.conn-children') return null;
          if (selector === '[data-menu]') return null;
          if (selector === '[data-toggle-conn]') return chevron;
          if (selector === '[data-connection]') return item;
          return null;
        }
      },
      stopPropagation: () => {}
    };
    onConnectionClick(event);
  }`);

  html = connectionList.innerHTML;
  assert.ok(html.includes('conn-children'), 'Should render conn-children when expanded again');
  assert.ok(html.includes('tree-chevron open'), 'Chevron should be open when expanded again');
  assert.ok(html.includes('aria-expanded="true"'), 'Should have aria-expanded="true"');
});
