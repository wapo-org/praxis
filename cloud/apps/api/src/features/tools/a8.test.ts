import {describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {zipSync,strToU8} from 'fflate';
import {Hono} from 'hono';
import {createLocalAdapters} from '../../local-memory.js';
import type {FeatureContext} from '../../contracts.js';
import {extractSkill} from './import.js';
import {createToolsRoutes,createLocalToolsStorage} from './index.js';
import {installSkill,skillUpdates,updateSkill} from './registries.js';
const doc='---\nname: demo\ndescription: Demo skill\n---\nFollow these steps.';
const digest=(document:string)=>`sha256:${createHash('sha256').update(document).digest('hex')}`;
function ctx():FeatureContext{return {...createLocalAdapters(),local:false,userId:'alice',egress:vi.fn(),fetch:vi.fn()};}
function tar(files:{path:string;text:string;type?:string}[]){const parts:Buffer[]=[];for(const f of files){const bytes=Buffer.from(f.text),h=Buffer.alloc(512);h.write(f.path);h.write('0000644\0',100);h.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write(f.type??'0',156);h.write('ustar',257);h.write([...h].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);parts.push(h,bytes,Buffer.alloc((512-bytes.length%512)%512));}return Buffer.concat([...parts,Buffer.alloc(1024)]);}
describe('WP-A8 skills',()=>{
 it('imports zip and tar/gzip, strips one wrapper and drops scripts/binaries',()=>{
  const files={'demo/SKILL.md':strToU8(doc),'demo/reference/a.txt':strToU8('text'),'demo/scripts/a.sh':strToU8('echo no'),'demo/binary.txt':new Uint8Array([0])};
  const result=extractSkill(zipSync(files),'demo.zip');expect(result.name).toBe('demo');expect(result.files).toEqual({'reference/a.txt':'text'});expect(result.dropped).toHaveLength(2);
  for(const gzip of [false,true]){const b=tar([{path:'SKILL.md',text:doc}]);expect(extractSkill(gzip?gzipSync(b):b,gzip?'a.tar.gz':'a.tar').name).toBe('demo');}
 });
 it.each(['../SKILL.md','/SKILL.md','a/../SKILL.md','a\\SKILL.md','a/%2e%2e/SKILL.md'])('rejects traversal %s',path=>expect(()=>extractSkill(zipSync({[path]:strToU8(doc)}),'a.zip')).toThrow());
 it('rejects symlinks, duplicate/colliding paths and bombs before saving',()=>{
  expect(()=>extractSkill(tar([{path:'SKILL.md',text:doc},{path:'link',text:'',type:'2'}]),'a.tar')).toThrow();
  expect(()=>extractSkill(tar([{path:'SKILL.md',text:doc},{path:'SKILL.md',text:doc}]),'a.tar')).toThrow();
  expect(()=>extractSkill(zipSync({'SKILL.md':strToU8(doc),'x':strToU8('a'),'x/a.txt':strToU8('b')}),'a.zip')).toThrow();
  expect(()=>extractSkill(zipSync({'SKILL.md':strToU8(doc),'bomb.txt':new Uint8Array(1_000_000).fill(65)}),'a.zip')).toThrow();
  expect(()=>extractSkill(zipSync({'SKILL.md':strToU8(doc),...Object.fromEntries(Array.from({length:100},(_,i)=>[`${i}.txt`,strToU8('x')]))}),'a.zip')).toThrow();
  expect(()=>extractSkill(tar([{path:'SKILL.md',text:doc},{path:'large.txt',text:'a'.repeat(5_000_000)}]),'a.tar')).toThrow();
  expect(()=>extractSkill(zipSync({'SKILL.md':strToU8('invalid')}),'a.zip')).toThrow();
  expect(()=>extractSkill(new Uint8Array(25_000_001),'a.zip')).toThrow();
 });
 it('checks registry updates from cached listings, verifies digest and preserves installed identity',async()=>{
  const c=ctx();await c.store.put('alice','registry','r',{url:'https://example.com/skills',enabled:true});let document=doc;
  c.egress=vi.fn(async()=>Response.json([{id:'entry',name:'demo',document,digest:digest(document)}]));
  const installed=await installSkill(c,'r','entry');expect(installed.registryEntryId).toBe('entry');expect(await skillUpdates(c)).toEqual([]);document+='\nUpdated';expect(await skillUpdates(c)).toEqual([]);
  await c.kv.del(JSON.stringify(['tools','registry','alice','r','https://example.com/skills']));
  expect(await skillUpdates(c)).toMatchObject([{skillId:installed.id,updateAvailable:true}]);
  expect((await updateSkill(c,installed.id)).id).toBe(installed.id);expect(await skillUpdates(c)).toEqual([]);
  await c.kv.del(JSON.stringify(['tools','registry','alice','r','https://example.com/skills']));c.egress=vi.fn(async()=>Response.json([{id:'entry',name:'demo',document,digest:digest('wrong')} ]));await expect(updateSkill(c,installed.id)).rejects.toThrow('digest mismatch');
  expect((await c.store.get('alice','skill',installed.id))?.value.document).toBe(document);
  await c.store.put('alice','registry','r',{url:'https://example.com/skills',enabled:false});expect(await skillUpdates(c)).toEqual([]);
 });
 it('imports owned attachment through API and persists bundle with the storage adapter',async()=>{
  const c=ctx(),s=createLocalToolsStorage('http://localhost');const bytes=zipSync({'SKILL.md':strToU8(doc),'notes.txt':strToU8('notes')});
  const input={name:'demo.zip',size:bytes.length,mediaType:'application/zip'},ticket=await s.createUpload('alice',input);const storageId=await s.acceptUpload!('alice',ticket.uploadUrl.split('/').at(-1)!,bytes,input.mediaType);
  await c.store.put('alice','attachment','a',{...input,storageId});const app=new Hono().route('/v1',createToolsRoutes(async req=>({...c,userId:req.headers.get('x-user')??'alice'}),{storage:s}));
  const request=(user:string)=>app.request('/v1/skills/import',{method:'POST',headers:{'Content-Type':'application/json','x-user':user},body:JSON.stringify({type:'skill.import',attachmentId:'a'})});
  expect((await request('bob')).status).toBe(404);const r=await request('alice');expect(r.status).toBe(201);const result=await r.json();expect(await s.state!.get('alice','skill',result.skill.id)).toMatchObject({files:{'notes.txt':'notes'}});
  expect((await app.request('/v1/skills/updates')).status).toBe(200);
 });
});
