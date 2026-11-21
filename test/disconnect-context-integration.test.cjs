'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const mysql = require('mysql2/promise');

test('real MySQL sessions reject stale disconnect approvals and roll back only a freshly approved transaction', {
  skip: !process.env.SQLPRO_TEST_MYSQL_PORT, timeout: 30000
}, async () => {
  const port = Number(process.env.SQLPRO_TEST_MYSQL_PORT), token = crypto.randomBytes(12).toString('hex');
  const database = `sqlpro_disconnect_${token}`, userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-disconnect-db-'));
  const root = path.join(__dirname, '../electron'), handlers = new Map();
  const profile = { id:'fixture', name:'fixture', host:'127.0.0.1', port, user:'root', password:'', database,
    environment:'local', ssl:{enabled:false}, ssh:{enabled:false} };
  const context = vm.createContext({
    require(id) {
      if (id === 'electron') return { app: { requestSingleInstanceLock:()=>true, on(){}, whenReady:()=>new Promise(()=>{}), getPath:()=>userData },
        ipcMain:{handle:(name, callback)=>handlers.set(name, callback)} };
      if (id === './store.cjs') return { getWithSecrets:()=>structuredClone(profile) };
      if (id === './sync.cjs' || id === './navicat.cjs') return {};
      return require(id.startsWith('./') ? path.join(root,id) : id);
    }, __dirname:root, process, Buffer, console, setTimeout, clearTimeout, AbortController
  });
  vm.runInContext(fs.readFileSync(path.join(root,'main.cjs'),'utf8'),context);
  const call = (name, ...args) => handlers.get(name)({sender:null}, ...args);
  const registry = vm.runInContext('sessionRegistry', context);
  let admin, created = false;
  try {
    admin = await mysql.createConnection({host:'127.0.0.1',port,user:'root'});
    await admin.query(`CREATE DATABASE \`${database}\``); created = true;
    await admin.query(`CREATE TABLE \`${database}\`.fixture_marker (token VARCHAR(64) PRIMARY KEY)`);
    await admin.query(`INSERT INTO \`${database}\`.fixture_marker VALUES (?)`,[token]);
    await admin.query(`CREATE TABLE \`${database}\`.items (id INT PRIMARY KEY, value INT) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO \`${database}\`.items VALUES (1,1)`);
    assert.equal((await call('db:connect','fixture')).ok,true);
    let entry = registry.entries.get('fixture');
    await entry.session.runQueryScript(`START TRANSACTION; UPDATE \`${database}\`.items SET value=2 WHERE id=1`,30000,true);
    const observed = (await call('db:disconnect','fixture')).data;
    assert.equal(observed.needsConfirmation,true); assert.equal(observed.sessionId,entry.sessionId);
    await entry.session.runQueryScript(`UPDATE \`${database}\`.items SET value=3 WHERE id=1`,30000,true);
    const options = {force:true,sessionId:observed.sessionId,transactionRevision:observed.transactionRevision};
    assert.equal((await call('db:disconnect','fixture',options)).error.code,'DISCONNECT_CONTEXT_CHANGED');
    assert.equal(registry.entries.get('fixture'),entry); assert.equal(entry.session.inTransaction,true);
    const [committed] = await admin.query(`SELECT value FROM \`${database}\`.items WHERE id=1`);
    assert.equal(committed[0].value,1);
    const fresh = (await call('db:disconnect','fixture')).data;
    assert.equal((await call('db:disconnect','fixture',{force:true,sessionId:fresh.sessionId,transactionRevision:fresh.transactionRevision})).data.disconnected,true);
    const [rolledBack] = await admin.query(`SELECT value FROM \`${database}\`.items WHERE id=1`);
    assert.equal(rolledBack[0].value,1);
    assert.equal((await call('db:connect','fixture')).ok,true);
    entry = registry.entries.get('fixture');
    assert.notEqual(entry.sessionId,observed.sessionId);
    await entry.session.runQueryScript(`START TRANSACTION; UPDATE \`${database}\`.items SET value=4 WHERE id=1`,30000,true);
    assert.equal((await call('db:disconnect','fixture',options)).error.code,'DISCONNECT_CONTEXT_CHANGED');
    assert.equal(registry.entries.get('fixture'),entry); assert.equal(entry.session.inTransaction,true);
  } finally {
    await registry.closeAll();
    try {
      if (created) {
        const [markers] = await admin.query(`SELECT token FROM \`${database}\`.fixture_marker`);
        assert.equal(markers.length,1); assert.equal(markers[0].token,token);
        await admin.query(`DROP DATABASE \`${database}\``);
      }
    } finally { await admin?.end(); fs.rmSync(userData,{recursive:true,force:true}); }
  }
});
