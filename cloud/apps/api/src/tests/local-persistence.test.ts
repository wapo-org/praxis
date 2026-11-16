import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,readdirSync,rmSync,statSync,existsSync,chmodSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {localRuntime} from '../local-persistence.js';
import {createPraxisApp} from '../server.js';
import {featureContext} from '../features.js';
import {executionSecrets} from '../saved-secrets.js';
import {readProductionEnv} from '../production.js';
import {fakeOpenRouter} from './harness.js';
import {unseal} from '../secrets.js';
const dirs:string[]=[];
const directory=()=>{const dir=mkdtempSync(join(tmpdir(),'praxis-k1c-'));dirs.push(dir);return dir;};
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('restarts chat, sealed provider, connector, saved secret, revisions, KV and event dedup',async()=>{
 const dir=directory(),env={PRAXIS_LOCAL_DATA_DIR:dir};let runtime=localRuntime(env);
 let app=createPraxisApp({adapters:runtime.adapters,encryptionKey:runtime.encryptionKey,local:true,fetcher:fakeOpenRouter([]).fetcher});
 const request=async(path:string,body?:unknown)=>{const response=await app.app.request(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer dev-local','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});expect(response.ok).toBe(true);return response.json();};
 const chat=await request('/v1/chats',{type:'chat.input',title:'Survives restart'});
 await request('/v1/model-key',{method:'paste',apiKey:'sk-or-SYNTHETIC-PERSIST-PROVIDER'});
 const secret=await request('/v1/saved-values',{name:'token',kind:'secret',value:'SYNTHETIC-PERSIST-SECRET'});
 await runtime.adapters.store.put('local-user','connector','fixture',{name:'Fake connector',url:'https://example.test/mcp'});
 await runtime.adapters.kv.set('cached',{ok:true},3600,'local-user');await runtime.adapters.events.append('local-user','fixture',{text:'event'},'once');
 const before=runtime.adapters.snapshot(),key=runtime.encryptionKey;runtime.close();
 const disk=readFileSync(join(dir,'store.json'),'utf8');expect(disk).not.toContain('sk-or-SYNTHETIC-PERSIST-PROVIDER');expect(disk).not.toContain('SYNTHETIC-PERSIST-SECRET');
 runtime=localRuntime(env);expect(runtime.encryptionKey===key).toBe(true);expect(runtime.adapters.snapshot()).toEqual(before);
 app=createPraxisApp({adapters:runtime.adapters,encryptionKey:runtime.encryptionKey,local:true,fetcher:fakeOpenRouter([]).fetcher});await app.service.seed('local-user');
 expect((await runtime.adapters.store.get('local-user','chat',chat.id))?.value.title).toBe('Survives restart');
 expect(await app.service.models!.keys.get('local-user')).toBeDefined();
 const secrets=await executionSecrets(featureContext(app.service,'local-user',{encryptionKey:runtime.encryptionKey}),'new-chat');expect(secrets.resolve('{{secret:'+secret.id+'}}')).toBe('SYNTHETIC-PERSIST-SECRET');
 expect(await runtime.adapters.kv.get('cached')).toEqual({ok:true});expect((await runtime.adapters.events.append('local-user','fixture',{text:'ignored'},'once')).id).toBe(1);expect(await runtime.adapters.events.read('local-user','fixture',0)).toHaveLength(1);runtime.close();
});
it.each([{NODE_ENV:'production'},{VERCEL:'1'},{VERCEL:''}])('refuses persistence before filesystem access: %j',flags=>{const dir=join(directory(),'absent');expect(()=>localRuntime({...flags,PRAXIS_LOCAL_DATA_DIR:dir})).toThrow('forbidden');expect(existsSync(dir)).toBe(false);});
it('restricts modes and debounces atomic snapshots without temp files',async()=>{
 const dir=directory();chmodSync(dir,0o755);const runtime=localRuntime({PRAXIS_LOCAL_DATA_DIR:dir},20);
 try{await runtime.adapters.store.put('u','chat','c',{title:'first'});await runtime.adapters.store.put('u','chat','c',{title:'last'});expect(existsSync(join(dir,'store.json'))).toBe(false);await new Promise(r=>setTimeout(r,60));expect(JSON.parse(readFileSync(join(dir,'store.json'),'utf8')).revision).toBe(2);expect(statSync(dir).mode&0o777).toBe(0o700);expect(readdirSync(dir).sort()).toEqual(['dev-encryption.key','store.json']);for(const file of readdirSync(dir))expect(statSync(join(dir,file)).mode&0o777).toBe(0o600);}finally{runtime.close();}
});
it('uses an explicit key without generating a file, defaults to ephemeral storage',async()=>{
 const dir=directory(),key=randomBytes(32).toString('base64'),persisted=localRuntime({PRAXIS_LOCAL_DATA_DIR:dir,PRAXIS_ENCRYPTION_KEY:key});expect(persisted.encryptionKey===key).toBe(true);expect(existsSync(join(dir,'dev-encryption.key'))).toBe(false);persisted.close();const first=localRuntime({}),second=localRuntime({});await first.adapters.store.put('u','chat','c',{});expect(await second.adapters.store.get('u','chat','c')).toBeNull();expect(first.directory).toBeUndefined();
});
it('refuses to overwrite corrupt data',()=>{const dir=directory();writeFileSync(join(dir,'store.json'),'{bad');expect(()=>localRuntime({PRAXIS_LOCAL_DATA_DIR:dir})).toThrow('refusing to overwrite');expect(readFileSync(join(dir,'store.json'),'utf8')).toBe('{bad');});
it('persists owner purge and closed-account state',async()=>{
 const dir=directory();let runtime=localRuntime({PRAXIS_LOCAL_DATA_DIR:dir});await runtime.adapters.store.put('u','chat','c',{});await runtime.adapters.kv.set('private','value',3600,'u');await runtime.adapters.events.append('u','c',{});await runtime.adapters.purgeOwner!('u');runtime.close();runtime=localRuntime({PRAXIS_LOCAL_DATA_DIR:dir});expect(await runtime.adapters.store.changes('u',0,100)).toMatchObject({records:[]});expect(await runtime.adapters.kv.get('private')).toBeNull();expect(await runtime.adapters.events.read('u','c',0)).toEqual([]);await expect(runtime.adapters.store.put('u','chat','new',{})).rejects.toThrow('Account unavailable');runtime.close();
});
it.each(['SIGINT','SIGTERM'] as const)('flushes the real dev entrypoint on %s and reloads it',async signal=>{
 const {spawn}=await import('node:child_process');const dir=directory();
 const {createServer}=await import('node:net');const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as {port:number}).port;await new Promise<void>((r,j)=>probe.close(e=>e?j(e):r()));
 const start=async()=>{
  const child=spawn(process.execPath,['--import','tsx','apps/api/src/local.ts'],{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',PORT:String(port),PRAXIS_EMBEDDER:'none',PRAXIS_LOCAL_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));let output='';
  try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Local API startup timed out')),10000);child.once('exit',()=>{clearTimeout(timer);reject(new Error('Local API exited before startup'));});child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('Praxis local API:')){clearTimeout(timer);resolve();}});});}
  catch(error){child.kill('SIGTERM');await exited;throw error;}
  return {child,exited};
 };
 let running=await start();
 try{
  const response=await fetch(`http://127.0.0.1:${port}/v1/chats`,{method:'POST',headers:{Authorization:'Bearer dev-local','content-type':'application/json'},body:JSON.stringify({type:'chat.input',title:'Signal flush'})});expect(response.ok).toBe(true);const chat=await response.json();
  running.child.kill(signal);await running.exited;running=await start();
  const response2=await fetch(`http://127.0.0.1:${port}/v1/chats/`+chat.id,{headers:{Authorization:'Bearer dev-local'}});expect(response2.ok).toBe(true);expect((await response2.json()).title).toBe('Signal flush');
 }finally{if(running.child.exitCode===null&&running.child.signalCode===null){running.child.kill('SIGTERM');await running.exited;}}
},30000);

it('production composition rejects local persistence independently of NODE_ENV',()=>{expect(()=>readProductionEnv({PRAXIS_LOCAL_DATA_DIR:'/not-read'})).toThrow('only supported by dev:local');});
