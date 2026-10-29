import {randomUUID} from 'node:crypto';
import {Hono,type Context} from 'hono';
import {cors} from 'hono/cors';
import {streamSSE} from 'hono/streaming';
import {getCookie,setCookie,deleteCookie} from 'hono/cookie';
import {z} from 'zod';
import {
 ApprovalDecisionSchema,ChatTruncateSchema,ChatInputSchema,ChatPatchSchema,ChatSchema,ConsentSchema,ElicitationResponseSchema,ModelPreferenceSchema,PageQuerySchema,PreferencesInputSchema,PreferencesSchema,ProviderInputSchema,ProviderSchema,RunEventSchema,RunSnapshotSchema,StartRunSchema,
 type Chat,type JsonObject,type Message,type Model,type Provider,type Run,type RunSnapshot,type User,
} from '@praxis/protocol';
import {ApiError,ApiService} from './service.js';
import {seal} from './secrets.js';
import {ApiProviders} from './providers.js';
import {registerSyncRoutes} from './sync-routes.js';
type Env={Variables:{userId:string;requestId:string}};
export interface AppOptions {
 service:ApiService;encryptionKey?:string;fetcher?:typeof fetch;
 resolveSession?:(request:Request)=>Promise<{user:User;expiresAt:string}|null>;
 authHandler?:(request:Request)=>Promise<Response>;
 allowedOrigins?:string[];
 log?:(record:{requestId:string;method:string;path:string;status:number;durationMs:number})=>void;
}
export function createApp(options:AppOptions){
 const {service}=options;const app=new Hono<Env>();
 service.providers=new ApiProviders(service,options.encryptionKey,options.fetcher);
 if(service.local&&(process.env.NODE_ENV==='production'||process.env.VERCEL))throw new Error('Local adapters and auth are forbidden in production');
 const origins=options.allowedOrigins??(service.local?['http://localhost:5173','http://127.0.0.1:5173']:[]);
 app.use('*',cors({origin:origin=>origins.includes(origin)?origin:'',credentials:true,allowHeaders:['Content-Type','Authorization','Last-Event-ID','Idempotency-Key'],allowMethods:['GET','POST','PATCH','DELETE','OPTIONS'],exposeHeaders:['X-Request-ID']}));
 app.use('*',async(c,next)=>{const started=Date.now();c.set('requestId',randomUUID());c.header('X-Request-ID',c.get('requestId'));c.header('X-Content-Type-Options','nosniff');await next();options.log?.({requestId:c.get('requestId'),method:c.req.method,path:new URL(c.req.url).pathname,status:c.res.status,durationMs:Date.now()-started});});
 app.onError((e,c)=>{if(e instanceof ApiError)return c.json({type:'error',code:e.code,message:e.message,requestId:c.get('requestId')},e.status as 400);if(e instanceof z.ZodError)return c.json({type:'error',code:'validation_error',message:'Request does not match the protocol',requestId:c.get('requestId')},400);return c.json({type:'error',code:'internal_error',message:'Request could not be completed',requestId:c.get('requestId')},500);});
 app.notFound(c=>c.json({type:'error',code:'not_found',message:'Endpoint not found'},404));
 app.get('/health',c=>c.json({type:'health',ok:true,mode:service.local?'local':'production'}));
 const devTokens=new Map<string,string>([['dev-local','local-user']]);
 async function session(request:Request){
  if(service.local){const token=request.headers.get('authorization')?.replace(/^Bearer /i,'')??request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('praxis_session='))?.slice('praxis_session='.length);const id=token?devTokens.get(token):undefined;if(id)return {user:{type:'user' as const,id,name:'Local developer'},expiresAt:new Date(Date.now()+86400000).toISOString()};return null;}
  if(!options.resolveSession)throw new ApiError(503,'auth_unconfigured','Production authentication is not configured');return options.resolveSession(request);
 }
 app.post('/v1/auth/dev',async c=>{
  if(!service.local)throw new ApiError(404,'not_found','Endpoint not found');
  const input=await body(c,z.object({type:z.literal('auth.dev'),userId:z.string().min(1).max(100).optional()}));const userId=input.userId??'local-user';const token=userId==='local-user'?'dev-local':randomUUID();devTokens.set(token,userId);await service.seed(userId);setCookie(c,'praxis_session',token,{httpOnly:true,sameSite:'Lax',path:'/',maxAge:86400});return c.json({type:'session',user:{type:'user',id:userId,name:'Local developer'},bearerToken:token,expiresAt:new Date(Date.now()+86400000).toISOString()});
 });
 app.post('/v1/auth/sign-up',c=>auth(c));app.post('/v1/auth/sign-in',c=>auth(c));
 async function auth(c:Context){if(!options.authHandler)throw new ApiError(503,'auth_unconfigured','Email authentication is not configured');return options.authHandler(c.req.raw);}
 app.use('/v1/*',async(c,next)=>{if(c.req.path.startsWith('/v1/connectors/oauth/callback')||c.req.path==='/v1/oauth/client-metadata.json'){await next();return;}const auth=await session(c.req.raw);if(!auth)throw new ApiError(401,'unauthorized','Sign in to continue');c.set('userId',auth.user.id);await service.seed(auth.user.id);if(c.req.method!=='GET'&&c.req.method!=='HEAD'){const origin=c.req.header('origin');if(origin&&!origins.includes(origin))throw new ApiError(403,'origin_rejected','Origin is not allowed');}await next();});
 app.get('/v1/auth/session',async c=>{const auth=await session(c.req.raw);return c.json({type:'session',...auth});});
 app.post('/v1/auth/sign-out',async c=>{if(options.authHandler&&!service.local)return options.authHandler(c.req.raw);const token=c.req.header('authorization')?.replace(/^Bearer /i,'')??getCookie(c,'praxis_session');if(token)devTokens.delete(token);deleteCookie(c,'praxis_session',{path:'/'});return c.json({type:'ok'});});
 app.get('/v1/bootstrap',async c=>{c.header('Cache-Control','private, no-store');return c.json(await service.bootstrap(c.get('userId')));});
 app.get('/v1/chats',async c=>{const query=PageQuerySchema.parse(c.req.query());let rows=await service.list<Chat>(c.get('userId'),'chat');if(query.q)rows=rows.filter(x=>x.title.toLowerCase().includes(query.q!.toLowerCase()));rows.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));return c.json(page(rows,query,`chats:${query.q??''}`));});
 app.post('/v1/chats',async c=>{const input=await body(c,ChatInputSchema);const now=service.now();const id=input.id??randomUUID();if(await service.adapters.store.get(c.get('userId'),'chat',id))throw new ApiError(409,'exists','Chat ID already exists');const chat=ChatSchema.parse({...input,type:'chat',id,createdAt:now,updatedAt:now});await service.write(c.get('userId'),'chat',id,chat);return c.json(chat,201);});
 app.get('/v1/chats/:id',async c=>c.json(await service.require<Chat>(c.get('userId'),'chat',c.req.param('id'))));
 app.patch('/v1/chats/:id',async c=>{const chat=await service.require<Chat>(c.get('userId'),'chat',c.req.param('id'));const input=await body(c,ChatPatchSchema);const result=ChatSchema.parse({...chat,...input,type:'chat',id:chat.id,updatedAt:service.now()});await service.write(c.get('userId'),'chat',chat.id,result);return c.json(result);});
 app.delete('/v1/chats/:id',async c=>{const user=c.get('userId'),id=c.req.param('id');const chat=await service.require<Chat>(user,'chat',id);if(chat.activeRunId)await service.cancel(user,chat.activeRunId);await service.remove(user,'chat',id);for(const m of await service.list<Message>(user,'message',id))await service.remove(user,'message',m.id);return c.json({type:'ok'});});
 app.get('/v1/chats/:id/messages',async c=>{const id=c.req.param('id'),user=c.get('userId');await service.require(user,'chat',id);const rows=(await service.list<Message>(user,'message',id)).sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));return c.json(page(rows,PageQuerySchema.parse(c.req.query()),`messages:${id}`));});
 app.post('/v1/runs',async c=>{const input=await body(c,StartRunSchema);input.idempotencyKey??=c.req.header('Idempotency-Key');if(!service.local&&input.script)throw new ApiError(400,'local_only','Scripted runs are local only');return c.json(await service.start(c.get('userId'),input),202);});
 app.get('/v1/runs/:id',async c=>c.json(await service.require<Run>(c.get('userId'),'run',c.req.param('id'))));
 app.get('/v1/runs/:id/snapshot',async c=>c.json(RunSnapshotSchema.parse(await service.require(c.get('userId'),'snapshot',c.req.param('id')))));
 app.post('/v1/runs/:id/cancel',async c=>{await body(c,z.object({type:z.literal('run.cancel')}));return c.json(await service.cancel(c.get('userId'),c.req.param('id')),202);});
 app.post('/v1/runs/:id/approvals',async c=>c.json(await service.decision(c.get('userId'),c.req.param('id'),await body(c,ApprovalDecisionSchema)),202));
 app.post('/v1/runs/:id/elicitations',async c=>c.json(await service.decision(c.get('userId'),c.req.param('id'),await body(c,ElicitationResponseSchema)),202));
 app.get('/v1/runs/:id/events',async c=>{
  const user=c.get('userId'),runId=c.req.param('id');await service.require<Run>(user,'run',runId);let after=eventCursor(c);
  const first=await service.adapters.events.read(user,`run:${runId}`,after,100);if(first.length&&first[0]!.id>after+1)throw new ApiError(409,'cursor_expired','Fetch the run snapshot before reconnecting');
  c.header('Cache-Control','no-cache, no-transform');c.header('X-Accel-Buffering','no');return streamSSE(c,async stream=>{
   let heartbeat=Date.now();while(!stream.aborted){const records=await service.adapters.events.read(user,`run:${runId}`,after,100);for(const r of records){const payload=RunEventSchema.parse({type:'run.event',id:r.id,runId,chatId:r.payload.chatId,createdAt:r.payload.createdAt,event:r.payload.event});await stream.writeSSE({id:String(r.id),event:'run.event',data:JSON.stringify(payload)});after=r.id;if(payload.event.type==='run.finished')return;}
    const current=await service.require<Run>(user,'run',runId);if(service.terminal(current)&&after>=current.lastEventId)return;
    if(Date.now()-heartbeat>15000){await stream.write(': keepalive\n\n');heartbeat=Date.now();}await stream.sleep(30);
   }
  },async()=>{});
 });
 app.get('/v1/events',async c=>{const user=c.get('userId');let after=eventCursor(c);c.header('Cache-Control','no-cache, no-transform');c.header('X-Accel-Buffering','no');return streamSSE(c,async stream=>{let heartbeat=Date.now();while(!stream.aborted){for(const e of await service.adapters.events.read(user,'user',after,100)){await stream.writeSSE({id:String(e.id),event:'user.event',data:JSON.stringify({type:'user.event',id:e.id,...e.payload,syncCursor:String(e.id),...(e.payload.type?{type:'user.event'}:{})})});after=e.id;}if(Date.now()-heartbeat>15000){await stream.write(': keepalive\n\n');heartbeat=Date.now();}await stream.sleep(100);}},async()=>{});});
 app.get('/v1/providers',async c=>c.json(page(await service.list<Provider>(c.get('userId'),'provider'),PageQuerySchema.parse(c.req.query()),'providers')));
 app.post('/v1/providers',async c=>{const input=await body(c,ProviderInputSchema);const id=randomUUID(),user=c.get('userId');await saveProviderSecret(user,id,input);const provider=ProviderSchema.parse({...input,type:'provider',id,maskedKey:input.apiKey?mask(input.apiKey):'Not configured',headerNames:Object.keys(input.extraHeaders??{}),capabilities:input.capabilities??{},updatedAt:service.now()});await service.write(user,'provider',id,provider);return c.json(provider,201);});
 app.get('/v1/providers/:id',async c=>c.json(await service.require<Provider>(c.get('userId'),'provider',c.req.param('id'))));
 app.patch('/v1/providers/:id',async c=>{const user=c.get('userId'),id=c.req.param('id');const prior=await service.require<Provider>(user,'provider',id);const input=await body(c,ProviderInputSchema);if(input.apiKey||input.extraHeaders)await saveProviderSecret(user,id,input);const provider=ProviderSchema.parse({...prior,...input,type:'provider',id,maskedKey:input.apiKey?mask(input.apiKey):prior.maskedKey,headerNames:input.extraHeaders?Object.keys(input.extraHeaders):prior.headerNames,updatedAt:service.now()});await service.write(user,'provider',id,provider);return c.json(provider);});
 app.delete('/v1/providers/:id',async c=>{const user=c.get('userId'),id=c.req.param('id');await service.remove(user,'provider',id);await service.adapters.store.delete(user,'providerSecret',id);return c.json({type:'ok'});});
 async function saveProviderSecret(user:string,id:string,input:z.infer<typeof ProviderInputSchema>){const existing=await service.adapters.store.get(user,'providerSecret',id);const value={...existing?.value};if(input.apiKey)value.apiKey=seal(input.apiKey,user,`provider:${id}:key`,options.encryptionKey);if(input.extraHeaders)value.extraHeaders=seal(JSON.stringify(input.extraHeaders),user,`provider:${id}:headers`,options.encryptionKey);await service.put(user,'providerSecret',id,value);}
 app.post('/v1/providers/:id/test',async c=>{await body(c,z.object({type:z.literal('provider.test')}));const models=await service.providers!.refresh(c.get('userId'),c.req.param('id'));return c.json({type:'provider.test.result',ok:true,models});});
 app.post('/v1/providers/:id/refresh-models',async c=>{await body(c,z.object({type:z.literal('models.refresh')}));const models=await service.providers!.refresh(c.get('userId'),c.req.param('id'));return c.json({type:'page',items:models.slice(0,100),nextCursor:null});});
 app.post('/v1/chats/:id/truncate',async c=>{const input=await body(c,ChatTruncateSchema);return c.json(await service.truncate(c.get('userId'),c.req.param('id'),input.clientTurnId));});
 app.get('/v1/models',async c=>{const query=PageQuerySchema.parse(c.req.query());let models=await service.list<Model>(c.get('userId'),'model');const provider=c.req.query('providerId');if(provider)models=models.filter(m=>m.providerId===provider);if(query.q)models=models.filter(m=>`${m.displayName} ${m.id}`.toLowerCase().includes(query.q!.toLowerCase()));if(c.req.query('pinned')==='true')models=models.filter(m=>m.pinned);if(c.req.query('favorite')==='true')models=models.filter(m=>m.favorite);models.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||a.displayName.localeCompare(b.displayName)||a.id.localeCompare(b.id));return c.json(page(models,query,`models:${provider??''}:${query.q??''}:${c.req.query('pinned')??''}:${c.req.query('favorite')??''}`));});
 app.patch('/v1/models/preferences',async c=>{const input=await body(c,ModelPreferenceSchema);const id=`${input.providerId}:${input.modelId}`,user=c.get('userId');const model=await service.require<Model>(user,'model',id);if(input.pinned!==undefined)model.pinned=input.pinned;if(input.favorite!==undefined)model.favorite=input.favorite;await service.write(user,'model',id,model);return c.json(model);});
 app.get('/v1/consents',async c=>c.json(page(await service.list(c.get('userId'),'consent'),PageQuerySchema.parse(c.req.query()),'consents')));
 app.post('/v1/consents',async c=>{const input=await body(c,ConsentSchema);const consent={...input,host:input.host.toLowerCase(),updatedAt:service.now()};await service.write(c.get('userId'),'consent',consent.host,consent);return c.json(consent);});
 app.get('/v1/preferences',async c=>c.json(await preferences(c.get('userId'))));
 app.patch('/v1/preferences',async c=>{const user=c.get('userId'),input=await body(c,PreferencesInputSchema);const current=await preferences(user);if(input.vision)current.vision={...current.vision,...input.vision};if(input.voice){const {apiKey,...publicPrefs}=input.voice;current.voice={...current.voice,...publicPrefs};if(apiKey){await service.put(user,'voiceSecret','current',{key:seal(apiKey,user,'voice',options.encryptionKey)});current.voice.configured=true;}}current.updatedAt=service.now();await service.write(user,'preferences','current',current,'consent');return c.json(current);});
 async function preferences(user:string){const existing=await service.adapters.store.get(user,'preferences','current');return PreferencesSchema.parse(existing?.value??{type:'preferences',vision:{},voice:{configured:!!process.env.GROQ_API_KEY},updatedAt:service.now()});}
 app.get('/v1/runs/:runId/outputs/:id',async c=>{await service.require(c.get('userId'),'run',c.req.param('runId'));const output=await service.require<JsonObject>(c.get('userId'),'output',c.req.param('id'));if(output.runId!==c.req.param('runId'))throw new ApiError(404,'not_found','Output not found');const offset=z.coerce.number().int().nonnegative().parse(c.req.query('offset')??0),limit=z.coerce.number().int().min(1).max(100000).parse(c.req.query('limit')??16000);const text=String(output.text??'');return c.json({type:'tool.output',id:c.req.param('id'),text:text.slice(offset,offset+limit),offset,nextOffset:offset+limit<text.length?offset+limit:null});});
 registerSyncRoutes(app,service);
 return {app,session};
}
async function body<T extends z.ZodType>(c:Context,schema:T):Promise<z.infer<T>>{const length=Number(c.req.header('content-length')??0);if(length>1000000)throw new ApiError(413,'too_large','Request is too large');let data:unknown;try{const text=await c.req.text();if(Buffer.byteLength(text)>1000000)throw new ApiError(413,'too_large','Request is too large');data=JSON.parse(text);}catch(e){if(e instanceof ApiError)throw e;throw new ApiError(400,'invalid_json','Expected a JSON request body');}return schema.parse(data);}
function mask(key:string){return `••••${key.slice(-4)}`;}
function eventCursor(c:Context){const raw=c.req.header('Last-Event-ID')??c.req.query('after')??'0';if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new ApiError(400,'invalid_cursor','Invalid event cursor');return Number(raw);}
function page<T>(items:T[],query:{cursor?:string;limit:number},scope:string){let offset=0;if(query.cursor){try{const value=JSON.parse(Buffer.from(query.cursor,'base64url').toString());if(value.scope!==scope||!Number.isSafeInteger(value.offset)||value.offset<0)throw 0;offset=value.offset;}catch{throw new ApiError(400,'invalid_cursor','Invalid page cursor');}}const end=offset+query.limit;return {type:'page',items:items.slice(offset,end),nextCursor:end<items.length?Buffer.from(JSON.stringify({scope,offset:end})).toString('base64url'):null};}
