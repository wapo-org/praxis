import {ProviderFailure,type ModelProvider,type ProviderRequest} from '@praxis/agent';
import type {Model,JsonObject,ProviderProbeErrorSchema} from '@praxis/protocol';
import type {z} from 'zod';
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
/** Independent requests keep an image rejection from being mistaken for a tool rejection. */
export async function probeProvider(provider:ModelProvider,model:Model){
 const base:ProviderRequest={model:model.id,system:'You are running a connection test.',messages:[{type:'message',id:'probe',chatId:'probe',role:'user',parts:[{type:'text',text:'Reply with ok.'}],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}],tools:[],capabilities:{...model.capabilities,tools:true},maxTokens:128,webSearch:false};
 const learning:JsonObject={};const probe={tools:false,vision:false,streaming:false,reasoningEfforts:[] as string[]};
 const signal=AbortSignal.timeout(30000);
 async function send(request:ProviderRequest){let completed=false,tool=false;for await(const event of provider.stream(request,signal)){if(event.type==='tool'&&event.name==='probe_echo')tool=true;if(event.type==='completed'){completed=true;tool||=event.response.parts.some(p=>p.type==='toolCall'&&p.name==='probe_echo');}}if(!completed)throw new Error('Incomplete probe stream');return tool;}
 await send(base);probe.streaming=true;
 try{probe.tools=await send({...base,messages:[{...base.messages[0]!,parts:[{type:'text',text:'Call probe_echo with value ping. Do not reply with text.'}]}],tools:[{type:'tool.spec',name:'probe_echo',description:'Echoes a value.',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},source:{type:'builtin'},traits:['readOnly']}]});}
 catch(e){if(e instanceof ProviderFailure&&e.kind==='tools')learning.tools=Date.now();else throw e;}
 if(model.capabilities.vision)try{await send({...base,messages:[{...base.messages[0]!,parts:[{type:'text',text:'Describe this pixel.'},{type:'image',data:pixel,mediaType:'image/png'}]}]});probe.vision=true;}catch(e){if(e instanceof ProviderFailure&&e.kind==='images')learning.images=Date.now();else throw e;}
 if(model.capabilities.reasoningEffort){
  let rejected=false;
  for(const effort of model.reasoningEfforts.slice(0,7))try{await send({...base,effort,supportedEfforts:model.reasoningEfforts});probe.reasoningEfforts.push(effort);}catch(e){if(e instanceof ProviderFailure&&e.kind==='effort')rejected=true;else throw e;}
  if(rejected)learning.efforts={levels:probe.reasoningEfforts,at:Date.now()};
 }
 return {probe,learning};
}
export type ProbeError=z.infer<typeof ProviderProbeErrorSchema>;
/** A failed probe as a typed error; provider text is kept (it explains the failure) with any credential redacted. */
export function probeError(error:unknown,secrets:string[]):ProbeError{
 const redact=(text:string)=>secrets.filter(s=>s.length>=4).reduce((t,s)=>t.split(s).join('[redacted]'),text).replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,500);
 if(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError'))return {code:'timeout',message:'The provider did not answer within 30 seconds'};
 if(error instanceof ProviderFailure)return {code:error.kind==='retryable'?'provider_unavailable':'provider_error',message:redact(error.message)||'The provider rejected the request'};
 return {code:'unreachable',message:'Could not reach the provider'};
}
