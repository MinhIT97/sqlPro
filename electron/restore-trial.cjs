'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { SqlScriptParser, scrubSql, stripLeadingComments, assertStatementScope, skipReason } = require('./sql-script.cjs');
const { readManifest, fileIdentity, sameFileIdentity } = require('./backup-file.cjs');
const { assertWritable } = require('./connection-policy.cjs');

function validateTrialStatement(statement,database) {
  if (skipReason(statement)) return;
  const clean=stripLeadingComments(statement);
  // Restricted first release: table definitions and literal INSERT data only.
  // Reject executable comments instead of interpreting version-dependent code.
  if (/\/\*(?:!|M!|\+)/i.test(clean) || /\\/.test(clean)) throw new Error('Phục hồi thử chưa hỗ trợ executable comment hoặc escape backslash.');
  const analysis=assertStatementScope(clean,database);
  const sql=scrubSql(clean).replace(/`(?:``|[^`])*`/g,'identifier');
  if (analysis.command==='SET') {
    // Scope validation constrains assignment names, but RHS expressions can call
    // stored functions. Trial restores only need literal/variable assignments.
    if (/\b(?:SELECT|FROM|CALL)\b|[();]/i.test(sql)) throw new Error('Phục hồi thử chỉ hỗ trợ SET với literal hoặc biến session.');
    return;
  }
  if (analysis.command==='DROP' && /^DROP\s+TABLE\b/i.test(sql)) return;
  if (analysis.command==='INSERT' && /^INSERT\s+INTO\s+(?:identifier|[A-Za-z_][\w$]*)\s*(?:\([^)]*\))?\s+VALUES\s*\(/i.test(sql)) {
    const tail=sql.slice(sql.search(/\bVALUES\b/i)+6);
    if (/\b(?!NULL\b|TRUE\b|FALSE\b)[A-Za-z_$][\w$]*\b/i.test(tail.replace(/0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi,''))) throw new Error('Phục hồi thử chỉ nhận INSERT với giá trị literal.');
    return;
  }
  if (analysis.command==='CREATE' && /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:identifier|[A-Za-z_][\w$]*)\s*\(/i.test(sql)) {
    const engines=[...sql.matchAll(/\bENGINE\s*=\s*([A-Za-z_][\w$]*)/gi)].map(match=>match[1].toUpperCase());
    if (/\b(?:SELECT|DIRECTORY|TABLESPACE|CONNECTION|GENERATED|CHECK|PARTITION)\b/i.test(sql)
        || engines.length!==1 || engines[0]!=='INNODB') throw new Error('Phục hồi thử hiện chỉ hỗ trợ bảng InnoDB thông thường.');
    const body=sql.slice(sql.indexOf('('));
    const functions=[...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)];
    const allowed=new Set('TINYINT SMALLINT MEDIUMINT INT INTEGER BIGINT DECIMAL NUMERIC FLOAT DOUBLE REAL BIT CHAR VARCHAR BINARY VARBINARY TIME DATETIME TIMESTAMP ENUM SET KEY INDEX'.split(' '));
    if (functions.some(match => {
      const name = match[1].toUpperCase();
      // Quoted names are only permitted as key/index or referenced table names.
      // Treating every quoted name as syntax would admit DEFAULT (`udf`()).
      if (name === 'IDENTIFIER') return !/\b(?:KEY|INDEX|REFERENCES)\s+$/i.test(body.slice(0,match.index));
      return !allowed.has(name);
    })) throw new Error('Định nghĩa bảng có biểu thức chưa hỗ trợ trong phục hồi thử.');
    return;
  }
  throw new Error('Phục hồi thử hiện chỉ nhận bảng InnoDB và dữ liệu INSERT. View, trigger, routine và event chưa được hỗ trợ.');
}

function createTrialControl(session,taskId,timeoutMs=10*60*1000) {
  const controller=new AbortController();
  const task={canceled:false};
  let timedOut=false;
  const cancel=()=>{
    task.canceled=true;controller.abort();
    if(task.scanCancelFlag)Atomics.store(task.scanCancelFlag,0,1);
    session.cancelTask?.(taskId);
    return true;
  };
  const timer=setTimeout(()=>{timedOut=true;cancel();},timeoutMs);
  return {task,signal:controller.signal,cancel,
    check(){if(task.canceled)throw Object.assign(new Error(timedOut?'Phục hồi thử vượt thời gian cho phép.':'Đã hủy phục hồi thử.'),{code:timedOut?'RESTORE_TRIAL_TIMEOUT':'RESTORE_TRIAL_CANCELLED'});},
    finish(){clearTimeout(timer);},get timedOut(){return timedOut;}};
}

async function trialHash(filePath,control) {
  const hash=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(filePath,{signal:control.signal})){control.check();hash.update(chunk);}
  return hash.digest('hex');
}

async function runRestoreTrial({session,filePath,onProgress,taskId=null,control:providedControl,journal}) {
  assertWritable(session.profile);
  const control=providedControl || createTrialControl(session,taskId);
  const database=`sqlpro_trial_${crypto.randomBytes(16).toString('hex')}`;
  const marker=`owner_${crypto.randomBytes(12).toString('hex')}`;
  const token=crypto.randomBytes(32).toString('hex');
  const quote=value=>'`'+value.replace(/`/g,'``')+'`';
  const report={database,startedAt:new Date().toISOString(),status:'failed',cleanup:'not-created'};
  let created=false;
  let marked=false;
  let temporary;
  let journalId;
  try {
    control.check();
    const before=await fs.promises.stat(filePath);
    if (before.size>512*1024*1024) throw new Error('Phục hồi thử hiện giới hạn tệp 512 MiB.');
    const {manifest,error}=await readManifest(filePath);
    if (error) throw new Error(error);
    const sourcePath=filePath;
    temporary=await fs.promises.mkdtemp(path.join(os.tmpdir(),'sqlpro-trial-'));
    filePath=path.join(temporary,'backup.sql');
    let copiedBytes = 0;
    const byteLimit = new Transform({
      transform(chunk, encoding, done) {
        copiedBytes += chunk.length;
        done(copiedBytes > 512 * 1024 * 1024 ? new Error('Tệp vượt giới hạn 512 MiB trong khi sao chép.') : null, chunk);
      }
    });
    await pipeline(fs.createReadStream(sourcePath),byteLimit,fs.createWriteStream(filePath,{flags:'wx',mode:0o600}),{signal:control.signal});
    control.check();
    await fs.promises.chmod(filePath,0o600);
    if (!sameFileIdentity(fileIdentity(before),fileIdentity(await fs.promises.stat(sourcePath)))) throw new Error('Tệp nguồn thay đổi trong khi tạo bản thử.');
    const parser=new SqlScriptParser();
    const hash=crypto.createHash('sha256');
    const stream=fs.createReadStream(filePath,{encoding:'utf8',highWaterMark:1024*1024,signal:control.signal});
    for await (const chunk of stream) {
      control.check();
      hash.update(chunk);
      for(const statement of parser.push(chunk))validateTrialStatement(statement,database);
    }
    for(const statement of parser.end())validateTrialStatement(statement,database);
    report.checksum=hash.digest('hex');
    if (manifest && manifest.checksum.value.toLowerCase()!==report.checksum) throw new Error('Checksum backup không khớp manifest.');
    if (await trialHash(filePath,control)!==report.checksum) throw new Error('Tệp thay đổi trong khi kiểm tra.');
    // Scan the original under the temporary scope before creating any schema.
    await session.scanRestoreInventoryInWorker({filePath,database,totalBytes:before.size,dropExisting:false,task:control.task,onProgress});
    control.check();
    if (journal) journalId = journal.prepare({ database, marker, token });
    await session.raw(`CREATE DATABASE ${quote(database)}`);
    created=true;report.cleanup='pending';
    await session.raw(`CREATE TABLE ${quote(database)}.${quote(marker)} (token VARCHAR(64) NOT NULL) ENGINE=InnoDB`);
    await session.raw(`INSERT INTO ${quote(database)}.${quote(marker)} VALUES (?)`,[token]);
    marked=true;
    control.check();
    const restored=await session.restoreDatabase({filePath,database,dropExisting:false,taskId},onProgress);
    control.check();
    if (await trialHash(filePath,control)!==report.checksum) throw new Error('Tệp thay đổi trong khi phục hồi thử.');
    report.verification=restored.verification;
    report.inventory=restored.inventory;
    report.serverVersion=session.version || null;
    report.status=restored.verification.status;
  } catch(error) {
    try{control.check();}catch(cancelled){error=cancelled;report.status=control.timedOut?'timeout':'cancelled';}
    report.error=error.message;
    report.errorCode=error.code || 'RESTORE_TRIAL_FAILED';
  } finally {
    control.finish();
    if (created) {
      try {
        if (!marked) throw new Error('Chưa xác nhận được marker sở hữu database tạm.');
        const ownership=await session.raw(`SELECT token FROM ${quote(database)}.${quote(marker)}`, [], 15000);
        if (ownership.rows?.length!==1 || ownership.rows[0].token!==token) throw new Error('Marker sở hữu không khớp.');
        await session.raw(`DROP DATABASE ${quote(database)}`, [], 15000);
        report.cleanup='removed';
      } catch(error) {report.cleanup='manual-required';report.cleanupError=error.message;}
    }
    report.finishedAt=new Date().toISOString();
    // Retain evidence if CREATE returned an ambiguous connection error, or if
    // ownership/drop could not be confirmed. Recovery verifies it independently.
    if (journalId) {
      report.recoveryId = journalId;
      if (!created) report.cleanup = 'check-required';
      if (report.cleanup === 'removed') {
        try { journal.remove(journalId); }
        catch (error) { report.journalError = error.message; }
      }
    }
    if(temporary)await fs.promises.rm(temporary,{recursive:true,force:true}).catch(()=>{});
  }
  return report;
}

module.exports={runRestoreTrial,validateTrialStatement,createTrialControl};
