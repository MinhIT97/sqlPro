'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createEncryptedCatalog } = require('../electron/backup-encrypted-catalog.cjs');
const { backupName, backupDirectory, resolveBackup, listBackups } = require('../electron/backup-catalog.cjs');
const { decryptBackupFile } = require('../electron/backup-crypto.cjs');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'sqlpro-encrypted-catalog-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profileId='p',database='Exact_DB',id=backupName(),dir=backupDirectory(root,profileId,database);
  fs.mkdirSync(dir,{recursive:true}); const sql='CREATE TABLE restored (id INT);\nINSERT INTO restored VALUES (1);\n';
  fs.writeFileSync(path.join(dir,id),sql);
  return {root,profileId,database,id,dir,sql,catalog:createEncryptedCatalog({root,profileId,database,...options})};
}
test('encrypted catalog discovers archives and decrypts into a new SQL identity, preserving the original',async t=>{
  const r=fixture(t); assert.deepEqual(await r.catalog.list(),[]);
  const encrypted=await r.catalog.encrypt(r.id,'fixture-password');
  assert.equal((await r.catalog.list())[0].id,encrypted.id);
  await assert.rejects(resolveBackup(r.root,r.profileId,r.database,encrypted.id));
  const restored=await r.catalog.decrypt(encrypted.id,'fixture-password');
  assert.notEqual(restored.id,r.id); assert.equal(restored.restore,'not-tested');
  assert.equal(fs.readFileSync(path.join(r.dir,restored.id),'utf8'),r.sql);
  assert.equal(fs.readFileSync(path.join(r.dir,r.id),'utf8'),r.sql);
  assert.equal((await listBackups(r.root,r.profileId,r.database)).length,2);
  assert.equal((await r.catalog.list()).length,1);
});
test('wrong password, tampering and decompression quota cannot publish a usable SQL file',async t=>{
  const r=fixture(t); const archive=await r.catalog.encrypt(r.id,'fixture-password');
  const before=fs.readdirSync(r.dir).sort();
  await assert.rejects(r.catalog.decrypt(archive.id,'incorrect-password'),{code:'BACKUP_DECRYPTION_FAILED'});
  await assert.rejects(decryptBackupFile(path.join(r.dir,archive.id),path.join(r.dir,'quota.sql'),{passphrase:'fixture-password',maxPlaintextBytes:8}),{code:'BACKUP_DECOMPRESSION_LIMIT'});
  const bytes=fs.readFileSync(path.join(r.dir,archive.id));bytes[bytes.length-1]^=1;fs.writeFileSync(path.join(r.dir,archive.id),bytes);
  await assert.rejects(r.catalog.decrypt(archive.id,'fixture-password'),{code:'BACKUP_DECRYPTION_FAILED'});
  assert.deepEqual(fs.readdirSync(r.dir).sort(),before);
});
test('publication context drift, cancellation and repeated encryption preserve existing files',async t=>{
  let checks=0;const r=fixture(t,{checkContext(){if(++checks>=3)throw Object.assign(new Error('context fixture'),{code:'BACKUP_CONTEXT_CHANGED'});}});
  await assert.rejects(r.catalog.encrypt(r.id,'fixture-password'),{code:'BACKUP_CONTEXT_CHANGED'});
  assert.deepEqual(fs.readdirSync(r.dir),[r.id]);
  const catalog=createEncryptedCatalog(r);const archive=await catalog.encrypt(r.id,'fixture-password');
  const before=fs.readFileSync(path.join(r.dir,archive.id));
  await assert.rejects(catalog.encrypt(r.id,'fixture-password'),{code:'BACKUP_DESTINATION_EXISTS'});
  assert.deepEqual(fs.readFileSync(path.join(r.dir,archive.id)),before);
  const controller=new AbortController();controller.abort();
  await assert.rejects(createEncryptedCatalog({...r,signal:controller.signal}).decrypt(archive.id,'fixture-password'),{code:'BACKUP_CRYPTO_CANCELLED'});
  await assert.rejects(catalog.decrypt('../outside.sql.enc','fixture-password'),{code:'INVALID_BACKUP_ARCHIVE'});
});
test('production Main crypto IPC lists, encrypts and decrypts without creating a database session',async t=>{
  const r=fixture(t),handlers=new Map(),root=path.join(__dirname,'../electron');
  const profile={id:r.profileId,host:'fixture',readOnly:true};
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpro-archive-external-'));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  let savePath = null, openPath = null, confirmation = 0, dialogOptions;
  const dialog = {
    showSaveDialog: async () => ({ canceled: !savePath, filePath: savePath }),
    showOpenDialog: async () => ({ canceled: !openPath, filePaths: openPath ? [openPath] : [] }),
    showMessageBox: async (window, options) => { dialogOptions = options; return { response: confirmation }; }
  };
  const context={require(id){
    if(id==='electron')return {dialog,app:{requestSingleInstanceLock:()=>true,on(){},whenReady:()=>new Promise(()=>{}),getPath:()=>r.root},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)}};
    if(id==='./database.cjs')return {DatabaseSession:class{constructor(){throw new Error('Crypto must not open a database');}}};
    if(id==='./store.cjs')return {getWithSecrets:()=>profile};
    if(['./sync.cjs','./navicat.cjs'].includes(id))return {};
    return require(id.startsWith('./')?path.join(root,id):id);
  },__dirname:root,process,Buffer,console,setTimeout,clearTimeout,AbortController};
  vm.runInNewContext(fs.readFileSync(path.join(root,'main.cjs'),'utf8'),context);
  const call=(name,payload)=>handlers.get(name)({sender:null},payload);
  const scope={profileId:r.profileId,database:r.database};
  for (const change of [{ taskId: '' }, { passphrase: 'x'.repeat(1025) }, { compress: 'true' }]) {
    const rejected = await call('db:encrypt-backup', { ...scope, id: r.id, passphrase: 'fixture-password', taskId: 'valid-task', ...change });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'INVALID_BACKUP_CRYPTO_REQUEST');
    assert.deepEqual(fs.readdirSync(r.dir), [r.id]);
  }
  const encrypted=await call('db:encrypt-backup',{...scope,id:r.id,passphrase:'fixture-password',taskId:'crypto-encrypt'});
  assert.equal(encrypted.ok,true,JSON.stringify(encrypted.error));
  assert.equal((await call('db:list-encrypted-backups',scope)).data[0].id,encrypted.data.id);
  const decrypted=await call('db:decrypt-backup',{...scope,id:encrypted.data.id,passphrase:'fixture-password',taskId:'crypto-decrypt'});
  assert.equal(decrypted.ok,true,JSON.stringify(decrypted.error));
  assert.notEqual(decrypted.data.id,r.id);
  assert.equal(fs.readFileSync(path.join(r.dir,decrypted.data.id),'utf8'),r.sql);
  const archiveScope = { ...scope, id: encrypted.data.id, taskId: 'archive-action' };
  assert.equal((await call('db:export-encrypted-backup', archiveScope)).data.canceled, true);
  savePath = path.join(r.dir, 'do-not-export.enc');
  assert.equal((await call('db:export-encrypted-backup', archiveScope)).error.code, 'PROTECTED_EXPORT_PATH');
  savePath = path.join(external, 'exported.enc');
  assert.equal((await call('db:export-encrypted-backup', { ...archiveScope, filePath: r.file })).ok, true);
  assert.deepEqual(fs.readFileSync(savePath), fs.readFileSync(path.join(r.dir, encrypted.data.id)));
  assert.equal((await call('db:export-encrypted-backup', archiveScope)).ok, false);
  assert.equal((await call('db:import-encrypted-backup', archiveScope)).data.canceled, true);
  openPath = savePath;
  const imported = await call('db:import-encrypted-backup', archiveScope);
  assert.equal(imported.ok, true, JSON.stringify(imported.error));
  assert.notEqual(imported.data.id, encrypted.data.id);
  assert.equal(imported.data.authenticated, false);
  const remove = { ...archiveScope, id: imported.data.id };
  assert.equal((await call('db:delete-encrypted-backup', remove)).data.canceled, true);
  assert.equal(dialogOptions.defaultId, 0); assert.equal(dialogOptions.cancelId, 0);
  confirmation = 1;
  assert.equal((await call('db:delete-encrypted-backup', remove)).data.deleted, true);
  assert.equal(fs.existsSync(path.join(r.dir, encrypted.data.id)), true);
  assert.equal(fs.readFileSync(path.join(r.dir, r.id), 'utf8'), r.sql);

});

test('source file drift before publication rejects both encrypted and plaintext outputs',async t=>{
  const {encryptBackupFile,decryptBackupFile}=require('../electron/backup-crypto.cjs');
  const r=fixture(t),archive=path.join(r.dir,`${r.id}.enc`);
  let changed=false;
  await assert.rejects(encryptBackupFile(path.join(r.dir,r.id),archive,{passphrase:'fixture-password',checkContext(){if(!changed){changed=true;fs.appendFileSync(path.join(r.dir,r.id),'-- changed');}}}),{code:'BACKUP_FILE_CHANGED'});
  assert.equal(fs.existsSync(archive),false);
  await encryptBackupFile(path.join(r.dir,r.id),archive,{passphrase:'fixture-password'});
  const destination=path.join(r.dir,'not-published.sql');changed=false;
  await assert.rejects(decryptBackupFile(archive,destination,{passphrase:'fixture-password',checkContext(){if(!changed){changed=true;fs.appendFileSync(archive,'changed');}}}),{code:'BACKUP_FILE_CHANGED'});
  assert.equal(fs.existsSync(destination),false);
  assert.equal(fs.readdirSync(r.dir).some(name=>name.endsWith('.part')),false);
});
