import type {JsonValue} from '@praxis/protocol';
import type {FeatureContext, FeatureTool} from '../../contracts.js';
import type {ToolsStorage} from './ports.js';
import {toolsState} from './state.js';
import {parseSkillDocument, saveSkill, skillDocument, skillPath} from './skills.js';

const text = (value:string, isError=false) => ({content:[{type:'text',text:value}],isError});
const object = (v:JsonValue|undefined): Record<string,JsonValue> => v && typeof v==='object' && !Array.isArray(v) ? v : {};
export const MAX_SKILL_FILE_BYTES = 500_000;
export function skillAuthoringTools(ctx:FeatureContext, storage?:ToolsStorage):FeatureTool[] {
 const state=toolsState(ctx,storage);
 const existing=async(name:string)=>(await ctx.store.list(ctx.userId,'skill')).find(r=>!r.deleted&&r.value.name===name);
 function checkOwned(row:NonNullable<Awaited<ReturnType<typeof existing>>>) {
  if(row.value.agentCreated!==true)throw new Error(`“${row.value.name}” was installed by the user, so it can't be changed or deleted here. Save your version under a different name.`);
 }
 return [{
  name:'save_skill',
  description:"Save a reusable skill on this device: instructions for a kind of task that you (in this or later conversations) can load with load_skill. Use it when the user asks you to remember how to do something, or after working out a procedure worth reusing. Skills are markdown only: scripts can't run on this device, so script files are not saved. Only skills you created can be replaced (replace: true) or deleted.",
  inputSchema:{type:'object',properties:{name:{type:'string',description:'Lowercase letters, numbers and hyphens, max 64 characters, e.g. "weekly-report"'},description:{type:'string',description:'One or two sentences: what the skill does and when to use it (max 1024 characters, no XML tags). This is what future conversations see in the skill list.'},instructions:{type:'string',description:'The SKILL.md body in markdown: steps, rules, examples. Keep it under ~500 lines; put long reference material in files.'},files:{type:'array',description:'Optional extra text files the instructions refer to, e.g. reference/checklist.md',items:{type:'object',properties:{path:{type:'string',description:'Relative path inside the skill folder'},content:{type:'string'}},required:['path','content']}},remove_files:{type:'array',items:{type:'string'},description:'When replacing: existing files to delete'},replace:{type:'boolean',description:"Overwrite an existing skill you created earlier (default false). Files you don't pass or remove are kept."}},required:['name','description','instructions']},
  source:{type:'skill'},traits:[],
  classify(args){return object(args).replace===true?{traits:['destructive'],policyKey:'replace'}:{traits:[]};},
  async execute(args,execution){
   const a=object(args),name=typeof a.name==='string'?a.name.trim():'';
   if(!name)return text('Missing name.',true);
   if(typeof a.description!=='string')return text('Missing description.',true);
   if(typeof a.instructions!=='string')return text('Missing instructions.',true);
   const additions:Record<string,string>=Object.create(null);
   if(Array.isArray(a.files))for(const item of a.files){const f=object(item);if(typeof f.path!=='string'||typeof f.content!=='string')return text('Each entry in files needs a path and a content string.',true);if(Object.hasOwn(additions,f.path))return text(`“${f.path}” appears twice in files.`,true);additions[f.path]=f.content;}
   else if(a.files!==undefined&&a.files!==null)return text('files must be an array of {path, content} objects.',true);
   try{
    const document=skillDocument(name,a.description,a.instructions);parseSkillDocument(document);
    const row=await existing(name);
    if(row){if(a.replace!==true)throw new Error(`A skill named “${name}” already exists. Pick another name, or replace it (only skills the agent created can be replaced).`);checkOwned(row);}
    const bundle=row?await state.get(ctx.userId,'skill',row.id):null;
    const files:Record<string,JsonValue>={...object(bundle?.files)};
    for(const raw of Array.isArray(a.remove_files)?a.remove_files:[]){if(typeof raw!=='string')continue;const path=skillPath(raw);if(!Object.hasOwn(files,path))throw new Error(`“${raw}” isn't a file in ${name}, so it can't be removed.`);delete files[path];}
    const dropped:string[]=[];
    for(const [raw,content]of Object.entries(additions)){
     const path=skillPath(raw);if(path.toLowerCase()==='skill.md')throw new Error('Put the SKILL.md text in instructions, not in files.');
     const reason=path.split('/').includes('scripts')?'in a scripts folder':(/\.(py|sh|js|ts|mjs|cjs|exe|dll|so|dylib|bat|cmd|ps1|rb|pl|php|wasm)$/i.test(path)||content.startsWith('#!'))?'script or executable':content.includes('\0')?'binary file':null;
     if(reason){dropped.push(`${path} (${reason})`);continue;}
     if(Buffer.byteLength(content)>MAX_SKILL_FILE_BYTES)throw new Error(`“${path}” exceeds 500 KB.`);
     files[path]=content;
    }
    if(Object.keys(files).length>100||Buffer.byteLength(JSON.stringify(files))>5_000_000)throw new Error('Skill bundle exceeds 100 files or 5 MB.');
    const skill=await saveSkill(ctx,{name,description:a.description,document,enabled:true},row?.id);
    await state.put(ctx.userId,'skill',skill.id,{files,conversationId:bundle?.conversationId??execution.chatId});
    await ctx.store.put(ctx.userId,'skill',skill.id,{...skill,agentCreated:true});
    let out=`${row?'Updated the skill':'Saved the new skill'} “${name}”. It's available now: call load_skill with name "${name}" to use it in this conversation. New conversations will list it with the other skills.`;
    const paths=Object.keys(files).sort();if(paths.length)out+='\nFiles: '+paths.join(', ')+'.';
    if(dropped.length)out+="\nNot saved (scripts and binaries can't be part of a skill on this device): "+dropped.join(', ')+'. Describe those steps in the instructions instead.';
    return text(out);
   }catch(e){return text(`Couldn't save the skill: ${e instanceof Error?e.message:String(e)}`,true);}
  },
 },{
  name:'delete_skill',description:"Delete a skill you created earlier with save_skill (skills the user installed can't be deleted).",
  inputSchema:{type:'object',properties:{name:{type:'string',description:'Skill name'}},required:['name']},source:{type:'skill'},traits:['destructive'],
  async execute(args){const a=object(args),name=typeof a.name==='string'?a.name.trim():'';if(!name)return text('Missing name.',true);try{const row=await existing(name);if(!row)throw new Error(`There's no skill named “${name}”.`);checkOwned(row);await ctx.store.delete(ctx.userId,'skill',row.id);await state.delete(ctx.userId,'skill',row.id);return text(`Deleted the skill “${name}”. It can't be loaded any more.`);}catch(e){return text(`Couldn't delete the skill: ${e instanceof Error?e.message:String(e)}`,true);}},
 }];
}
