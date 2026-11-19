import {JsonObjectSchema} from '@praxis/protocol';
import {v, ConvexError} from 'convex/values';
import {serverQuery, serverMutation, type QueryCtx} from './functions.js';
import {bounded} from './access.js';
const address={serverToken:v.string(),userId:v.string(),kind:v.string(),id:v.string()};
function row(ctx:QueryCtx,a:{userId:string;kind:string;id:string}) {
 [a.userId,a.kind,a.id].forEach(bounded);
 if(!['skill','javascriptKV'].includes(a.kind))throw new ConvexError('Invalid tools state kind');
 return ctx.db.query('toolState').withIndex('owner_kind_id',q=>q.eq('userId',a.userId).eq('kind',a.kind).eq('id',a.id)).unique();
}
function files(ctx:QueryCtx,a:{userId:string;id:string}) {
 return ctx.db.query('toolSkillFiles').withIndex('owner_skill',q=>q.eq('userId',a.userId).eq('skillId',a.id)).collect();
}
const TOOLS_STATE_JSON_CHARACTERS_MAX = 6_000_000;
const TOOLS_METADATA_JSON_CHARACTERS_MAX = 400_000;
const SKILL_FILES_MAX = 100;
const SKILL_FILE_BYTES_MAX = 500_000;

export const get = serverQuery({
 args: address,
 handler: async (ctx, a) => {
  const existing = await row(ctx, a);
  if (!existing) return null;
  if (!('encoded' in existing.value)) throw new ConvexError('Invalid tools state value');
  const stored = JsonObjectSchema.parse(JSON.parse(existing.value.encoded));
  if (a.kind !== 'skill' || stored.hasFiles !== true) return stored;
  const {hasFiles: _, ...value} = stored;
  return {...value, files: Object.fromEntries((await files(ctx, a)).map(f => [f.path, f.content]))};
 },
});

export const put = serverMutation({
 args: {...address, valueJson: v.string()},
 handler: async (ctx, a) => {
  if (a.valueJson.length > TOOLS_STATE_JSON_CHARACTERS_MAX) throw new ConvexError('Invalid tools state value');
  const existing = await row(ctx, a);
  let value = JsonObjectSchema.parse(JSON.parse(a.valueJson));
  if (a.kind === 'skill') {
   const {files: bundle, ...rest} = value;
   const entries = bundle === undefined ? [] : Object.entries(JsonObjectSchema.parse(bundle));
   if (entries.length > SKILL_FILES_MAX) throw new ConvexError('Invalid skill files');
   for (const f of await files(ctx, a)) await ctx.db.delete(f._id);
   for (const [path, content] of entries) {
    if (typeof content !== 'string' || new TextEncoder().encode(content).length > SKILL_FILE_BYTES_MAX) {
     throw new ConvexError('Skill file exceeds 500 KB');
    }
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) {
     throw new ConvexError('Invalid skill file path');
    }
    await ctx.db.insert('toolSkillFiles', {userId: a.userId, skillId: a.id, path, content});
   }
   value = {...rest, ...(bundle === undefined ? {} : {hasFiles: true})};
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > TOOLS_METADATA_JSON_CHARACTERS_MAX) throw new ConvexError('Tools state metadata exceeds 400 KB');
  if (existing) await ctx.db.patch(existing._id, {value: {encoded}});
  else await ctx.db.insert('toolState', {userId: a.userId, kind: a.kind, id: a.id, value: {encoded}});
  return null;
 },
});
export const remove=serverMutation({args:address,handler:async(ctx,a)=>{
 const existing=await row(ctx,a);if(existing)await ctx.db.delete(existing._id);
 if(a.kind==='skill')for(const f of await files(ctx,a))await ctx.db.delete(f._id);return null;
}});
