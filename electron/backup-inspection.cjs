'use strict';

// A single scanner bounds CPU/file I/O; cached inventories are display-only.
class BackupInspection {
  constructor({stat,scan,ttlMs=300000,timeoutMs=300000,now=Date.now}) {
    Object.assign(this,{stat,scan,ttlMs,timeoutMs,now});
    this.cache=new Map();
    this.active=null;
    this.generation=0;
  }

  identity(stats) {
    return [stats.dev,stats.ino,stats.size,stats.mtimeMs,stats.ctimeMs].join(':');
  }

  invalidate() {
    this.generation++;
    this.cache.clear();
    const job = this.active;
    if (job) this.cancel(job.profileId, job.taskId);
  }

  cancel(profileId,taskId) {
    const job=this.active;
    if (!job || job.profileId!==profileId || !job.subscribers.has(taskId)) return {canceled:false};
    job.task.canceled=true;
    if (job.task.scanCancelFlag) Atomics.store(job.task.scanCancelFlag,0,1);
    return {canceled:true};
  }

  status(profileId,taskId) {
    const job=this.active;
    if (!job || job.profileId!==profileId || !job.subscribers.has(taskId)) return {running:false};
    return {running:true,cancelling:job.task.canceled,...job.progress};
  }

  observe(job, profileId, taskId, signal) {
    if (!signal) return job.promise;
    const cancel = () => this.cancel(profileId, taskId);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    return job.promise.finally(() => signal.removeEventListener('abort', cancel));
  }

  async inspect({profileId,database,id,filePath,taskId,fresh=false,signal}) {
    if (typeof taskId!=='string' || !taskId || taskId.length>120) throw new Error('Thiếu mã tác vụ quét backup.');
    const generation = this.generation;
    const checkCanceled = () => {
      if (signal?.aborted || generation !== this.generation) throw Object.assign(new Error('Đã hủy quét backup.'), { code: 'BACKUP_SCAN_CANCELLED' });
    };
    checkCanceled();
    const before=await this.stat(filePath);
    checkCanceled();
    const identity=this.identity(before);
    const key=JSON.stringify([profileId,database,id]);
    const cached=this.cache.get(key);
    if (!fresh && cached && cached.identity===identity && cached.expiresAt>this.now()) return {...cached.result,cached:true};
    this.cache.delete(key);
    if (this.active) {
      if (this.active.key===key && this.active.identity===identity && !this.active.task.canceled) {
        if (this.active.subscribers.size>=32 && !this.active.subscribers.has(taskId)) throw Object.assign(new Error('Quá nhiều lượt xem đang dùng chung tác vụ.'),{code:'BACKUP_SCAN_BUSY'});
        this.active.subscribers.add(taskId);
        return this.observe(this.active, profileId, taskId, signal);
      }
      throw Object.assign(new Error('Đang quét một backup khác. Hãy hủy hoặc đợi hoàn tất.'),{code:'BACKUP_SCAN_BUSY'});
    }
    const job={profileId,taskId,key,identity,subscribers:new Set([taskId]),task:{canceled:false},timedOut:false,
      progress:{bytes:0,totalBytes:before.size,statements:0}};
    this.active=job;
    job.promise=this.run(job,{filePath,database,before,key,identity,profileId,taskId});
    return this.observe(job, profileId, taskId, signal);
  }

  async run(job,{filePath,database,before,key,identity,profileId,taskId}) {
    const timer=setTimeout(()=>{job.timedOut=true;this.cancel(profileId,taskId);},this.timeoutMs);
    try {
      const {inventory,checksum}=await this.scan({filePath,database,totalBytes:before.size,task:job.task,
        onProgress:(progress)=>{
          job.progress={bytes:Math.max(0,Math.min(before.size,Number(progress.bytes)||0)),totalBytes:before.size,
            statements:Math.max(0,Number(progress.statements)||0)};
        }});
      if (job.task.canceled) throw Object.assign(new Error(job.timedOut?'Quét backup vượt thời gian cho phép.':'Đã hủy quét backup.'),{code:job.timedOut?'BACKUP_SCAN_TIMEOUT':'BACKUP_SCAN_CANCELLED'});
      if (this.identity(await this.stat(filePath))!==identity) throw Object.assign(new Error('Tệp backup đã thay đổi khi quét. Hãy thử lại.'),{code:'BACKUP_FILE_CHANGED'});
      if (job.task.canceled) throw new Error('Backup scan cancelled before publishing.');
      const tables=[...inventory.tables.values()];
      const result={tables:tables.slice(0,5000).map(entry=>({name:entry.name})),
        objects:inventory.createdObjects.slice(0,5000).map(entry=>({name:entry.name,type:entry.type})),
        truncated:inventory.objectsTruncated || tables.length>5000 || inventory.createdObjects.length>5000,
        statements:inventory.statements,checksum,selectionPreview:inventory.selectionPreview || null};
      this.cache.set(key,{identity,expiresAt:this.now()+this.ttlMs,result});
      while (this.cache.size>4) this.cache.delete(this.cache.keys().next().value);
      return {...result,cached:false};
    } catch(error) {
      if (job.task.canceled) throw Object.assign(new Error(job.timedOut?'Quét backup vượt thời gian cho phép.':'Đã hủy quét backup.'),{code:job.timedOut?'BACKUP_SCAN_TIMEOUT':'BACKUP_SCAN_CANCELLED'});
      throw error;
    } finally {clearTimeout(timer);if(this.active===job)this.active=null;}
  }
}

module.exports={BackupInspection};
