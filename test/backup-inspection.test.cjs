'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {BackupInspection}=require('../electron/backup-inspection.cjs');
const request={profileId:'p',database:'db',id:'backup',filePath:'/test',taskId:'task'};
const result=()=>({inventory:{tables:new Map([['t',{name:'t'}]]),createdObjects:[],statements:2},checksum:'abc'});

test('inspection caches only matching file identities and rejects files changed during scanning',async()=>{
  let version=1,calls=0;
  const service=new BackupInspection({stat:async()=>({size:version}),scan:async()=>{calls++;return result();}});
  assert.equal((await service.inspect(request)).cached,false);
  assert.equal((await service.inspect(request)).cached,true);
  assert.equal(calls,1);
  version++;
  await service.inspect(request);assert.equal(calls,2);
  version++;
  service.scan=async()=>{version++;return result();};
  await assert.rejects(service.inspect(request),{code:'BACKUP_FILE_CHANGED'});
});

test('inspection cancellation is scoped and releases admission without caching cancelled results',async()=>{
  let finish;
  const service=new BackupInspection({stat:async()=>({size:1}),scan:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=service.inspect(request);
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(service.inspect({...request,id:'other'}),{code:'BACKUP_SCAN_BUSY'});
  assert.equal(service.cancel('other','task').canceled,false);
  assert.equal(service.cancel('p','task').canceled,true);
  finish(result());
  await assert.rejects(pending,{code:'BACKUP_SCAN_CANCELLED'});
  assert.equal(service.active,null);assert.equal(service.cache.size,0);
});

test('inspection output and cache have fixed limits',async()=>{
  const large=result();large.inventory.createdObjects=Array.from({length:6000},(_,i)=>({name:`o${i}`,type:'view',body:'not returned'}));
  const service=new BackupInspection({stat:async()=>({size:1}),scan:async()=>large});
  const inventory=await service.inspect(request);
  assert.equal(inventory.objects.length,5000);assert.equal(inventory.truncated,true);
  assert.equal(inventory.objects[0].body,undefined);
  for(let i=0;i<6;i++)await service.inspect({...request,id:String(i)});
  assert.equal(service.cache.size,4);
});

test('duplicate inspections share one scan and progress is scoped to its subscribers',async()=>{
  let finish,report,calls=0;
  const service=new BackupInspection({stat:async()=>({size:100}),scan:options=>{
    calls++;report=options.onProgress;return new Promise(resolve=>{finish=resolve;});
  }});
  const first=service.inspect(request);
  await new Promise(resolve=>setImmediate(resolve));
  const second=service.inspect({...request,taskId:'second'});
  await new Promise(resolve=>setImmediate(resolve));
  report({bytes:40,statements:8,currentObject:'not exposed'});
  assert.equal(calls,1);
  assert.deepEqual(service.status('p','second'),{running:true,cancelling:false,bytes:40,totalBytes:100,statements:8});
  assert.deepEqual(service.status('other','second'),{running:false});
  finish(result());
  assert.deepEqual(await first,await second);
  assert.deepEqual(service.status('p','second'),{running:false});
});

test('cancelling a shared inspection settles all subscribers and does not create stale cache',async()=>{
  let finish;
  const service=new BackupInspection({stat:async()=>({size:1}),scan:()=>new Promise(resolve=>{finish=resolve;})});
  const first=service.inspect(request);
  await new Promise(resolve=>setImmediate(resolve));
  const second=service.inspect({...request,taskId:'second'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(service.cancel('p','second').canceled,true);
  assert.equal(service.status('p','task').cancelling,true);
  const settled=Promise.allSettled([first,second]);
  finish(result());
  for(const entry of await settled)assert.equal(entry.reason.code,'BACKUP_SCAN_CANCELLED');
  assert.equal(service.cache.size,0);
});

test('cancel during final file stat cannot publish or cache a successful inventory',async()=>{
  let releaseStat,stats=0;
  const service=new BackupInspection({stat:async()=>{
    if(++stats===2)await new Promise(resolve=>{releaseStat=resolve;});
    return {size:1};
  },scan:async()=>result()});
  const pending=service.inspect(request);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(service.cancel('p','task').canceled,true);
  releaseStat();
  await assert.rejects(pending,{code:'BACKUP_SCAN_CANCELLED'});
  assert.equal(service.cache.size,0);
});
