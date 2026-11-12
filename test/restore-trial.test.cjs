'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {runRestoreTrial,validateTrialStatement,createTrialControl}=require('../electron/restore-trial.cjs');

test('trial rejects unsupported SQL and other schema references',()=>{
  for(const sql of ['CREATE VIEW v AS SELECT 1','CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW SET @x=1','INSERT INTO t VALUES (custom_write())','CREATE TABLE t(id int) ENGINE=FEDERATED','INSERT INTO other.t VALUES (1)'])
    assert.throws(()=>validateTrialStatement(sql,'trial'),sql);
  assert.doesNotThrow(()=>validateTrialStatement('CREATE TABLE `t` (`id` int PRIMARY KEY, `name` varchar(40)) ENGINE=InnoDB','trial'));
  assert.doesNotThrow(()=>validateTrialStatement("INSERT INTO `t` (`id`,`name`) VALUES (1,'hello')",'trial'));
  assert.doesNotThrow(()=>validateTrialStatement('SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE=\'NO_AUTO_VALUE_ON_ZERO\'','trial'));
  assert.doesNotThrow(()=>validateTrialStatement('SET SQL_MODE=@OLD_SQL_MODE','trial'));
  for (const sql of ['SET @x=custom_write()', 'SET SQL_MODE=(SELECT custom_write())', 'SET @x=(SELECT value FROM outside.t)']) {
    assert.throws(()=>validateTrialStatement(sql,'trial'), /SET với literal/);
  }
  assert.throws(()=>validateTrialStatement('CREATE TABLE `t` (`id` int DEFAULT (`custom_write`())) ENGINE=InnoDB','trial'));
  assert.doesNotThrow(()=>validateTrialStatement('CREATE TABLE `t` (`id` int, KEY `by_id` (`id`), FOREIGN KEY (`id`) REFERENCES `parent` (`id`)) ENGINE=InnoDB','trial'));
});

test('trial cleans only its owned database after restore success or failure',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sqlpro-trial-test-'));
  const filePath=path.join(dir,'backup.sql');
  await fs.writeFile(filePath,'CREATE TABLE `t` (`id` int PRIMARY KEY) ENGINE=InnoDB;\nINSERT INTO `t` VALUES (1);');
  try{
    for(const failure of [false,true]){
      const commands=[];let token;
      const session={profile:{},scanRestoreInventoryInWorker:async()=>({}),raw:async(sql,params)=>{
        commands.push(sql);if(sql.startsWith('INSERT INTO'))token=params[0];
        return {rows:sql.startsWith('SELECT token')?[{token}]:[]};
      },restoreDatabase:async()=>{if(failure)throw new Error('fixture failure');return {verification:{status:'verified'},inventory:{tables:1}};}};
      const report=await runRestoreTrial({session,filePath});
      assert.equal(report.status,failure?'failed':'verified');
      assert.equal(report.cleanup,'removed');
      assert.ok(commands.at(-1).startsWith('DROP DATABASE `sqlpro_trial_'));
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('trial refuses to drop a database with mismatched ownership marker',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sqlpro-trial-owner-'));
  const filePath=path.join(dir,'backup.sql');await fs.writeFile(filePath,'CREATE TABLE `t` (`id` int) ENGINE=InnoDB;');
  try{
    const commands=[];
    const session={profile:{},scanRestoreInventoryInWorker:async()=>({}),raw:async(sql)=>{commands.push(sql);return {rows:[{token:'wrong'}]};},restoreDatabase:async()=>({verification:{status:'unverified'},inventory:{}})};
    const report=await runRestoreTrial({session,filePath});
    assert.equal(report.cleanup,'manual-required');
    assert.equal(commands.some(sql=>sql.startsWith('DROP DATABASE')),false);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('trial persists ownership before CREATE and retains ambiguous create failures for recovery', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlpro-trial-journal-order-'));
  const filePath = path.join(dir, 'backup.sql');
  await fs.writeFile(filePath, 'CREATE TABLE `t` (`id` int) ENGINE=InnoDB;');
  try {
    for (const scenario of ['journal-failure', 'ambiguous-create', 'success']) {
      let saved, removed = false, commands = 0;
      const journal = {
        prepare(record) { if (scenario === 'journal-failure') throw new Error('disk full'); saved = record; return 'fixture-id'; },
        remove(id) { assert.equal(id, 'fixture-id'); removed = true; }
      };
      const session = { profile: {}, scanRestoreInventoryInWorker: async () => ({}),
        async raw(sql) {
          commands++;
          assert.ok(saved, 'journal must exist before server mutation');
          if (scenario === 'ambiguous-create') throw new Error('connection lost after send');
          return { rows: [{ token: saved.token }] };
        }, restoreDatabase: async () => ({ verification: { status: 'verified' } }) };
      const report = await runRestoreTrial({ session, filePath, journal });
      assert.equal(removed, scenario === 'success');
      if (scenario === 'journal-failure') assert.equal(commands, 0);
      if (scenario === 'ambiguous-create') assert.equal(report.recoveryId, 'fixture-id');
      assert.equal(JSON.stringify(report).includes(saved?.token || 'no-token-sentinel'), false);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('cancelling before work starts creates no database and returns a cancelled report',async()=>{
  let commands=0;
  const session={profile:{},raw:async()=>{commands++;},cancelTask:()=>false};
  const control=createTrialControl(session,'trial');control.cancel();
  const report=await runRestoreTrial({session,filePath:'/unused',control});
  assert.equal(report.status,'cancelled');assert.equal(report.cleanup,'not-created');assert.equal(commands,0);
});

test('trial timeout cancels the scan and prevents database creation',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sqlpro-trial-timeout-'));
  const filePath=path.join(dir,'backup.sql');await fs.writeFile(filePath,'CREATE TABLE `t` (`id` int) ENGINE=InnoDB;');
  try{
    let commands=0;
    const session={profile:{},cancelTask:()=>false,raw:async()=>{commands++;},
      scanRestoreInventoryInWorker:async({task})=>{
        await new Promise(resolve=>{const timer=setInterval(()=>{if(task.canceled){clearInterval(timer);resolve();}},2);});
      }};
    const control=createTrialControl(session,'timeout',30);
    const report=await runRestoreTrial({session,filePath,control});
    assert.equal(report.status,'timeout');assert.equal(report.errorCode,'RESTORE_TRIAL_TIMEOUT');assert.equal(commands,0);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('cancelling during restore keeps ownership cleanup and never reports verified',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sqlpro-trial-cancel-restore-'));
  const filePath=path.join(dir,'backup.sql');await fs.writeFile(filePath,'CREATE TABLE `t` (`id` int) ENGINE=InnoDB;');
  try{
    let token,control,cancelId;
    const commands=[];
    const session={profile:{},scanRestoreInventoryInWorker:async()=>({}),cancelTask:id=>{cancelId=id;},
      raw:async(sql,params)=>{commands.push(sql);if(sql.startsWith('INSERT INTO'))token=params[0];return {rows:sql.startsWith('SELECT token')?[{token}]:[]};},
      restoreDatabase:async options=>{assert.equal(options.taskId,'trial-cancel');control.cancel();return {verification:{status:'verified'}};}};
    control=createTrialControl(session,'trial-cancel');
    const report=await runRestoreTrial({session,filePath,taskId:'trial-cancel',control});
    assert.equal(cancelId,'trial-cancel');assert.equal(report.status,'cancelled');assert.equal(report.cleanup,'removed');
    assert.ok(commands.at(-1).startsWith('DROP DATABASE'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
