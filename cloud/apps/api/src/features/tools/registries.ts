import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {FeatureContext} from '../../contracts.js';
import {ApiError} from '../../service.js';
import {publicFetch} from './http.js';
import {parseSkillDocument,requireRow,saveSkill} from './skills.js';
const Entry=z.object({id:z.string().min(1).max(500),name:z.string().max(100),description:z.string().max(2000).default(''),url:z.string().url().optional(),document:z.string().max(500000).optional(),digest:z.string().regex(/^sha256:[a-fA-F0-9]{64}$/).optional()});
export type RegistryEntry=z.infer<typeof Entry>;
export async function registryEntries(ctx:FeatureContext,id:string):Promise<RegistryEntry[]>{
 const row=await requireRow(ctx,'registry',id);if(row.value.enabled===false)throw new ApiError(409,'registry_disabled','Registry is disabled');
 const url=z.string().url().parse(row.value.url);const key=JSON.stringify(['tools','registry',ctx.userId,id,url]);const cached=await ctx.kv.get<RegistryEntry[]>(key);if(cached)return cached;
 if(ctx.local&&new URL(url).hostname==='skills.praxis.local'){return [{id:'local-example',name:'local-example',description:'Local fixture skill',document:'---\nname: local-example\ndescription: Local fixture skill\n---\nUse the local deterministic tools.'}];}
 const {response,bytes}=await publicFetch(ctx,url,{},false,2000000);if(!response.ok)throw new ApiError(502,'registry_failed','Could not fetch registry');
 const data=z.union([z.array(Entry).max(2000),z.object({skills:z.array(Entry).max(2000)}),z.object({entries:z.array(Entry).max(2000)})]).parse(JSON.parse(new TextDecoder().decode(bytes)));
 const entries=Array.isArray(data)?data:'skills' in data?data.skills:data.entries;
 if(new Set(entries.map(e=>e.id)).size!==entries.length)throw new ApiError(400,'invalid_registry','Duplicate registry entry IDs');await ctx.kv.set(key,entries,600);return entries;
}
export async function installSkill(ctx:FeatureContext,id:string,skillId:string,existingId?:string){
 const entries=await registryEntries(ctx,id),entry=entries.find(e=>e.id===skillId);if(!entry)throw new ApiError(404,'not_found','Registry skill not found');let document=entry.document;
 if(document===undefined){if(!entry.url)throw new ApiError(400,'invalid_registry','Registry entry has no SKILL.md URL');const {response,bytes}=await publicFetch(ctx,entry.url,{},false,500000);if(!response.ok)throw new ApiError(502,'registry_failed','Could not fetch SKILL.md');if(entry.digest&&`sha256:${createHash('sha256').update(bytes).digest('hex')}`!==entry.digest.toLowerCase())throw new ApiError(400,'digest_mismatch','SKILL.md digest mismatch');document=new TextDecoder().decode(bytes);}
 else if(entry.digest&&`sha256:${createHash('sha256').update(document).digest('hex')}`!==entry.digest.toLowerCase())throw new ApiError(400,'digest_mismatch','SKILL.md digest mismatch');
 const parsed=parseSkillDocument(document);if((await ctx.store.list(ctx.userId,'skill')).some(r=>!r.deleted&&r.id!==existingId&&r.value.name===parsed.name))throw new ApiError(409,'skill_exists','A skill with that name is already installed');
 return saveSkill(ctx,{name:parsed.name,description:parsed.description,document,enabled:true,registryId:id,registryEntryId:entry.id,registryDigest:`sha256:${createHash('sha256').update(document).digest('hex')}`},existingId);
}

export async function skillUpdates(ctx:FeatureContext){
 const updates=[];
 for(const row of await ctx.store.list(ctx.userId,'skill')){
  if(row.deleted||typeof row.value.registryId!=='string'||typeof row.value.registryEntryId!=='string')continue;
  const registry=await ctx.store.get(ctx.userId,'registry',row.value.registryId);
  if(!registry||registry.deleted||registry.value.enabled===false)continue;
  const entry=(await registryEntries(ctx,registry.id)).find(e=>e.id===row.value.registryEntryId);
  if(entry?.digest&&entry.digest.toLowerCase()!==row.value.registryDigest)updates.push({type:'skill.update' as const,skillId:row.id,registryId:registry.id,entryId:entry.id,digest:entry.digest,updateAvailable:true as const});
 }
 return updates;
}
export async function updateSkill(ctx:FeatureContext,id:string){
 const row=await requireRow(ctx,'skill',id);
 if(typeof row.value.registryId!=='string'||typeof row.value.registryEntryId!=='string')throw new ApiError(409,'not_registry_skill','Skill was not installed from a registry');
 const skill=await installSkill(ctx,row.value.registryId,row.value.registryEntryId,id);
 if(row.value.enabled===false){skill.enabled=false;await ctx.store.put(ctx.userId,'skill',id,skill);}
 return skill;
}
