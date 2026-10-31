import {randomUUID} from 'node:crypto';
import {parseDocument,stringify} from 'yaml';
import {z} from 'zod';
import {SkillSchema,type Skill} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import {ApiError} from '../../service.js';
export function parseSkillDocument(document:string){
 if(Buffer.byteLength(document)>500000)throw new ApiError(400,'invalid_skill','SKILL.md exceeds 500 KB');
 const lines=document.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trimStart().split('\n');
 if(lines[0]?.trimEnd()!=='---')throw new ApiError(400,'invalid_skill','SKILL.md must start with YAML frontmatter');
 const end=lines.findIndex((line,i)=>i>0&&['---','...'].includes(line.trimEnd()));
 if(end<0)throw new ApiError(400,'invalid_skill','SKILL.md frontmatter is not closed');
 const parsed=parseDocument(lines.slice(1,end).join('\n'),{uniqueKeys:true,version:'1.2'});
 if(parsed.errors.length)throw new ApiError(400,'invalid_skill','Invalid or duplicate YAML frontmatter fields');
 let front:unknown;try{front=parsed.toJS({maxAliasCount:0});}catch{throw new ApiError(400,'invalid_skill','YAML aliases are not supported');}
 const fields=z.object({name:z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),description:z.string().trim().min(1).max(1024).refine(s=>!/<\/?[A-Za-z][^>]*>/.test(s),'XML tags are not allowed')}).safeParse(front);
 if(!fields.success)throw new ApiError(400,'invalid_skill','Skill requires a lowercase hyphenated name (1–64) and description (1–1024, no XML tags)');
 const body=lines.slice(end+1).join('\n').trim();if(!body)throw new ApiError(400,'invalid_skill','Skill has no instructions');
 return {...fields.data,body};
}
export function skillDocument(name:string,description:string,instructions:string){return `---\n${stringify({name,description}).trimEnd()}\n---\n${instructions.trim()}\n`;}
export async function requireRow(ctx:FeatureContext,kind:string,id:string){const row=await ctx.store.get(ctx.userId,kind,id);if(!row||row.deleted)throw new ApiError(404,'not_found','Resource not found');return row;}
export async function saveSkill(ctx:FeatureContext,input:{name:string;description:string;document:string;enabled:boolean},id=randomUUID() as string){
 const parsed=parseSkillDocument(input.document);
 if(input.name!==parsed.name||input.description.trim()!==parsed.description)throw new ApiError(400,'invalid_skill','Name and description must match SKILL.md frontmatter');
 if((await ctx.store.list(ctx.userId,'skill')).some(r=>!r.deleted&&r.id!==id&&r.value.name===parsed.name))throw new ApiError(409,'skill_exists','A skill with that name exists');
 const skill=SkillSchema.parse({...input,type:'skill',id,updatedAt:new Date().toISOString()});
 await ctx.store.put(ctx.userId,'skill',id,skill);return skill;
}
export async function skillByName(ctx:FeatureContext,name:string):Promise<Skill>{const row=(await ctx.store.list(ctx.userId,'skill')).find(r=>!r.deleted&&r.value.name===name&&r.value.enabled!==false);if(!row)throw new ApiError(404,'not_found','Enabled skill not found');return SkillSchema.parse(row.value);}
export function skillPath(path:string){if(!path||path.length>240||(path.startsWith('/')||/^[a-z]:/i.test(path)||path.startsWith('~')||/%(?:2e|2f|5c)/i.test(path))||path.includes('\\')||path.includes('\0')||path.split('/').some(p=>p===''||p==='.'||p==='..'||p.startsWith('.')))throw new ApiError(400,'invalid_path','Expected a relative skill file path');return path;}
export function allowedSkillFile(path:string){skillPath(path);return !path.split('/').includes('scripts')&&/\.(md|txt|csv|json|ya?ml|xml|html|css)$/i.test(path);}
