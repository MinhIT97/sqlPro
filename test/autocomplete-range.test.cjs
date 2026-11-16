'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getContext } = require('../sql-autocomplete.js');
const { loadRenderer } = require('./helpers/renderer.cjs');

function at(marked) {
  const caret = marked.indexOf('|');
  assert.ok(caret >= 0);
  return getContext(marked.replace('|', ''), caret);
}

test('completion replaces the entire identifier while preserving SQL on both sides of the token', () => {
  for (const [marked, token, prefix, qualifier] of [
    ['SELECT 1; SELECT * FROM users u WHERE us|er_id=1; SELECT 2', 'user_id', 'us', null],
    ['SELECT * FROM users u WHERE u.na|me > 0 /* keep */', 'name', 'na', 'u'],
    ['SELECT * FROM users u WHERE u.|name=1', 'name', '', 'u'],
    ['SELECT * FROM users u WHERE u. `na|me`=1', '`name`', 'na', 'u'],
    ['SELECT * FROM users u WHERE u.|`name`=1', '`name`', '', 'u'],
    ['SELECT * FROM users u WHERE u.`na|me', '`name', 'na', 'u'],
    ['SELECT * FROM users u WHERE u.`na|', '`na', 'na', 'u'],
    ['SELECT * FROM users `u``x` WHERE `u``x` /* keep */ . `a``b| c;名`=1', '`a``b c;名`', 'a`b', 'u`x'],
    ['SELECT * FROM users WHERE `tên |cột`=1', '`tên cột`', 'tên ', null],
    ['SELECT * FROM users WHERE |', '', '', null]
  ]) {
    const context = at(marked);
    const sql = marked.replace('|', '');
    assert.equal(context.disabled, false, marked);
    assert.equal(context.prefix, prefix, marked);
    assert.equal(context.qualifier, qualifier, marked);
    assert.equal(sql.slice(context.start, context.end), token, marked);
    assert.equal(context.value, sql); assert.equal(context.caret, marked.indexOf('|'));
  }
});

test('ambiguous or unsupported tokens never offer a partial replacement', () => {
  for (const marked of [
    'SELECT 12|3', 'SELECT 12|name', 'SELECT 1e|10', 'SELECT 名na|me', 'SELECT na|me名',
    'SELECT na|me\u00a0', 'SELECT `name`|', 'SELECT foo`na|me`',
    'SELECT `na|me`tail', 'SELECT `na|me WHERE id=1', 'SELECT `na|me; SELECT 2',
    'SELECT `na|me\\x`', "SELECT 'na|me'", 'SELECT /* na|me */ 1', 'SELECT 1 -- na|me'
  ]) assert.equal(at(marked).disabled, true, marked);
});

test('replacement range stays inside each statement, leaving operators, comments and delimiters intact', () => {
  const marked = 'SELECT 1; SELECT na|me/* untouched */+1 FROM users; SELECT 3';
  const context = at(marked);
  assert.equal(context.value.slice(context.start, context.end), 'name');
  assert.equal(context.value.slice(0, context.start) + '`name`' + context.value.slice(context.end),
    'SELECT 1; SELECT `name`/* untouched */+1 FROM users; SELECT 3');
  const quoted = at('SELECT `na|;me` FROM users; SELECT 2');
  assert.equal(quoted.value.slice(quoted.start, quoted.end), '`na;me`');
  assert.equal(quoted.statement, 'SELECT `na;me` FROM users');
});

function renderer(desktop) {
  const editor = {
    value: '', selectionStart: 0, selectionEnd: 0, isConnected: true,
    setAttribute() {}, removeAttribute() {}, focus() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    }
  };
  const r = loadRenderer({ elements: new Map([['#sql', editor]]), desktop });
  r.evaluate("mode='query';app.query={id:'q',sql:''};persistState=()=>{}");
  const prepare = marked => {
    editor.value = marked.replace('|', '');
    editor.selectionStart = editor.selectionEnd = marked.indexOf('|');
    r.evaluate("sqlAutocomplete.context={...window.SqlAutocomplete.getContext($('#sql').value,$('#sql').selectionStart),tab:app.query,target:autocompleteTarget()};sqlAutocomplete.items=[{label:'name',insertText:'`name`'}]");
  };
  return { ...r, editor, prepare };
}

test('renderer accepts a current suggestion as one undoable edit and rejects stale value/caret/selection/context', () => {
  const r = renderer();
  r.prepare('SELECT na|me FROM users');
  r.evaluate("acceptSqlSuggestion($('#sql'),0)");
  assert.equal(r.editor.value, 'SELECT `name` FROM users');
  assert.equal(r.evaluate('app.query.sqlHistory.past.length'), 1);
  assert.equal(r.evaluate('app.query.sqlHistory.past[0].value'), 'SELECT name FROM users');
  for (const change of [
    () => { r.editor.value += ' WHERE id=1'; },
    () => { r.editor.selectionStart = r.editor.selectionEnd = 0; },
    () => { r.editor.selectionEnd += 1; },
    () => { r.editor.isConnected = false; },
    () => { r.evaluate("app.connection={id:'changed'};app.database='changed'"); },
    () => { r.evaluate("app.query={...app.query,id:'another'}"); },
    () => { r.evaluate('sqlAutocomplete.context.end=99999'); }
  ]) {
    r.editor.isConnected = true;
    r.prepare('SELECT na|me FROM users'); change();
    const value = r.editor.value;
    r.evaluate("acceptSqlSuggestion($('#sql'),0)");
    assert.equal(r.editor.value, value);
    assert.equal(r.evaluate('sqlAutocomplete.context'), null);
    assert.equal(r.evaluate('app.query.sqlHistory.past.length'), 1);
  }
});

test('function completion preserves existing arguments and puts the caret inside one pair of parentheses', () => {
  for (const [marked, expected] of [
    ['SELECT COU|NT(*) FROM users', 'SELECT COUNT(*) FROM users'],
    ['SELECT COU|NT \n (id) FROM users', 'SELECT COUNT \n (id) FROM users'],
    ['SELECT COU|NT FROM users', 'SELECT COUNT() FROM users']
  ]) {
    const r = renderer(); r.prepare(marked);
    r.evaluate("sqlAutocomplete.items=[{label:'COUNT()',insertText:'COUNT()',type:'function'}];acceptSqlSuggestion($('#sql'),0)");
    assert.equal(r.editor.value, expected);
    assert.equal(r.editor.selectionStart, expected.indexOf('(') + 1);
    if (expected !== marked.replace('|', '')) assert.equal(r.evaluate('app.query.sqlHistory.past.length'), 1);
  }
});

test('selection blocks both new suggestions and an in-flight metadata result', async () => {
  let finish;
  const fixture = renderer({ db: { columns: () => new Promise(resolve => { finish = resolve; }) } });
  fixture.evaluate("mode='query';app.connection={id:'p'};app.database='demo';app.query={id:'q'};rendered=[];renderSqlSuggestions=(editor,context,items)=>rendered.push(items)");
  fixture.editor.value = 'SELECT * FROM users WHERE name';
  fixture.editor.selectionStart = fixture.editor.selectionEnd = fixture.editor.value.length - 2;
  const pending = fixture.evaluate("refreshSqlSuggestions($('#sql'),true)");
  await Promise.resolve();
  fixture.editor.selectionEnd += 1;
  finish({ ok: true, data: [{ name: 'name', type: 'text' }] });
  await pending;
  assert.equal(fixture.evaluate('rendered.length'), 1);
  await fixture.evaluate("refreshSqlSuggestions($('#sql'),true)");
  assert.equal(fixture.evaluate('sqlAutocomplete.context'), null);
  assert.equal(fixture.evaluate('rendered.length'), 1);
});
