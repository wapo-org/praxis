import {it,expect,vi} from 'vitest';
import {CapabilitiesSchema,ModelSchema,ProviderSchema} from '@praxis/protocol';
import {createHTTPProvider} from '@praxis/agent';
import {probeProvider} from './provider-probe.js';
import {ApiProviders} from './providers.js';
import {ApiService} from './service.js';
import {createLocalAdapters} from './local-memory.js';
const capabilities=CapabilitiesSchema.parse({vision:true,reasoningEffort:true});
const model=ModelSchema.parse({type:'model',id:'m',providerId:'p',displayName:'M',capabilities,reasoningEfforts:['low','high'],pinned:false,favorite:false});
function wire(reject=false){return vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{const b=JSON.parse(String(init?.body));if(reject){if(b.tools)return Response.json({error:{message:'tools are not supported'}},{status:400});if(b.messages.some((m:{content:unknown})=>Array.isArray(m.content)))return Response.json({error:{message:'image inputs are not supported'}},{status:400});if(b.reasoning_effort==='high')return Response.json({error:{message:'reasoning_effort high is unsupported'}},{status:400});}
 const tool=!!b.tools;return new Response(`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'c',function:{name:'probe_echo',arguments:'{"value":"ping"}'}}]}:{content:'ok'}}]})}\n\ndata: ${JSON.stringify({choices:[{finish_reason:tool?'tool_calls':'stop',delta:{}}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});});}
it('probes actual streaming, tool calls, image acceptance and reasoning effort levels',async()=>{const fetcher=wire();const p=createHTTPProvider({baseUrl:'https://example.com',flavor:'openAIChat',capabilities},fetcher);const {probe,learning}=await probeProvider(p,model);expect(probe).toEqual({tools:true,vision:true,streaming:true,reasoningEfforts:['low','high']});expect(learning).toEqual({});expect(fetcher).toHaveBeenCalledTimes(5);});
it('seeds learned rejections and clears stale rejections after a successful explicit probe',async()=>{
 const service=new ApiService(createLocalAdapters(),true);await service.adapters.store.put('u','provider','p',ProviderSchema.parse({type:'provider',id:'p',name:'P',baseUrl:'https://example.com',flavor:'openAIChat',maskedKey:'',capabilities,updatedAt:new Date().toISOString()}));await service.adapters.store.put('u','model','p:m',model);
 const p=new ApiProviders(service,undefined,wire(true));const r=await p.probe('u','p','m');expect(r.probe).toEqual({tools:false,vision:false,streaming:true,reasoningEfforts:['low']});const learned=await service.adapters.store.get('u','modelLearning','p:m');expect(learned?.value).toMatchObject({tools:expect.any(Number),images:expect.any(Number),efforts:{levels:['low']}});
 await new ApiProviders(service,undefined,wire()).probe('u','p','m');expect((await service.adapters.store.get('u','modelLearning','p:m'))?.value).toMatchObject({efforts:{levels:['low','high']}});expect((await service.adapters.store.get('u','modelLearning','p:m'))?.value.tools).toBeUndefined();
});
it('does not learn capability failures from auth errors or incomplete streams',async()=>{for(const response of [Response.json({error:{message:'bad key'}},{status:401}),new Response('data: [DONE]\n\n')]){const p=createHTTPProvider({baseUrl:'https://example.com',flavor:'openAIChat',capabilities},async()=>response);await expect(probeProvider(p,model)).rejects.toThrow();}});
