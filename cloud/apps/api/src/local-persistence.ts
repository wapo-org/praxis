import {randomBytes} from 'node:crypto';
import {chmodSync,closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createLocalAdapters,type LocalMemorySnapshot} from './local-memory.js';

/** Imported only by dev:local. Never wire this into production adapters. */
export function localRuntime(env:NodeJS.ProcessEnv=process.env,debounceMs=200){
 const configured=env.PRAXIS_LOCAL_DATA_DIR;
 if(configured!==undefined&&(env.NODE_ENV==='production'||env.VERCEL!==undefined))throw new Error('PRAXIS_LOCAL_DATA_DIR is forbidden in production and on Vercel');
 const explicitKey=env.PRAXIS_ENCRYPTION_KEYS??env.PRAXIS_ENCRYPTION_KEY;
 if(configured===undefined)return {adapters:createLocalAdapters(),encryptionKey:explicitKey??randomBytes(32).toString('base64'),flush:()=>{},close:()=>{},directory:undefined};
 if(!configured.trim())throw new Error('PRAXIS_LOCAL_DATA_DIR must be a non-empty directory');
 const directory=resolve(configured.startsWith('~/')?join(homedir(),configured.slice(2)):configured);
 mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
 const file=join(directory,'store.json'),keyFile=join(directory,'dev-encryption.key');
 // Exclusive creation preserves the first generated key, including across restarts.
 let encryptionKey=explicitKey;
 if(!encryptionKey){
  try{writeFileSync(keyFile,randomBytes(32).toString('base64'),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw new Error('Could not create local encryption key', { cause: error });}
  chmodSync(keyFile,0o600);encryptionKey=readFileSync(keyFile,'utf8').trim();
  if(!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey))throw new Error('Invalid local encryption key file');
 }
 let snapshot:LocalMemorySnapshot|undefined;
 if(existsSync(file)){
  chmodSync(file,0o600);
  try{snapshot=JSON.parse(readFileSync(file,'utf8')) as LocalMemorySnapshot;
   if(snapshot.version!==1||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!['closed','ownerKeys','records','revisions','cache','streams','dedup'].every(k=>Array.isArray(snapshot![k as keyof LocalMemorySnapshot])))throw new Error();
  }catch{throw new Error('Could not load local data snapshot; refusing to overwrite it');}
 }
 let timer:ReturnType<typeof setTimeout>|undefined,dirty=false;
 const adapters=createLocalAdapters({snapshot,changed:()=>{dirty=true;if(!timer){timer=setTimeout(()=>{timer=undefined;flush();},debounceMs);timer.unref();}}});
 function flush(){
  if(timer){clearTimeout(timer);timer=undefined;}
  if(!dirty)return;
  const temporary=join(directory,`.store-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  try{
   const fd=openSync(temporary,'wx',0o600);
   try{writeFileSync(fd,JSON.stringify(adapters.snapshot()));fsyncSync(fd);}finally{closeSync(fd);}
   renameSync(temporary,file);dirty=false;
  }catch{throw new Error('Could not write local data snapshot');}
  finally{if(existsSync(temporary))unlinkSync(temporary);}
 }
 return {adapters,encryptionKey,directory,flush,close:flush};
}
