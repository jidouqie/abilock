import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const map=JSON.parse(await fs.readFile(new URL('./fixture-map.json',import.meta.url),'utf8'));
if(process.platform!=='win32'||await fs.readFile(path.join(map.root,'fixture.marker'),'utf8')!=='Abilock synthetic bootstrap runtime')throw new Error('Invalid synthetic fixture');
for(const item of map.coreHashes){assert.equal(crypto.createHash('sha256').update(await fs.readFile(item.path)).digest('hex'),item.sha256);}
const core=await import(pathToFileURL(path.join(map.runtime,'dist/src/isolation-bootstrap.js')).href);
const local=await import(pathToFileURL(path.join(map.runtime,'dist/src/local-state.js')).href);
const locks=await import(pathToFileURL(path.join(map.runtime,'dist/src/process-lock.js')).href);
const {windowsHostEnvironment}=await import('./windows-paths.mjs');
const passwordA='Synthetic-Windows-Bootstrap-A-20261022!';
const passwordB='Synthetic-Windows-Bootstrap-B-20261022!';
const rootFor=name=>path.join(map.cases,name);
const digest=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const absent=async file=>{try{await fs.lstat(file);return false}catch(error){if(error.code==='ENOENT')return true;throw error}};
const authMatches=async(root,password)=>{
 const value=JSON.parse(await fs.readFile(path.join(root,'data/admin-auth.json'),'utf8'));
 const hash=await new Promise((resolve,reject)=>crypto.scrypt(password,Buffer.from(value.salt,'hex'),64,{N:32768,r:8,p:3,maxmem:64*1024*1024},(error,result)=>error?reject(error):resolve(result)));
 try{return hash.toString('hex')===value.hash}finally{hash.fill(0)}
};
if(process.argv.length===3&&['--concurrent-a','--concurrent-b'].includes(process.argv[2])){
 try{await core.initializeAdminAtRoot(process.argv[2].endsWith('-a')?passwordA:passwordB,rootFor('concurrent'));console.log(JSON.stringify({ok:true}));}
 catch(error){console.log(JSON.stringify({ok:false,code:typeof error.code==='string'?error.code:'REJECTED'}));}
}else if(process.argv.length!==2){process.exitCode=64;}
else{
 const checks=[];let stage='start';
 const pass=(name)=>checks.push({name,passed:true});
 try{
  for(const name of ['baseline','appdata']){
   stage=name;const root=rootFor(name);
   assert.equal(await core.verifyAdminAtRoot(root),'setup-required');
   const profile=path.join(root,'AppData/Local/profile-sentinel.txt');
   const before=name==='appdata'?await digest(profile):null;
   await core.initializeAdminAtRoot(passwordA,root);
   assert.equal(await core.verifyAdminAtRoot(root),'initialized');
   assert.equal(await authMatches(root,passwordA),true);
   const masterBefore=await digest(path.join(root,'service.env'));
   const authBefore=await digest(path.join(root,'data/admin-auth.json'));
   const runtime=await local.loadLocalRuntime({dir:root,readOnly:true,requireExisting:true});await runtime.store.close();
   assert.equal(await digest(path.join(root,'service.env')),masterBefore);
   assert.equal(await digest(path.join(root,'data/admin-auth.json')),authBefore);
   if(before!==null)assert.equal(await digest(profile),before);
   pass(name+'-full-password-initialize-verify-reopen');
  }
  for(const name of ['appdata-file','appdata-wide','existing-data','dirty-tmp']){
   stage=name;const root=rootFor(name);
   const sentinel=path.join(root,map.sentinels[name]);const before=await digest(sentinel);
   await assert.rejects(core.initializeAdminAtRoot(passwordA,root));
   assert.equal(await absent(path.join(root,'service.env')),true);
   assert.equal(await digest(sentinel),before);pass(name+'-rejected-without-configuration-or-reset');
  }
  stage='repeat';const repeated=rootFor('appdata');
  const beforeEnv=await digest(path.join(repeated,'service.env')),beforeAuth=await digest(path.join(repeated,'data/admin-auth.json'));
  await assert.rejects(core.initializeAdminAtRoot(passwordB,repeated));
  assert.equal(await digest(path.join(repeated,'service.env')),beforeEnv);assert.equal(await digest(path.join(repeated,'data/admin-auth.json')),beforeAuth);
  assert.equal(await authMatches(repeated,passwordA),true);assert.equal(await authMatches(repeated,passwordB),false);pass('repeat-does-not-reset-password-or-master');
  stage='native-lock';const lockFile=path.join(rootFor('lock-check'),'probe.lock');
  const held=await locks.acquireProcessLock(lockFile);
  try{await assert.rejects(locks.acquireProcessLock(lockFile),error=>error.code==='CONFIG_BUSY');}finally{await held.release();}
  const again=await locks.acquireProcessLock(lockFile);await again.release();pass('real-windows-share-none-lock-contention-and-release');
  stage='concurrent';
  const child=mode=>new Promise((resolve,reject)=>{
   const processChild=spawn(process.execPath,['--import',new URL('./register.mjs',import.meta.url).href,fileURLToPath(import.meta.url),mode],{env:windowsHostEnvironment(),windowsHide:true,stdio:['ignore','pipe','pipe']});
   let output='',errors='';const timer=setTimeout(()=>{processChild.kill();reject(new Error('Concurrent synthetic test timeout'));},60000);
   processChild.stdout.on('data',bytes=>{output+=bytes;if(output.length>4096)processChild.kill()});processChild.stderr.on('data',bytes=>{errors+=bytes;if(errors.length>4096)processChild.kill()});
   processChild.once('error',error=>{clearTimeout(timer);reject(error)});processChild.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Object.assign(new Error('Synthetic child failed'),{code:'CHILD_'+code}));try{resolve(JSON.parse(output))}catch(error){reject(error)}});
  });
  const outcomes=await Promise.all([child('--concurrent-a'),child('--concurrent-b')]);
  assert.equal(outcomes.filter(value=>value.ok).length,1);
  const concurrent=rootFor('concurrent');assert.equal(await core.verifyAdminAtRoot(concurrent),'initialized');
  assert.equal(Number(await authMatches(concurrent,passwordA))+Number(await authMatches(concurrent,passwordB)),1);
  const envDigest=await digest(path.join(concurrent,'service.env')),authDigest=await digest(path.join(concurrent,'data/admin-auth.json'));
  await assert.rejects(core.initializeAdminAtRoot(passwordA,concurrent));await assert.rejects(core.initializeAdminAtRoot(passwordB,concurrent));
  assert.equal(await digest(path.join(concurrent,'service.env')),envDigest);assert.equal(await digest(path.join(concurrent,'data/admin-auth.json')),authDigest);pass('two-process-concurrency-preserves-single-password-and-master');
  console.log(JSON.stringify({ok:true,stage:'complete',checks,syntheticOnly:true,coreModulesUnmodified:true,realWindowsAcl:true,realWindowsFileLock:true,dedicatedServiceSidTested:false,passwordValuesPrinted:false,coreHashes:map.coreHashes.map(item=>({name:path.basename(item.path),sha256:item.sha256}))}));
 }catch(error){console.log(JSON.stringify({ok:false,stage,checks,code:typeof error.code==='string'?error.code:'ASSERTION_OR_RUNTIME_FAILURE',errorType:error.name,syntheticOnly:true,passwordValuesPrinted:false}));process.exitCode=1;}
}
