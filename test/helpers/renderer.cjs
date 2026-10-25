'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SqlAutocomplete = require('../../sql-autocomplete.js');
const SqlRowValues = require('../../row-values.js');
const SqlExportValues = require('../../export-values.js');
const SqlQueryResults = require('../../query-results.js');
const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');

function loadRenderer({ desktop, elements = new Map() } = {}) {
  const events = new Map();
  const messages = [];
  const storage = new Map();
  const context = vm.createContext({
    console,
    window: { sqlProDesktop: desktop, SqlAutocomplete, SqlRowValues, SqlExportValues, SqlQueryResults, addEventListener() {} },
    document: {
      querySelector: (selector) => elements.get(selector) || null,
      querySelectorAll: () => [],
      addEventListener: (name, handler) => {
        if (!events.has(name)) events.set(name, []);
        events.get(name).push(handler);
      }
    },
    sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)) },
    setTimeout: () => 1,
    clearTimeout() {},
    messages
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  const evaluate = (code) => vm.runInContext(code, context);
  evaluate('toast = (message, type) => messages.push({message, type});');
  return { context, evaluate, elements, events, messages, storage };
}

module.exports = { loadRenderer };
