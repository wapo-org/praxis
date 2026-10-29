import {JsonObjectSchema,type JsonObject,type MessagePart,type ProviderFlavor,type Usage} from '@praxis/protocol';
import {ProviderFailure} from './runner.js';
import {type ProviderEvent,type ProviderResponse} from './types.js';
import {array,number,object,string} from './wire.js';

export interface SSEFrame {event:string;data:string}
/** Incremental UTF-8 and CR/LF/CRLF framing; total, line, and event buffers are bounded. */
export async function* parseSSE(body:ReadableStream<Uint8Array>,signal?:AbortSignal,limits={maxBytes:16_000_000,maxEventBytes:1_000_000}):AsyncGenerator<SSEFrame> {
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='',data:string[]=[],event='',total=0,size=0;
  function line(value:string):SSEFrame|undefined {
    if(value===''){if(!data.length){event='';return;}const frame={event,data:data.join('\n')};event='';data=[];size=0;return frame;}
    if(value.startsWith(':'))return;
    const colon=value.indexOf(':'),field=colon<0?value:value.slice(0,colon);let val=colon<0?'':value.slice(colon+1);if(val.startsWith(' '))val=val.slice(1);
    if(field==='event')event=val;
    if(field==='data'){size+=val.length;if(size>limits.maxEventBytes)throw new ProviderFailure('SSE event exceeds buffer limit');data.push(val);}
  }
  try {
    while(true) {
      if(signal?.aborted)throw signal.reason??new Error('Aborted');
      const {done,value}=await reader.read();if(value){total+=value.byteLength;if(total>limits.maxBytes)throw new ProviderFailure('SSE stream exceeds buffer limit');buffer+=decoder.decode(value,{stream:true});}
      if(done)buffer+=decoder.decode();
      while(true){const match=/[\r\n]/.exec(buffer);if(!match)break;const i=match.index;if(buffer[i]==='\r'&&i===buffer.length-1&&!done)break;
        const width=buffer[i]==='\r'&&buffer[i+1]==='\n'?2:1,frame=line(buffer.slice(0,i));buffer=buffer.slice(i+width);if(frame)yield frame;
      }
      if(buffer.length>limits.maxEventBytes)throw new ProviderFailure('SSE line exceeds buffer limit');
      if(done){if(buffer){const frame=line(buffer);if(frame)yield frame;}const frame=line('');if(frame)yield frame;break;}
    }
  }finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
const zero=():Usage=>({type:'usage',inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0});
export function classifyProviderError(message:string,status=400,retryAfterMs?:number):ProviderFailure {
  const lower=message.toLowerCase();
  const kind=/(image|vision|multimodal).*(not support|unsupported|not allowed|does not|cannot)|not support.*image/.test(lower)?'images':
    /(?:tool|function)[ _-]?(?:use|call|calling|s)?.*(not support|unsupported|not allowed)|(?:not support|unsupported).*tool/.test(lower)?'tools':
    /(?:reasoning_effort|reasoning effort|output_config.*effort|thinking|effort).*(invalid|unsupported|not support|not allowed|must be|should be)|(?:invalid|unsupported).*effort/.test(lower)?'effort':
    /context[_ ]?(length|window)|prompt.{0,8}too long|too many (input )?tokens|maximum context|request_too_large/.test(lower)||status===413?'context':
    [408,409,429].includes(status)||status>=500?'retryable':'fatal';
  return new ProviderFailure(message,kind,retryAfterMs);
}
function streamError(json:JsonObject):void {
  if(json.error||json.type==='error') {
    const error=object(json.error),message=string(error.message)||string(json.message)||'Provider stream error';
    const kind=string(error.type)||string(json.code);
    throw classifyProviderError(message,/overload|api_error|rate_limit|server_error|timeout/.test(kind)?500:400);
  }
}
function stop(reason:string,hasTools=false):ProviderResponse['stop'] {
  if(['max_tokens','length','max_output_tokens'].includes(reason))return 'maxTokens';
  if(['refusal','content_filter'].includes(reason))return 'refusal';
  if(reason==='context_window_exceeded')return 'contextWindowExceeded';
  if(reason==='pause_turn')return 'pauseTurn';
  return hasTools?'toolUse':'endTurn';
}
function usage(raw:unknown,flavor:ProviderFlavor):Usage {
  const u=object(raw),cached=number(object(u.prompt_tokens_details).cached_tokens)||number(object(u.input_tokens_details).cached_tokens)||number(u.cache_read_input_tokens)||number(u.prompt_cache_hit_tokens);
  const input=number(u.input_tokens)||number(u.prompt_tokens),output=number(u.output_tokens)||number(u.completion_tokens);
  return {type:'usage',inputTokens:flavor==='anthropicMessages'?input:Math.max(0,input-cached),outputTokens:output,cacheReadTokens:cached,cacheWriteTokens:number(u.cache_creation_input_tokens)};
}
export async function* decodeAnthropic(frames:AsyncIterable<SSEFrame>):AsyncGenerator<ProviderEvent> {
  const blocks=new Map<number,JsonObject>(),args=new Map<number,string>();let raw:JsonObject={},u=zero(),reason='',done=false;
  for await(const frame of frames) {
    if(!frame.data||frame.data==='[DONE]')continue;const e=JsonObjectSchema.parse(JSON.parse(frame.data));streamError(e);
    const type=string(e.type)||frame.event,index=number(e.index);
    if(type==='message_start'){raw=object(e.message);u=usage(raw.usage,'anthropicMessages');}
    else if(type==='content_block_start') {
      const block=structuredClone(object(e.content_block));blocks.set(index,block);
      if(block.type==='tool_use')yield {type:'tool',index,id:string(block.id),name:string(block.name)};
      else if(block.type==='text'&&block.text)yield {type:'text',index,text:string(block.text)};
      else if(block.type==='thinking'&&block.thinking)yield {type:'reasoning',index,text:string(block.thinking)};
    }else if(type==='content_block_delta') {
      const block=blocks.get(index);if(!block)throw new ProviderFailure('Delta references missing content block');const delta=object(e.delta);
      if(delta.type==='text_delta'){const t=string(delta.text);block.text=string(block.text)+t;yield {type:'text',index,text:t};}
      else if(delta.type==='thinking_delta'){const t=string(delta.thinking);block.thinking=string(block.thinking)+t;yield {type:'reasoning',index,text:t};}
      else if(delta.type==='signature_delta')block.signature=string(block.signature)+string(delta.signature);
      else if(delta.type==='input_json_delta') {
        const json=string(delta.partial_json);args.set(index,(args.get(index)??'')+json);
        if(block.type==='tool_use')yield {type:'arguments',index,json};
      }
    }else if(type==='content_block_stop') {
      const block=blocks.get(index),json=args.get(index);if(block&&json){try{block.input=JSON.parse(json);}catch{block.input={};}}
      yield {type:'blockEnd',index};
    }else if(type==='message_delta') {
      reason=string(object(e.delta).stop_reason)||reason;
      const updated=object(e.usage);u={...u,...(typeof updated.output_tokens==='number'?{outputTokens:updated.output_tokens}:{}),...(typeof updated.input_tokens==='number'?{inputTokens:updated.input_tokens}:{})};
    }else if(type==='message_stop'){done=true;break;}
  }
  if(!done)throw new ProviderFailure('Anthropic stream ended before message_stop','retryable');
  const parts:MessagePart[]=[];
  for(const [index,b] of [...blocks].sort(([a],[b])=>a-b)) {
    if(b.type==='text')parts.push({type:'text',text:string(b.text)});
    else if(b.type==='thinking')parts.push({type:'reasoning',text:string(b.thinking),signature:string(b.signature)});
    else if(b.type==='tool_use')parts.push({type:'toolCall',callId:string(b.id),name:string(b.name),arguments:args.get(index)||JSON.stringify(b.input??{})});
  }
  raw={...raw,content:[...blocks].sort(([a],[b])=>a-b).map(([,b])=>b),stop_reason:reason,usage:{input_tokens:u.inputTokens,output_tokens:u.outputTokens,cache_read_input_tokens:u.cacheReadTokens,cache_creation_input_tokens:u.cacheWriteTokens}};
  yield {type:'completed',response:{parts,stop:stop(reason,parts.some(p=>p.type==='toolCall')),usage:u,raw:{type:'provider.payload',flavor:'anthropicMessages',data:raw}}};
}
interface Slot {id:string;name:string;args:string;started:boolean}
export async function* decodeOpenAIChat(frames:AsyncIterable<SSEFrame>):AsyncGenerator<ProviderEvent> {
  let text='',reasoning='',reasoningField='reasoning_content',reason='',done=false,u=zero(),refusal='';
  const slots:Slot[]=[],slotForIndex=new Map<number,number>();
  for await(const frame of frames) {
    if(frame.data==='[DONE]'){done=true;break;}if(!frame.data)continue;
    const e=JsonObjectSchema.parse(JSON.parse(frame.data));streamError(e);if(e.usage)u=usage(e.usage,'openAIChat');
    const choice=object(array(e.choices)[0]),delta=object(choice.delta);if(choice.finish_reason){reason=string(choice.finish_reason);if(reason==='error')throw new ProviderFailure('Provider stopped with an error','retryable');}
    for(const field of ['reasoning_content','reasoning'])if(typeof delta[field]==='string'){const t=string(delta[field]);reasoning+=t;reasoningField=field;yield {type:'reasoning',index:0,text:t};break;}
    if(typeof delta.content==='string'){const t=delta.content;text+=t;yield {type:'text',index:1,text:t};}
    refusal+=string(delta.refusal);
    for(const fragment of array(delta.tool_calls)) {
      const f=object(fragment),fn=object(f.function),id=string(f.id),name=string(fn.name);let slot:number|undefined;
      if(typeof f.index==='number') {
        slot=slotForIndex.get(f.index);
        if(slot!==undefined&&id&&slots[slot]!.id&&slots[slot]!.id!==id)slot=slots.findIndex(s=>s.id===id);
        if(slot===undefined||slot<0){slot=slots.length;slots.push({id:'',name:'',args:'',started:false});}slotForIndex.set(f.index,slot);
      }else{
        const last=slots.at(-1);if(last&&(!id||last.id===id)&&(!name||!last.name))slot=slots.length-1;
        else {slot=slots.length;slots.push({id:'',name:'',args:'',started:false});}
      }
      const s=slots[slot]!;if(!s.started&&id)s.id=id;if(name&&!s.name)s.name=name;
      const json=typeof fn.arguments==='string'?fn.arguments:fn.arguments?JSON.stringify(fn.arguments):'';s.args+=json;
      if(!s.started&&s.name){s.started=true;s.id||=`call_${crypto.randomUUID()}`;yield {type:'tool',index:slot+2,id:s.id,name:s.name};if(s.args)yield {type:'arguments',index:slot+2,json:s.args};}
      else if(s.started&&json)yield {type:'arguments',index:slot+2,json};
    }
  }
  if(!done&&!reason)throw new ProviderFailure('Chat stream ended before completion','retryable');
  const calls=slots.filter(s=>s.started);if(!calls.length&&!text&&!reasoning&&/tool_calls|function_call/.test(reason))throw new ProviderFailure('Provider promised tools without naming one');
  const parts:MessagePart[]=[];if(reasoning){parts.push({type:'reasoning',text:reasoning});yield {type:'blockEnd',index:0};}if(text){parts.push({type:'text',text});yield {type:'blockEnd',index:1};}
  parts.push(...calls.map(s=>({type:'toolCall' as const,callId:s.id,name:s.name,arguments:s.args||'{}'})));
  const raw:JsonObject={role:'assistant',content:text||null};if(reasoning)raw[reasoningField]=reasoning;
  if(calls.length)raw.tool_calls=calls.map(s=>({id:s.id,type:'function',function:{name:s.name,arguments:s.args||'{}'}}));
  yield {type:'completed',response:{parts,stop:refusal?'refusal':stop(reason,!!calls.length),usage:u,raw:{type:'provider.payload',flavor:'openAIChat',data:raw}}};
}
export async function* decodeOpenAIResponses(frames:AsyncIterable<SSEFrame>):AsyncGenerator<ProviderEvent> {
  const items=new Map<number,JsonObject>(),doneItems=new Map<number,JsonObject>(),indices=new Map<string,number>();let nextIndex=0,response:JsonObject|undefined;
  const blockIndex=(key:string)=>{if(!indices.has(key))indices.set(key,nextIndex++);return indices.get(key)!;};
  for await(const frame of frames) {
    if(!frame.data||frame.data==='[DONE]')continue;const e=JsonObjectSchema.parse(JSON.parse(frame.data));streamError(e);
    const type=string(e.type)||frame.event,output=number(e.output_index),content=number(e.content_index);
    if(type==='response.output_item.added') {
      const item=structuredClone(object(e.item));items.set(output,item);
      if(item.type==='function_call')yield {type:'tool',index:blockIndex(`tool.${output}`),id:string(item.call_id)||string(item.id),name:string(item.name)};
    }else if(type==='response.output_item.done'){const item=structuredClone(object(e.item));items.set(output,item);doneItems.set(output,item);}
    else if(type==='response.output_text.delta')yield {type:'text',index:blockIndex(`text.${output}.${content}`),text:string(e.delta)};
    else if(type==='response.reasoning_summary_text.delta'||type==='response.reasoning_text.delta')yield {type:'reasoning',index:blockIndex(`reasoning.${output}.${number(e.summary_index)}`),text:string(e.delta)};
    else if(type==='response.function_call_arguments.delta') {
      const item=items.get(output);if(item)item.arguments=string(item.arguments)+string(e.delta);
      yield {type:'arguments',index:blockIndex(`tool.${output}`),json:string(e.delta)};
    }else if(/response\.(output_text|reasoning_summary_text|reasoning_text)\.done/.test(type))yield {type:'blockEnd',index:blockIndex(type.includes('reasoning')?`reasoning.${output}.${number(e.summary_index)}`:`text.${output}.${content}`)};
    else if(type==='response.completed'||type==='response.incomplete'){response=object(e.response);break;}
    else if(type==='response.failed') {
      const error=object(object(e.response).error);throw classifyProviderError(string(error.message)||'Response failed',/server|rate|timeout/.test(string(error.code))?500:400);
    }
  }
  if(!response)throw new ProviderFailure('Responses stream ended before completion','retryable');
  const outputs=array(response.output).length?array(response.output):[...items].sort(([a],[b])=>a-b).map(([,b])=>b);
  // Prefer completed item snapshots for encrypted reasoning; added snapshots may be partial.
  const completed=outputs.map((item,i)=>doneItems.get(i)??object(item));
  const parts:MessagePart[]=[];let refused=false;
  for(const b of completed) {
    if(b.type==='function_call')parts.push({type:'toolCall',callId:string(b.call_id)||string(b.id),name:string(b.name),arguments:string(b.arguments)||'{}'});
    else if(b.type==='message')for(const raw of array(b.content)){const p=object(raw);if(p.type==='output_text')parts.push({type:'text',text:string(p.text)});if(p.type==='refusal')refused=true;}
    else if(b.type==='reasoning')parts.push({type:'reasoning',text:array(b.summary).map(s=>string(object(s).text)).join('\n')});
  }
  yield {type:'completed',response:{parts,stop:refused?'refusal':stop(string(object(response.incomplete_details).reason),parts.some(p=>p.type==='toolCall')),usage:usage(response.usage,'openAIResponses'),raw:{type:'provider.payload',flavor:'openAIResponses',data:completed}}};
}
