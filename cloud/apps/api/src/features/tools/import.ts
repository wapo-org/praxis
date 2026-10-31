import {gunzipSync} from 'node:zlib';
import {Unzip,UnzipInflate} from 'fflate';
import type {FeatureContext} from '../../contracts.js';
import {ApiError} from '../../service.js';
import {allowedSkillFile,parseSkillDocument,saveSkill,skillPath} from './skills.js';
import {toolsState} from './state.js';
import type {ToolsStorage} from './ports.js';
const MAX=5_000_000,COUNT=100;
const fail=():never=>{throw new ApiError(400,'invalid_archive','Unsafe, malformed or oversized skill archive');};
type Entry={path:string;bytes:Uint8Array;executable:boolean;directory:boolean};
export function extractSkill(archive:Uint8Array,name:string){
 if(archive.length>25_000_000)fail();
 const entries:Entry[]=[];let total=0,count=0;
 const seen=new Set<string>();
 function check(path:string,size:number,directory=false){
  skillPath(directory?path.replace(/\/$/,''):path);
  const key=path.replace(/\/$/,'').normalize('NFC').toLowerCase();if(seen.has(key))fail();seen.add(key);
  if(++count>COUNT||!Number.isSafeInteger(size)||size<0||(total+=size)>MAX)fail();
 }
 try{
 if(/\.(zip|skill)$/i.test(name)){
  // Inspect central directory Unix modes before extraction: no links/devices, even in dropped files.
  const b=Buffer.from(archive);let end=-1;
  for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50&&i+22+b.readUInt16LE(i+20)===b.length){end=i;break;}
  if(end<0||b.readUInt16LE(end+4)!==0||b.readUInt16LE(end+6)!==0)fail();
  const n=b.readUInt16LE(end+10),offset=b.readUInt32LE(end+16),length=b.readUInt32LE(end+12);if(n>COUNT||offset+length!==end)fail();
  const modes=new Map<string,number>(),sizes=new Map<string,number>();let at=offset;
  for(let i=0;i<n;i++){
   if(b.readUInt32LE(at)!==0x02014b50)fail();
   const size=b.readUInt32LE(at+24),compressed=b.readUInt32LE(at+20),mode=b.readUInt32LE(at+38)>>>16;
   const path=new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(at+46,at+46+b.readUInt16LE(at+28)));
   const type=mode&0xf000;if(type&&type!==0x8000&&type!==0x4000)fail();
   if(b.readUInt16LE(at+8)&1||size>MAX||size>262144&&size/Math.max(1,compressed)>100)fail();
   check(path,size,path.endsWith('/'));modes.set(path,mode);sizes.set(path,size);
   at+=46+b.readUInt16LE(at+28)+b.readUInt16LE(at+30)+b.readUInt16LE(at+32);
  }
  if(at!==end)fail();let actual=0,found=0;const localSeen=new Set<string>();
  const unzip=new Unzip(file=>{
   if(!modes.has(file.name)||localSeen.has(file.name)||++found>n||file.originalSize!==undefined&&file.originalSize!==sizes.get(file.name))fail();localSeen.add(file.name);let size=0;const chunks:Uint8Array[]=[];
   file.ondata=(error,data,final)=>{if(error)fail();size+=data.length;actual+=data.length;if(size>MAX||actual>MAX)fail();chunks.push(data);if(final){if(size!==sizes.get(file.name))fail();entries.push({path:file.name,bytes:Buffer.concat(chunks),executable:!!(modes.get(file.name)!&0o111),directory:file.name.endsWith('/')});}};
   file.start();
  });unzip.register(UnzipInflate);
  for(let i=0;i<archive.length;i+=1024)unzip.push(archive.subarray(i,i+1024),i+1024>=archive.length);
  if(found!==n||entries.length!==n)fail();
 }else if(/\.tar(?:\.gz)?$/i.test(name)){
  const data=Buffer.from(/\.gz$/i.test(name)?gunzipSync(archive,{maxOutputLength:MAX+COUNT*1024}):archive);
  let at=0;
  while(at+512<=data.length){
   const h=data.subarray(at,at+512);if(h.every(v=>v===0))break;
   const str=(a:number,b:number)=>new TextDecoder('utf-8',{fatal:true}).decode(h.subarray(a,b)).replace(/\0.*$/s,'').trimEnd();
   const oct=(a:number,b:number)=>{const s=str(a,b).trim();if(!/^[0-7]*$/.test(s))fail();return parseInt(s||'0',8);};
   const sum=[...h].reduce((s,v,i)=>s+(i>=148&&i<156?32:v),0);if(oct(148,156)!==sum)fail();
   const path=(str(345,500)?str(345,500)+'/':'')+str(0,100),size=oct(124,136),type=h[156];
   if(type!==0&&type!==48&&type!==53)fail();check(path,size,type===53);
   if(at+512+size>data.length)fail();entries.push({path,bytes:data.subarray(at+512,at+512+size),directory:type===53,executable:!!(oct(100,108)&0o111)});at+=512+Math.ceil(size/512)*512;
  }
 }else fail();
 const files=entries.filter(e=>!e.directory);
 // Reject file/directory collisions, including implicit parents.
 for(const entry of entries){const parts=entry.path.replace(/\/$/,'').split('/');for(let i=1;i<parts.length;i++)if(files.some(f=>f.path.normalize('NFC').toLowerCase()===parts.slice(0,i).join('/').normalize('NFC').toLowerCase()))fail();}
 let prefix='';if(!files.some(e=>e.path==='SKILL.md')){const tops=new Set(files.map(e=>e.path.split('/')[0]));if(tops.size!==1)fail();prefix=[...tops][0]+'/';if(!files.some(e=>e.path===prefix+'SKILL.md'))fail();}
 const bundle:Record<string,string>=Object.create(null),dropped:string[]=[];let document='';
 for(const entry of files){const path=entry.path.slice(prefix.length);let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(entry.bytes);}catch{if(path==='SKILL.md')fail();dropped.push(path);continue;}
  if(path==='SKILL.md'){if(entry.executable||text.includes('\0'))fail();document=text;continue;}
  if(!allowedSkillFile(path)||entry.executable||text.startsWith('#!')||text.includes('\0')){dropped.push(path);continue;}
  if(entry.bytes.length>500000)fail();bundle[path]=text;
 }
 const parsed=parseSkillDocument(document);return {...parsed,document,files:bundle,dropped};
 }catch(error){if(error instanceof ApiError)throw error;return fail();}
}
export async function importSkill(ctx:FeatureContext,storage:ToolsStorage,bytes:Uint8Array,name:string){
 const input=extractSkill(bytes,name);const skill=await saveSkill(ctx,{...input,enabled:true});
 await toolsState(ctx,storage).put(ctx.userId,'skill',skill.id,{files:input.files});return {skill,dropped:input.dropped};
}
