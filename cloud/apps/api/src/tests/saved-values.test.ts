import {expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {createPraxisApp} from '../server.js';
import {createLocalAdapters} from '../local-memory.js';
import {featureContext} from '../features.js';
import {protectAnswer,executionSecrets} from '../saved-secrets.js';

it('serves empty accounts, saves variables and write-only secrets, survives a new session, renames and deletes',async()=>{
 const adapters=createLocalAdapters(),key=randomBytes(32).toString('base64');
 let runtime=createPraxisApp({adapters,local:true,encryptionKey:key});
 const req=async(path:string,data?:unknown,method=data?'POST':'GET')=>runtime.app.request(path,{method,headers:{Authorization:'Bearer dev-local','Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
 expect((await req('/v1/saved-secrets')).status).toBe(200);
 expect(await req('/v1/saved-values').then(r=>r.json())).toEqual({items:[]});
 const secret=await req('/v1/saved-values',{name:'token',kind:'secret',value:'SYNTHETIC-R2-CREDENTIAL'}).then(r=>r.json());
 const variable=await req('/v1/saved-values',{name:'region',kind:'variable',value:{region:'eu',replicas:2}}).then(r=>r.json());
 runtime=createPraxisApp({adapters,local:true,encryptionKey:key});
 let items=(await req('/v1/saved-values').then(r=>r.json())).items;
 expect(items).toHaveLength(2);
 expect(items.find((v:any)=>v.kind==='secret')).not.toHaveProperty('value');
 expect(JSON.stringify(items)).not.toContain('SYNTHETIC-R2-CREDENTIAL');
 expect(items.find((v:any)=>v.kind==='variable').value).toEqual({region:'eu',replicas:2});
 const boundary=await executionSecrets(featureContext(runtime.service,'local-user',{encryptionKey:key}),'new-chat');
 expect(boundary.resolve('{{secret:'+secret.id+'}}')).toBe('SYNTHETIC-R2-CREDENTIAL');
 expect((await req('/v1/saved-values/'+variable.id,{name:'deployment'},'PATCH')).status).toBe(200);
 expect((await req('/v1/saved-values/'+secret.id,undefined,'DELETE')).status).toBe(200);
 items=(await req('/v1/saved-values').then(r=>r.json())).items;
 expect(items.map((v:any)=>v.name)).toEqual(['deployment']);
 expect(JSON.stringify(await adapters.store.changes('local-user',0,1000))).not.toContain('SYNTHETIC-R2-CREDENTIAL');
});
it('submit and save keeps normal answers visible while protecting secret fields and removes save flags',async()=>{
 const {service}=createPraxisApp({adapters:createLocalAdapters(),local:true});
 const key=randomBytes(32).toString('base64'),ctx=featureContext(service,'u',{encryptionKey:key});
 const answer=await protectAnswer(ctx,'c',{properties:{region:{type:'string'},token:{type:'string',format:'password'},pin:{type:'integer','x-sensitive':true}}},{region:'eu-west',token:'SYNTHETIC-R2-PROMPT',pin:4829718362,__save_region:true,__save_token:true,__save_pin:true});
 expect(answer.region).toBe('eu-west');expect(answer.token).toMatch(/^\{\{secret:/);
 expect(Object.keys(answer)).toEqual(['region','token','pin']);expect(answer.pin).toMatch(/^\{\{secret:/);
 const variables=await service.list<any>('u','savedVariable');
 expect(variables[0].value).toBe('eu-west');
 const persisted=JSON.stringify(await service.adapters.store.changes('u',0,1000));expect(persisted).not.toContain('SYNTHETIC-R2-PROMPT');expect(persisted).not.toContain('4829718362');
});
it('saved values are account scoped',async()=>{
 const {app}=createPraxisApp({adapters:createLocalAdapters(),local:true,encryptionKey:randomBytes(32).toString('base64')});
 const request=async(path:string,init:RequestInit)=>app.request(path,init);
 const session=await request('/v1/auth/dev',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'auth.dev',userId:'other'})}).then(r=>r.json());
 const secret=await request('/v1/saved-values',{method:'POST',headers:{Authorization:'Bearer dev-local','content-type':'application/json'},body:JSON.stringify({name:'private',kind:'secret',value:'SYNTHETIC-OWNER'})}).then(r=>r.json());
 const headers={Authorization:'Bearer '+session.bearerToken,'content-type':'application/json'};
 expect(await request('/v1/saved-values',{headers}).then(r=>r.json())).toEqual({items:[]});
 expect((await request('/v1/saved-values/'+secret.id,{method:'DELETE',headers})).status).toBe(404);
});
