import {expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {createPraxisApp} from '../server.js';
import {createLocalAdapters} from '../local-memory.js';
import {featureContext} from '../features.js';
import {saveSecret,saveVariable,savedValues,executionSecrets} from '../saved-secrets.js';
import {relatedVariables,variablePrompt,variablesTool,VARIABLE_PROMPT_BYTES} from '../variables.js';
import {connectorDomain,connectorIcon} from '../connector-icons.js';
import type {Message} from '@praxis/protocol';
it('regenerates a middle reply with the original user message once and branches later turns away',async()=>{
 const {service}=createPraxisApp({adapters:createLocalAdapters(),local:true});await service.seed('u');
 const received:Message[][]=[];
 service.driver={async start(u,r,_c,m){received.push(structuredClone(m));const now=service.now();await service.emit(u,r.id,{type:'messages.committed',messages:[{type:'message',id:r.id+'-reply',chatId:r.chatId,runId:r.id,role:'assistant',parts:[{type:'text',text:'answer'}],createdAt:now,updatedAt:now}]});await service.emit(u,r.id,{type:'run.finished',outcome:'completed'});},async resume(){}};
 const start=async(text:string,regenerateMessageId?:string)=>{const run=await service.start('u',{type:'run.start',chatId:'welcome',text,attachmentIds:[],webSearch:false,clientTurnId:crypto.randomUUID(),regenerateMessageId});await service.drain();return run;};
 const first=await start('Closer');await start('Later question');
 const regenerated=await start('Closer',first.id+'-reply');
 expect(regenerated.promptStartedAt).toBe(regenerated.createdAt);
 expect(first.promptStartedAt).toBeUndefined();
 const rows=await service.list<Message>('u','message','welcome');
 expect(rows.filter(m=>m.role==='user')).toHaveLength(1);
 expect(rows.some(m=>m.parts.some(p=>p.text==='Later question'))).toBe(false);
 expect(rows.filter(m=>m.role==='assistant')).toHaveLength(1);
 expect(rows.find(m=>m.role==='assistant')?.promptStartedAt).toBe(regenerated.createdAt);
 expect(received[2]!.map(m=>m.parts.map(p=>p.text).join(''))).toEqual(['Closer']);
});
it('retrieves related variables with a bounded prompt and never reads secret plaintext',async()=>{
 const key=randomBytes(32).toString('base64'),{service}=createPraxisApp({adapters:createLocalAdapters(),local:true});
 const ctx=featureContext(service,'u',{encryptionKey:key});
 const id=await saveVariable(ctx,'deployment region','Warsaw');await saveVariable(ctx,'favourite food','noodles');
 const ref=await saveSecret(ctx,'deployment token','SYNTHETIC-NEVER-IN-PROMPT',true,'c');
 const related=await relatedVariables(ctx,'deployment region');expect(related[0]!.id).toBe(id);expect(related.some(v=>v.name==='favourite food')).toBe(false);
 await saveVariable(ctx,'deployment oversized','x'.repeat(10000));
 const prompt=await variablePrompt(ctx,'deployment region token');expect(Buffer.byteLength(prompt!)).toBeLessThanOrEqual(VARIABLE_PROMPT_BYTES);expect(prompt).toContain(ref);expect(prompt).not.toContain('SYNTHETIC-NEVER-IN-PROMPT');
 const result=await variablesTool(ctx).execute({action:'get',id:ref.slice(9,-2)},{} as never);expect(JSON.stringify(result)).toContain(ref);expect(JSON.stringify(result)).not.toContain('SYNTHETIC-NEVER-IN-PROMPT');
 expect((await savedValues(ctx)).find(v=>v.id===id)!.lastUsedAt).toBeTruthy();
 const execution=await executionSecrets(ctx,'c');expect(execution.resolve(ref)).toBe('SYNTHETIC-NEVER-IN-PROMPT');
});
it('resolves public suffix base domains, discovers icons, falls back, caches and bounds responses',async()=>{
 expect(connectorDomain('https://mcp.exa.ai/mcp')).toBe('exa.ai');expect(connectorDomain('https://api.example.co.uk')).toBe('example.co.uk');expect(()=>connectorDomain('http://127.0.0.1')).toThrow();
 const {service}=createPraxisApp({adapters:createLocalAdapters(),local:true}),ctx=featureContext(service,'u');await ctx.store.put('u','connector','c',{url:'https://mcp.exa.ai'});
 const urls:string[]=[];const fake:typeof fetch=async input=>{urls.push(String(input));return String(input)==='https://exa.ai'?new Response('<link rel="apple-touch-icon" href="/touch.png">'):new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});};
 expect((await connectorIcon(ctx,'c',fake))?.mediaType).toBe('image/png');await connectorIcon(ctx,'c',fake);expect(urls).toEqual(['https://exa.ai','https://exa.ai/touch.png']);
 await ctx.store.delete('u','connectorIcon','exa.ai');
 expect(await connectorIcon(ctx,'c',async()=>new Response('x'.repeat(256001),{headers:{'content-type':'image/png'}}))).toBeNull();
});
it('acks all question actions with the form resolved while continuation is still blocked',async()=>{
 for(const action of ['accept','decline','cancel'] as const){
  const {service}=createPraxisApp({adapters:createLocalAdapters(),local:true});await service.seed('u');
  let release!:()=>void;const blocked=new Promise<void>(r=>release=r);
  service.driver={async start(u,r){await service.emit(u,r.id,{type:'elicitation.requested',elicitation:{type:'elicitation',id:'e',message:'Name?',schema:{type:'object'}}});},async resume(){await blocked;}};
  const run=await service.start('u',{type:'run.start',chatId:'welcome',text:'q',attachmentIds:[],webSearch:false});await service.drain();
  try{await service.decision('u',run.id,{type:'elicitation.response',elicitationId:'e',action});expect((await service.require<any>('u','snapshot',run.id)).pendingElicitations).toEqual([]);}finally{release();await service.drain();}
 }
});
