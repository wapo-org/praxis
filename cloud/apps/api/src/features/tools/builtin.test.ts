import {describe,it,expect,vi} from 'vitest';
import {decideTool} from '@praxis/agent';
import {createLocalAdapters} from '../../local-memory.js';
import type {FeatureContext,FeatureTool} from '../../contracts.js';
import {skillTools,listSkillsForCatalog,javascriptTool} from './builtin.js';
import {createLocalToolsStorage} from './local-storage.js';
import {saveSkill,skillPath} from './skills.js';
const input={name:'weekly-report',description:'Write reports',instructions:'Read reference/check.txt.',files:[{path:'reference/check.txt',content:'hello world'}]};
const execution={chatId:'chat',runId:'run',mode:'auto' as const};
function fixture(){const ctx:FeatureContext={...createLocalAdapters(),userId:'alice',local:true,fetch:vi.fn(),egress:vi.fn()},storage=createLocalToolsStorage('http://localhost');const tools=skillTools(ctx,storage);const call=(name:string,args:Parameters<FeatureTool['execute']>[0])=>tools.find(t=>t.name===name)!.execute(args,execution) as Promise<{content:{text:string}[];isError:boolean}>;return{ctx,storage,tools,call};}
describe('skill builtins',()=>{
 it('saves, loads immediately, freezes catalog, reads paged bundle files, replaces preserving files, and deletes',async()=>{
  const f=fixture(),frozen=await listSkillsForCatalog(f.ctx);const out=await f.call('save_skill',input);
  expect(out.content[0]!.text).toBe('Saved the new skill “weekly-report”. It\'s available now: call load_skill with name "weekly-report" to use it in this conversation. New conversations will list it with the other skills.\nFiles: reference/check.txt.');
  expect(frozen).toEqual([]);expect(await listSkillsForCatalog(f.ctx)).toEqual([{name:input.name,description:input.description}]);
  expect((await f.call('load_skill',{name:input.name})).content[0]!.text).toBe(input.instructions);
  expect((await f.call('read_skill_file',{skill:input.name,path:'reference/check.txt',limit:5})).content[0]!.text).toBe('hello\n\n[Continues: pass offset 5]');
  expect((await f.call('read_skill_file',{skill:input.name,path:'reference/check.txt',offset:6})).content[0]!.text).toBe('world');
  expect((await f.call('save_skill',{...input,files:[],replace:true})).content[0]!.text).toContain('Updated the skill');
  expect((await f.call('read_skill_file',{skill:input.name,path:'reference/check.txt'})).isError).toBe(false);
  expect((await f.call('save_skill',{...input,files:[],replace:true,remove_files:['reference/check.txt']})).isError).toBe(false);
  expect((await f.call('read_skill_file',{skill:input.name,path:'reference/check.txt'})).isError).toBe(true);
  expect((await f.call('delete_skill',{name:input.name})).content[0]!.text).toBe('Deleted the skill “weekly-report”. It can\'t be loaded any more.');
  expect((await f.call('load_skill',{name:input.name})).isError).toBe(true);
 });
 it('protects existing and user-installed skills, and isolates owners',async()=>{
  const f=fixture();await f.call('save_skill',input);expect((await f.call('save_skill',input)).content[0]!.text).toContain('already exists');
  const ctx={...f.ctx,userId:'bob'};expect(await listSkillsForCatalog(ctx)).toEqual([]);
  await saveSkill(ctx,{name:input.name,description:input.description,document:'---\nname: weekly-report\ndescription: Write reports\n---\nhello',enabled:true});
  for(const [name,args]of [['save_skill',{...input,replace:true}],['delete_skill',{name:input.name}]] as const){const tool=skillTools(ctx,f.storage).find(t=>t.name===name)!;expect(await tool.execute(args,execution)).toMatchObject({isError:true});}
 });
 it.each([{}, {name:'x'}, {name:'x',description:'d'}, {...input,files:{}}, {...input,files:[{}]}, {...input,files:[...input.files,...input.files]}, {...input,files:[{path:'SKILL.md',content:'x'}]}, {...input,files:[{path:'../escape',content:'x'}]}, {...input,name:'Bad_Name'}, {...input,description:'<xml>'}, {...input,instructions:''}, {...input,files:[{path:'large.txt',content:'x'.repeat(500001)}]}])('validates authoring arguments',async args=>{expect((await fixture().call('save_skill',JSON.parse(JSON.stringify(args)))).isError).toBe(true);});
 it('reports dropped scripts and binary files',async()=>{const f=fixture();const out=await f.call('save_skill',{...input,files:[{path:'scripts/a.txt',content:'x'},{path:'a.js',content:'x'},{path:'a.bin',content:'\0'}]});expect(out.isError).toBe(false);expect(out.content[0]!.text).toContain('scripts/a.txt (in a scripts folder), a.js (script or executable), a.bin (binary file)');});
 it.each(['../x','a/../x','/x','C:/x','a\\x','a//x','a/./x','%2e%2e/x','link/../../secret','~/.x','a\0x'])('rejects unsafe file path %s',path=>{expect(()=>skillPath(path)).toThrow();});
 it('caps reads of stored files even if a writer bypassed authoring validation',async()=>{const f=fixture();await f.call('save_skill',input);const row=(await f.ctx.store.list('alice','skill'))[0]!;await f.storage.state!.put('alice','skill',row.id,{files:{'big.txt':'x'.repeat(500001)}});expect((await f.call('read_skill_file',{skill:input.name,path:'big.txt'})).content[0]!.text).toBe('Skill file exceeds 500 KB.');});
 it('classifies save/delete as skill writes with distinct replacement approval',()=>{const f=fixture(),policy={trustedSources:[],alwaysAllow:[]};for(const t of f.tools.filter(t=>['save_skill','delete_skill'].includes(t.name))){const tool={type:'tool.spec' as const,...t};for(const mode of ['ask','plan'] as const)expect(decideTool(tool,mode,policy,'k').decision).toBe('refuse');expect(decideTool(tool,'build',policy,'k').decision).toBe('ask');}const save=f.tools.find(t=>t.name==='save_skill')!;expect(save.classify!({replace:true})).toEqual({traits:['destructive'],policyKey:'replace'});expect(save.classify!({})).toEqual({traits:[]});});
 it('persists JS kv through tools storage scoped by chat',async()=>{const f=fixture(),t=javascriptTool(f.ctx,{attachmentIds:[],storage:f.storage,hostToolNames:[]});await t.execute({code:'kv.set("x", 42)'},execution);const out=await t.execute({code:'return kv.get("x")'},execution);expect(JSON.stringify(out)).toContain('42');expect(await f.storage.state!.get('alice','javascriptKV','chat')).toEqual({data:{x:42}});expect(await f.storage.state!.get('alice','javascriptKV','other')).toBeNull();});
});
