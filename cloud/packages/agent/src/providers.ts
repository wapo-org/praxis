import { z } from 'zod';
import {CapabilitiesSchema,IdSchema,JsonObjectSchema,ModelSchema,ProviderFlavorSchema,type Capabilities,type JsonObject,type Model} from '@praxis/protocol';
import type {ModelProvider,ProviderRequest,ProviderEvent} from './types.js';
import {ProviderFailure} from './runner.js';
import {buildProviderRequest,array,number,object,string,type RequestOptions} from './wire.js';
import {classifyProviderError,decodeAnthropic,decodeOpenAIChat,decodeOpenAIResponses,parseSSE} from './streams.js';

export const HTTPProviderConfigSchema=z.object({
  flavor:ProviderFlavorSchema,baseUrl:z.url(),apiKey:z.string().default(''),providerId:IdSchema.default('provider'),
  capabilities:CapabilitiesSchema.default(CapabilitiesSchema.parse({})),
  extraHeaders:z.record(z.string(),z.string()).default({}),
  systemRole:z.enum(['system','developer']).optional(),maxTokensField:z.enum(['max_tokens','max_completion_tokens','omit']).optional(),
  replayReasoning:z.boolean().optional(),webSearchToolType:z.string().optional(),
  maxStreamBytes:z.number().int().positive().max(64_000_000).default(16_000_000),
  maxEventBytes:z.number().int().positive().max(16_000_000).default(1_000_000),
});
export type HTTPProviderConfig=z.input<typeof HTTPProviderConfigSchema>;
export interface HTTPProvider extends ModelProvider {listModels(signal?:AbortSignal):Promise<Model[]>}
/** baseUrl is endpoint root (including a custom prefix), or a full known generation URL. */
export function providerURL(baseUrl:string,path:string):URL {
  const url=new URL(baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Provider URL must be HTTP(S) without embedded credentials');
  url.hash='';url.search='';url.pathname=url.pathname.replace(/\/+$/,'').replace(/\/(chat\/completions|messages|responses|models)$/,'');
  if(!url.pathname)url.pathname='/v1';url.pathname+=`/${path}`;return url;
}
async function readBounded(response:Response,max=4_000_000):Promise<string> {
  if(!response.body)return '';const reader=response.body.getReader(),decoder=new TextDecoder();let total=0,text='';
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max)throw new ProviderFailure('Provider body exceeds buffer limit');text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createHTTPProvider(config:HTTPProviderConfig,fetcher:typeof fetch=fetch):HTTPProvider {
  const c=HTTPProviderConfigSchema.parse(config);providerURL(c.baseUrl,'models');
  const redact=(text:string)=>{
    for(const secret of [c.apiKey,...Object.entries(c.extraHeaders).filter(([key])=>/authorization|key|token/i.test(key)).map(([,v])=>v)])if(secret)text=text.split(secret).join('[redacted]');
    return text.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').slice(0,4000);
  };
  const headers=()=>{
    const result=new Headers(c.extraHeaders);result.set('content-type','application/json');result.set('accept','text/event-stream');
    if(c.flavor==='anthropicMessages'){if(c.apiKey)result.set('x-api-key',c.apiKey);if(!result.has('anthropic-version'))result.set('anthropic-version','2023-06-01');}
    else if(c.apiKey)result.set('authorization',`Bearer ${c.apiKey}`);return result;
  };
  async function request(url:URL,init:RequestInit):Promise<Response> {
    let response:Response;
    try{response=await fetcher(url,{...init,redirect:'error'});}catch(error){if(init.signal?.aborted)throw error;throw new ProviderFailure('Provider network request failed','retryable');}
    if(!response.ok) {
      const text=await readBounded(response,64_000),json=(()=>{try{return object(JSON.parse(text));}catch{return {};}})(),error=object(json.error);
      const message=redact(string(error.message)||string(json.message)||text||`Provider HTTP ${response.status}`);
      const retry=response.headers.get('retry-after');const delay=retry?Math.max(0,Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now()):undefined;
      throw classifyProviderError(message,response.status,delay&&Number.isFinite(delay)?delay:undefined);
    }
    return response;
  }
  return {
    flavor:c.flavor,capabilities:c.capabilities,
    async *stream(input:ProviderRequest,signal:AbortSignal):AsyncGenerator<ProviderEvent> {
      const body=buildProviderRequest(c.flavor,input,c as RequestOptions),path=c.flavor==='anthropicMessages'?'messages':c.flavor==='openAIChat'?'chat/completions':'responses';
      const response=await request(providerURL(c.baseUrl,path),{method:'POST',headers:headers(),body:JSON.stringify(body),signal});
      if(!response.body)throw new ProviderFailure('Provider returned an empty stream','retryable');
      const frames=parseSSE(response.body,signal,{maxBytes:c.maxStreamBytes,maxEventBytes:c.maxEventBytes});
      try{
        const decoded=c.flavor==='anthropicMessages'?decodeAnthropic(frames):c.flavor==='openAIChat'?decodeOpenAIChat(frames):decodeOpenAIResponses(frames);
        yield* decoded;
      }catch(error){
        if(error instanceof ProviderFailure)throw new ProviderFailure(redact(error.message),error.kind,error.retryAfterMs);
        if(signal.aborted)throw error;throw new ProviderFailure('Provider sent malformed stream data');
      }
    },
    async listModels(signal=AbortSignal.timeout(30000)):Promise<Model[]> {
      let cursor:string|undefined;const seen=new Set<string>(),models=new Map<string,Model>();
      for(let page=0;page<100;page++) {
        const url=providerURL(c.baseUrl,'models');if(c.flavor==='anthropicMessages'){url.searchParams.set('limit','100');if(cursor)url.searchParams.set('after_id',cursor);}
        const h=headers();h.set('accept','application/json');const response=await request(url,{method:'GET',headers:h,signal});
        const json=JsonObjectSchema.parse(JSON.parse(await readBounded(response)));
        for(const raw of array(json.data)) {const model=parseModelMetadata(raw,c.providerId,c.capabilities);models.set(model.id,model);if(models.size>20000)throw new ProviderFailure('Provider model list exceeds limit');}
        if(c.flavor!=='anthropicMessages'||json.has_more!==true)break;
        cursor=string(json.last_id)||string(object(array(json.data).at(-1)).id);if(!cursor||seen.has(cursor))throw new ProviderFailure('Provider model pagination did not advance');seen.add(cursor);
      }
      return [...models.values()];
    },
  };
}
export function parseModelMetadata(raw:unknown,providerId:string,defaults:Capabilities):Model {
  const m=JsonObjectSchema.parse(raw),caps=object(m.capabilities),architecture=object(m.architecture),reasoning=object(m.reasoning),params=array(m.supported_parameters).map(string),nativeReasoning=object(caps.reasoning);
  const inputModalities=array(architecture.input_modalities).map(string),capList=array(m.capabilities).map(string);
  const supported=(value:unknown)=>typeof value==='boolean'?value:typeof object(value).supported==='boolean'?object(value).supported as boolean:undefined;
  const images=supported(caps.image_input)??supported(caps.vision)??(inputModalities.length?inputModalities.includes('image'):undefined)??(capList.length?capList.includes('vision'):undefined);
  const tools=supported(caps.tool_use)??supported(caps.tools)??supported(caps.trained_for_tool_use)??(capList.length?capList.includes('tools'):undefined)??(params.length?params.includes('tools'):undefined);
  let efforts:string[]|undefined;
  const effort=object(caps.effort);
  if(reasoning.supported_efforts===null)efforts=['none','minimal','low','medium','high','xhigh','max'];
  else if(Array.isArray(reasoning.supported_efforts))efforts=reasoning.supported_efforts.map(string).filter(Boolean);
  else if(Array.isArray(nativeReasoning.allowed_options))efforts=nativeReasoning.allowed_options.map(string).filter(Boolean);
  else if(effort.supported===false||nativeReasoning.supported===false)efforts=[];
  else if(effort.supported===true) {
    efforts=['low','medium','high','xhigh','max'].filter(e=>effort[e]===true||object(effort[e]).supported===true);
    if(!efforts.length)efforts=['low','medium','high'];
  }else if(nativeReasoning.supported===true||supported(caps.thinking)===true||params.includes('reasoning')||params.includes('reasoning_effort')||capList.includes('thinking'))efforts=['low','medium','high'];
  else if(params.length||capList.length)efforts=[];
  const capabilities=CapabilitiesSchema.parse({...defaults,...(images!==undefined?{vision:images}:{}),...(tools!==undefined?{tools}:{}),...(efforts!==undefined?{reasoningEffort:efforts.length>0}:{})});
  const context=number(m.context_window)||number(m.max_input_tokens)||number(m.context_length)||number(object(m.top_provider).context_length),maxOutput=number(m.max_output_tokens)||number(m.max_tokens)||number(object(m.top_provider).max_completion_tokens);
  return ModelSchema.parse({type:'model',id:m.id??m.key??m.name,providerId,displayName:string(m.display_name)||string(m.name)||string(m.id)||string(m.key),capabilities,reasoningEfforts:efforts??(capabilities.reasoningEffort?['low','medium','high']:[]),pinned:false,favorite:false,...(context>0?{contextWindow:context}:{}),...(maxOutput>0?{maxOutputTokens:maxOutput}:{})});
}
