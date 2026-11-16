import {JsonObjectSchema,UsageSchema,CapabilitiesSchema,type Capabilities} from '@praxis/protocol';
import type {SealedSecret} from '@praxis/types';
import type {ModelProvider,ProviderRequest,ProviderEvent} from './types.js';
import {ProviderFailure} from './runner.js';
import {buildProviderRequest,object} from './wire.js';
import {classifyProviderError,decodeOpenAIChat,errorMessage,parseSSE} from './streams.js';

/** The only model endpoint. A constant: never taken from user input or stored configuration. */
export const OPENROUTER_API_BASE='https://openrouter.ai/api/v1';
/** Where a user starts the PKCE connect flow. */
export const OPENROUTER_AUTH_URL='https://openrouter.ai/auth';

export interface OpenRouterConfig {
  /** The user's own key, unsealed for this run only. */
  apiKey:SealedSecret;
  /** From the model's catalogue entry. */
  capabilities:Capabilities;
  maxStreamBytes?:number;maxEventBytes?:number;
}

export async function readBounded(response:Response,max=4_000_000):Promise<string> {
  if(!response.body)return '';const reader=response.body.getReader(),decoder=new TextDecoder();let total=0,text='';
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max)throw new ProviderFailure('Provider body exceeds buffer limit');text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Removes the key (and any bearer token) from text that may reach a client, a log or a trace. */
export function redactKey(text:string,apiKey?:SealedSecret):string {
  const key=apiKey?.reveal();
  if(key)text=text.split(key).join('[redacted]');
  return text.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/sk-or-[A-Za-z0-9_-]{8,}/g,'[redacted]').slice(0,4000);
}

/** OpenRouter chat completions with the user's key. `fetcher` is the guarded fetch in production. */
export function createOpenRouterProvider(config:OpenRouterConfig,fetcher:typeof fetch=fetch):ModelProvider {
  const capabilities=CapabilitiesSchema.parse(config.capabilities);
  const limits={maxBytes:config.maxStreamBytes??16_000_000,maxEventBytes:config.maxEventBytes??1_000_000};
  const redact=(text:string)=>redactKey(text,config.apiKey);
  return {
    capabilities,
    async complete(input, signal) {
      const body = {...buildProviderRequest(input), stream: false};
      const response = await fetcher(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${config.apiKey.reveal()}`},
        body: JSON.stringify(body), signal, redirect: 'error',
      });
      const json = JsonObjectSchema.parse(JSON.parse(await readBounded(response)));
      if (!response.ok) throw classifyProviderError(redact(errorMessage(object(json.error), `OpenRouter HTTP ${response.status}`)), response.status);
      const choices = json.choices;
      const message = object(Array.isArray(choices) ? object(choices[0]).message : undefined);
      const content = typeof message.content === 'string' ? message.content : '';
      const usage = object(json.usage);
      return {parts: [{type: 'text', text: content}], stop: 'endTurn', usage: UsageSchema.parse({
        inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0,
      })};
    },
    async *stream(input:ProviderRequest,signal:AbortSignal):AsyncGenerator<ProviderEvent> {
      if(!config.apiKey.reveal())throw new ProviderFailure('No OpenRouter key is connected','keyInvalid');
      const headers={'content-type':'application/json',accept:'text/event-stream',authorization:`Bearer ${config.apiKey.reveal()}`,'x-title':'Praxis'};
      let response:Response;
      try{response=await fetcher(`${OPENROUTER_API_BASE}/chat/completions`,{method:'POST',headers,body:JSON.stringify(buildProviderRequest(input)),signal,redirect:'error'});}
      catch(error){if(signal.aborted)throw error;throw new ProviderFailure('OpenRouter could not be reached','retryable');}
      if(!response.ok) {
        const text=await readBounded(response,64_000),json=(()=>{try{return object(JSON.parse(text));}catch{return {};}})();
        const message=redact(errorMessage(object(json.error),text||`OpenRouter HTTP ${response.status}`));
        const retry=response.headers.get('retry-after');const delay=retry?Math.max(0,Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now()):undefined;
        throw classifyProviderError(message,response.status,delay&&Number.isFinite(delay)?delay:undefined);
      }
      if(!response.body)throw new ProviderFailure('OpenRouter returned an empty stream','retryable');
      try{yield* decodeOpenAIChat(parseSSE(response.body,signal,limits));}
      catch(error){
        if(error instanceof ProviderFailure)throw new ProviderFailure(redact(error.message),error.kind,error.retryAfterMs);
        if(signal.aborted)throw error;throw new ProviderFailure('OpenRouter sent malformed stream data');
      }
    },
  };
}
