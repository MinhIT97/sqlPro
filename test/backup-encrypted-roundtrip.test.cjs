'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { createEncryptedCatalog } = require('../electron/backup-encrypted-catalog.cjs');
const { backupDirectory, backupName, resolveBackup } = require('../electron/backup-catalog.cjs');
const { DatabaseSession } = require('../electron/database.cjs');
const { buildManifest, writeManifest, fileIdentity, readManifest } = require('../electron/backup-file.cjs');
const { writeAnnotations } = require('../electron/backup-annotations.cjs');
const { runRestoreTrial } = require('../electron/restore-trial.cjs');
const { recordBackupTrial } = require('../electron/backup-trial-report.cjs');

for (const engine of ['MYSQL','MARIA']) {
  const port = Number(process.env[`SQLPRO_REVIEW_${engine}_PORT`]);
  test(`${engine} encrypted archive authenticates before restore and retains out-of-scope marker`,{skip:!port,timeout:30000},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'sqlpro-encrypted-restore-'));
    const database=`sqlpro_enc_${crypto.randomBytes(8).toString('hex')}`;
    const profile={id:'encrypted-fixture',host:'127.0.0.1',port,user:'root',password:'',database,ssl:{enabled:false},ssh:{enabled:false}};
    const admin=await mysql.createConnection({host:'127.0.0.1',port,user:'root',password:''}),session=new DatabaseSession(profile);
    const marker=crypto.randomUUID();let created=false;
    try {
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);created=true;
      await admin.query(`USE \`${database}\``);
      await admin.query('CREATE TABLE outside_selection (id INT PRIMARY KEY, marker VARCHAR(50)) ENGINE=InnoDB');
      await admin.execute('INSERT INTO outside_selection VALUES(1,?)',[marker]);
      const id=backupName(),directory=backupDirectory(root,profile.id,database);fs.mkdirSync(directory,{recursive:true});
      const sql="CREATE TABLE restored (id BIGINT PRIMARY KEY, label VARCHAR(100)) ENGINE=InnoDB;\nINSERT INTO restored VALUES (9007199254740993,'Khôi phục kiểm chứng');\n";
      fs.writeFileSync(path.join(directory,id),sql);
      await writeManifest(path.join(directory, id), buildManifest(crypto.createHash('sha256').update(sql).digest('hex'),
        { bytes: Buffer.byteLength(sql), rows: 1, objects: 1, tables: 1 },
        { source: { profileId: profile.id, database }, selection: { tables: ['restored'] } }));
      await writeAnnotations(path.join(directory, id), { name: 'Bản trước nâng cấp', note: 'roundtrip metadata', pinned: true });
      const catalog=createEncryptedCatalog({root,profileId:profile.id,database});
      const archive=await catalog.encrypt(id,'fixture-password');
      await t.test('wrong key creates no SQL identity or database changes',async()=>{
        const before=fs.readdirSync(directory).sort();
        await assert.rejects(catalog.decrypt(archive.id,'wrong-fixture-password'),{code:'BACKUP_DECRYPTION_FAILED'});
        assert.deepEqual(fs.readdirSync(directory).sort(),before);
        assert.equal((await admin.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='restored'",[database]))[0][0].n,0);
        await assert.rejects(resolveBackup(root,profile.id,database,archive.id));
      });
      let recoveredFile;
      await t.test('authenticated plaintext uses the existing restore preflight and preserves original SQL',async()=>{
        const decrypted=await catalog.decrypt(archive.id,'fixture-password');
        assert.notEqual(decrypted.id,id);
        const filePath=await resolveBackup(root,profile.id,database,decrypted.id); recoveredFile = filePath;
        assert.equal(fs.readFileSync(filePath,'utf8'),sql);
        await session.connect();
        const result=await session.restoreDatabase({database,filePath});
        assert.ok(result.executed>=2 || result.statements>=2);
        const rows=(await admin.query('SELECT CAST(id AS CHAR) AS id,label FROM restored'))[0];
        assert.equal(rows[0].id,'9007199254740993');assert.equal(rows[0].label,'Khôi phục kiểm chứng');
        assert.equal((await admin.query('SELECT marker FROM outside_selection'))[0][0].marker,marker);
        assert.equal(fs.readFileSync(path.join(directory,id),'utf8'),sql);
      });
      await t.test('decrypted SQL runs an isolated trial and records proof without changing the original database', async () => {
        assert.ok(recoveredFile);
        const trialSession = new DatabaseSession(profile);
        try {
          await trialSession.connect();
          const identity = fileIdentity(fs.statSync(recoveredFile));
          const report = await runRestoreTrial({ session: trialSession, filePath: recoveredFile, taskId: 'encrypted-trial' });
          assert.equal(report.status, 'verified', report.error);
          assert.equal(report.cleanup, 'removed', report.cleanupError);
          await recordBackupTrial(recoveredFile, report, identity);
          assert.equal(report.reportSaveError, undefined);
          assert.equal((await readManifest(recoveredFile)).manifest.verification.restore, 'verified');
          assert.equal((await admin.query('SELECT marker FROM outside_selection'))[0][0].marker, marker);
          assert.equal((await admin.query('SELECT COUNT(*) AS n FROM restored'))[0][0].n, 1);
          assert.equal((await admin.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [report.database]))[0][0].n, 0);
        } finally { await trialSession.close(); }
      });
    } finally {
      await session.close();
      try {
        if(created){
          assert.equal((await admin.query(`SELECT marker FROM \`${database}\`.outside_selection`))[0][0].marker,marker);
          await admin.query(`DROP DATABASE \`${database}\``);
        }
      } finally {await admin.end();fs.rmSync(root,{recursive:true,force:true});}
    }
  });
}
