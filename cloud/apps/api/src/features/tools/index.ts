import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {z} from 'zod';
import {AttachmentSchema,IdSchema,PageQuerySchema,RegistryInputSchema,RegistrySchema,SkillInputSchema,SkillSchema,UploadCompleteSchema,UploadRequestSchema} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import {ApiError} from '../../service.js';
import {jsonBody,page,readLimited} from './http.js';
import {requireRow,saveSkill} from './skills.js';
import {installSkill,registryEntries} from './registries.js';
import {transcribe} from './transcribe.js';
import {createLocalToolsStorage} from './local-storage.js';
import type {ToolsPorts} from './ports.js';
export type {ToolsStorage,ToolsPorts,VisionProvider,UploadInput} from './ports.js';
export {createLocalToolsStorage} from './local-storage.js';
export {parseSkillDocument} from './skills.js';
export function createToolsRoutes(context:(req:Request)=>Promise<FeatureContext>,ports:ToolsPorts={}):Hono{
 const app=new Hono();let localStorage:ReturnType<typeof createLocalToolsStorage>|undefined;
 const storage=(ctx:FeatureContext,req:Request)=>{if(ports.storage)return ports.storage;if(ctx.local)return localStorage??=createLocalToolsStorage(req.url);throw new ApiError(503,'storage_unconfigured','Attachment storage is not configured');};
 app.onError((e,c)=>{if(e instanceof ApiError)return c.json({type:'error',code:e.code,message:e.message},e.status as 400);if(e instanceof z.ZodError)return c.json({type:'error',code:'validation_error',message:'Request does not match the protocol'},400);return c.json({type:'error',code:'internal_error',message:'Request could not be completed'},500);});
 for(const [path,kind,input,schema] of [['skills','skill',SkillInputSchema,SkillSchema],['skill-registries','registry',RegistryInputSchema,RegistrySchema]] as const){
  app.get(`/${path}`,async c=>{const ctx=await context(c.req.raw),query=PageQuerySchema.parse(c.req.query());let rows=(await ctx.store.list(ctx.userId,kind)).filter(r=>!r.deleted).map(r=>schema.parse(r.value));if(query.q)rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(query.q!.toLowerCase()));rows.sort((a,b)=>a.id.localeCompare(b.id));return c.json(page(rows,query,JSON.stringify([ctx.userId,path,query.q??''])));});
  app.post(`/${path}`,async c=>{const ctx=await context(c.req.raw),value=await jsonBody(c.req.raw,input);let result;if(kind==='skill')result=await saveSkill(ctx,SkillInputSchema.parse(value));else{result=RegistrySchema.parse({...value,type:'skill.registry',id:randomUUID()});await ctx.store.put(ctx.userId,kind,result.id,result);}await ports.changed?.(ctx,kind,result.id,result);return c.json(result,201);});
  app.get(`/${path}/:id`,async c=>{const ctx=await context(c.req.raw);return c.json(schema.parse((await requireRow(ctx,kind,IdSchema.parse(c.req.param('id')))).value));});
  app.patch(`/${path}/:id`,async c=>{const ctx=await context(c.req.raw),id=IdSchema.parse(c.req.param('id'));await requireRow(ctx,kind,id);const value=await jsonBody(c.req.raw,input);let result;if(kind==='skill')result=await saveSkill(ctx,SkillInputSchema.parse(value),id);else{result=RegistrySchema.parse({...value,type:'skill.registry',id});await ctx.store.put(ctx.userId,kind,id,result);}await ports.changed?.(ctx,kind,id,result);return c.json(result);});
  app.delete(`/${path}/:id`,async c=>{const ctx=await context(c.req.raw),id=IdSchema.parse(c.req.param('id'));await requireRow(ctx,kind,id);await ctx.store.delete(ctx.userId,kind,id);await ports.changed?.(ctx,kind,id,null);return c.json({type:'ok'});});
 }
 app.get('/skill-registries/:id/search',async c=>{const ctx=await context(c.req.raw),q=PageQuerySchema.parse(c.req.query()),id=IdSchema.parse(c.req.param('id'));let entries=await registryEntries(ctx,id);if(q.q)entries=entries.filter(e=>`${e.name} ${e.description}`.toLowerCase().includes(q.q!.toLowerCase()));return c.json(page(entries.map(({document,digest,...e})=>({type:'skill.registry.entry',...e})),q,JSON.stringify([ctx.userId,id,q.q??''])));});
 app.post('/skill-registries/:id/install',async c=>{const ctx=await context(c.req.raw),input=await jsonBody(c.req.raw,z.object({type:z.literal('skill.install'),skillId:IdSchema}));const result=await installSkill(ctx,IdSchema.parse(c.req.param('id')),input.skillId);await ports.changed?.(ctx,'skill',result.id,result);return c.json(result,201);});
 app.post('/uploads',async c=>{const ctx=await context(c.req.raw),input=await jsonBody(c.req.raw,UploadRequestSchema);if(input.chatId)await requireRow(ctx,'chat',input.chatId);return c.json({type:'upload.url',...await storage(ctx,c.req.raw).createUpload(ctx.userId,input)});});
 const upload=async(c:import('hono').Context)=>{const ctx=await context(c.req.raw),s=storage(ctx,c.req.raw);if(!s.acceptUpload)throw new ApiError(503,'storage_unconfigured','Upload proxy is not configured');const id=await s.acceptUpload(ctx.userId,IdSchema.parse(c.req.param('token')),await readLimited(c.req.raw.body,25000000),c.req.header('content-type')??'application/octet-stream');return c.json({type:'upload.receipt',storageId:id});};
 app.put('/uploads/content/:token',upload);app.post('/uploads/content/:token',upload);
 app.post('/uploads/complete',async c=>{const ctx=await context(c.req.raw),input=await jsonBody(c.req.raw,UploadCompleteSchema.extend({hiddenFromCode:z.boolean().default(false)}));if(input.chatId)await requireRow(ctx,'chat',input.chatId);await storage(ctx,c.req.raw).verify(ctx.userId,input.storageId,input);const existing=(await ctx.store.list(ctx.userId,'attachment')).find(r=>!r.deleted&&r.value.storageId===input.storageId);if(existing)return c.json(AttachmentSchema.parse(existing.value));const id=randomUUID();const attachment=AttachmentSchema.parse({...input,type:'attachment',id,url:new URL(`/v1/uploads/${id}/download`,c.req.url).href});await ctx.store.put(ctx.userId,'attachment',id,{...attachment,storageId:input.storageId,...(input.chatId?{chatId:input.chatId}:{})});await ports.changed?.(ctx,'attachment',id,attachment);return c.json(attachment,201);});
 app.get('/uploads/:id',async c=>{const ctx=await context(c.req.raw);return c.json(AttachmentSchema.parse((await requireRow(ctx,'attachment',IdSchema.parse(c.req.param('id')))).value));});
 app.patch('/uploads/:id',async c=>{const ctx=await context(c.req.raw),id=IdSchema.parse(c.req.param('id')),row=await requireRow(ctx,'attachment',id),input=await jsonBody(c.req.raw,z.object({type:z.literal('attachment.patch'),hiddenFromCode:z.boolean()}));const value={...row.value,hiddenFromCode:input.hiddenFromCode};await ctx.store.put(ctx.userId,'attachment',id,value);const result=AttachmentSchema.parse(value);await ports.changed?.(ctx,'attachment',id,result);return c.json(result);});
 app.get('/uploads/:id/download',async c=>{const ctx=await context(c.req.raw),row=await requireRow(ctx,'attachment',IdSchema.parse(c.req.param('id')));const file=await storage(ctx,c.req.raw).read(ctx.userId,z.string().parse(row.value.storageId));return new Response(Uint8Array.from(file.bytes).buffer,{headers:{'Content-Type':file.mediaType,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(String(row.value.name))}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});});
 app.delete('/uploads/:id',async c=>{const ctx=await context(c.req.raw),id=IdSchema.parse(c.req.param('id')),row=await requireRow(ctx,'attachment',id);await storage(ctx,c.req.raw).delete(ctx.userId,z.string().parse(row.value.storageId));await ctx.store.delete(ctx.userId,'attachment',id);await ports.changed?.(ctx,'attachment',id,null);return c.json({type:'ok'});});
 app.post('/transcribe',async c=>c.json(await transcribe(c.req.raw,await context(c.req.raw),ports)));
 return app;
}
export {createConvexToolsStorage,toolsStorageFromRPC} from './convex-storage.js';
