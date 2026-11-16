import {JsonObjectSchema,type JsonObject,type MessagePart,type Usage,type ReasoningShape,type StreamAnnotation} from '@praxis/protocol';
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
/** 401 = the user's key is rejected; 402 = their credit is spent. Neither is retried or degraded. */
export function classifyProviderError(message:string,status=400,retryAfterMs?:number):ProviderFailure {
  if(status===401)return new ProviderFailure(message,'keyInvalid',undefined,status);
  if(status===402)return new ProviderFailure(message,'creditExhausted',undefined,status);
  const lower=message.toLowerCase();
  const rejection=/not support|does not support|unsupported|not allowed|unrecognized|unknown parameter|invalid/;
  const kind=/(?:image|vision|multimodal)/.test(lower)&&rejection.test(lower)?'images':
    /no endpoints found that support tool use/.test(lower)||/(?:tools?|tool_choice|function calling)/.test(lower)&&rejection.test(lower)?'tools':
    /(?:reasoning_effort|reasoning effort|reasoning\.effort)/.test(lower)&&(rejection.test(lower)||/must be|should be/.test(lower))?'effort':
    /context[_ ]?(length|window)|prompt.{0,8}too long|too many (input )?tokens|maximum context|request_too_large/.test(lower)||status===413?'context':
    [408,409,429].includes(status)||status>=500?'retryable':'fatal';
  return new ProviderFailure(message,kind,retryAfterMs,status);
}
/** OpenRouter's error text, with the upstream provider's own message when it adds one. */
export function errorMessage(error:JsonObject,fallback:string):string {
  const message=string(error.message)||fallback,upstream=object(error.metadata).raw;
  return typeof upstream==='string'&&upstream&&!message.includes(upstream)?`${message}: ${upstream.slice(0,1000)}`:message;
}
/** Mid-stream errors arrive as a chunk with a top-level `error` whose `code` is the HTTP status. */
function streamError(json:JsonObject):void {
  if(json.error||json.type==='error') {
    const error=object(json.error),message=errorMessage(error,string(json.message)||'Provider stream error');
    const kind=string(error.type)||string(json.code),code=number(error.code);
    throw classifyProviderError(message,code>=400?code:/overload|api_error|rate_limit|server_error|timeout/.test(kind)?500:400);
  }
}
function stop(reason:string,hasTools=false):ProviderResponse['stop'] {
  if(['max_tokens','length','max_output_tokens'].includes(reason))return 'maxTokens';
  if(['refusal','content_filter'].includes(reason))return 'refusal';
  if(reason==='context_window_exceeded')return 'contextWindowExceeded';
  if(reason==='pause_turn')return 'pauseTurn';
  return hasTools?'toolUse':'endTurn';
}
function usage(raw:unknown):Usage {
  const u=object(raw),details=object(u.prompt_tokens_details),cached=number(details.cached_tokens);
  const input=number(u.prompt_tokens),written=number(details.cache_write_tokens);
  return {type:'usage',inputTokens:Math.max(0,input-cached-written),outputTokens:number(u.completion_tokens),cacheReadTokens:cached,cacheWriteTokens:written,...(typeof u.cost==='number'&&u.cost>=0?{cost:u.cost}:{})};
}
/** Merges streamed `reasoning_details` per index for replay on the next turn. */
function mergeReasoningDetails(into:JsonObject[],fragments:unknown[]):void {
  for(const raw of fragments) {
    const f=object(raw),index=typeof f.index==='number'?f.index:into.length?into.length-1:0;
    const slot=into[index]??={};
    for(const [key,value] of Object.entries(f)) {
      if(['text','summary','data'].includes(key)&&typeof value==='string')slot[key]=string(slot[key])+value;
      else if(value!==null&&value!==undefined)slot[key]=value;
    }
  }
}

interface Slot {id:string;name:string;args:string;started:boolean;blockIndex:number}
interface Segment {
  kind:'reasoning'|'text';
  index:number;
  text:string;
  shape?:ReasoningShape;
  redacted?:boolean;
  data?:string;
  closed:boolean;
  annotations:StreamAnnotation[];
}

function longestSuffixPrefix(str:string,tag:string):number {
  const max=Math.min(str.length,tag.length-1);
  for(let len=max;len>0;len--) {
    if(str.slice(-len).toLowerCase()===tag.slice(0,len).toLowerCase())return len;
  }
  return 0;
}

export function classifyReasoningShape(text:string,hint?:ReasoningShape,redacted=false):ReasoningShape {
  if(redacted||hint==='redacted')return 'redacted';
  if(hint==='titles')return 'titles';
  const trimmed=text.trim();
  if(!trimmed)return hint??'none';
  if(/\*\*[^*\n]{2,120}\*\*/.test(trimmed))return 'summary';
  if(hint==='summary')return 'summary';
  const lines=trimmed.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(lines.length>=2&&lines.every(l=>l.length<=72&&!/[.!?;]$/.test(l)))return 'titles';
  return hint??'raw';
}

function normalizeCitation(raw:JsonObject):StreamAnnotation|undefined {
  const sub=object(raw.url_citation ?? raw.citation ?? raw);
  const url=string(sub.url)||string(raw.url);
  const title=string(sub.title)||string(raw.title);
  const citedText=string(sub.cited_text)||string(raw.cited_text)||string(sub.text);
  if(!url&&!title&&!citedText)return undefined;
  const startIndex=typeof sub.start_index==='number'?sub.start_index:typeof raw.start_index==='number'?raw.start_index:undefined;
  const endIndex=typeof sub.end_index==='number'?sub.end_index:typeof raw.end_index==='number'?raw.end_index:undefined;
  return {
    type:'citation',
    ...(url?{url}:{}),
    ...(title?{title}:{}),
    ...(citedText?{citedText}:{}),
    ...(startIndex!==undefined&&startIndex>=0?{startIndex}:{}),
    ...(endIndex!==undefined&&endIndex>=0?{endIndex}:{}),
  };
}

function normalizeImage(raw:JsonObject):StreamAnnotation|undefined {
  const source=object(raw.source),url=string(object(raw.image_url).url)||string(raw.image_url)||string(raw.url)||string(source.url);
  const data=string(raw.result)||string(raw.data)||string(source.data);
  if(!url&&!data)return;
  const format=string(raw.output_format)||'png';
  return {type:'image',mediaType:string(raw.media_type)||string(source.media_type)||`image/${format==='jpg'?'jpeg':format}`,...(url?{url}:{}),...(data?{data}:{})};
}

export async function* decodeOpenAIChat(frames:AsyncIterable<SSEFrame>):AsyncGenerator<ProviderEvent> {
  let text='',reasoning='',reasoningField='reasoning_content',reason='',done=false,u=zero(),refusal='';
  const rawReasoningDetails:JsonObject[]=[],imageParts:MessagePart[]=[];
  const slots:Slot[]=[],slotForIndex=new Map<number,number>();
  const segments:Segment[]=[];
  let activeSegment:Segment|undefined;
  let usedReasoning0=false,usedText1=false,nextDynamicIndex=100;
  let inThink=false,thinkBuf='',sawThinkOpen=false;

  function allocateIndex(kind:'reasoning'|'text'):number {
    if(kind==='reasoning'&&!usedReasoning0){usedReasoning0=true;return 0;}
    if(kind==='text'&&!usedText1){usedText1=true;return 1;}
    return nextDynamicIndex++;
  }

  function* closeActiveSegment():Generator<ProviderEvent> {
    if(activeSegment&&!activeSegment.closed) {
      activeSegment.closed=true;
      if(activeSegment.kind==='reasoning') {
        const finalShape=classifyReasoningShape(activeSegment.text,activeSegment.shape,activeSegment.redacted);
        activeSegment.shape=finalShape;
        yield {type:'blockEnd',index:activeSegment.index,shape:finalShape,...(activeSegment.redacted?{redacted:true}:{})};
      }else {
        yield {type:'blockEnd',index:activeSegment.index};
      }
    }
    activeSegment=undefined;
  }

  function* pushReasoning(deltaText:string,hint:ReasoningShape='raw',redacted=false,data?:string):Generator<ProviderEvent> {
    if(!deltaText&&!redacted)return;
    if(activeSegment&&(activeSegment.kind!=='reasoning'||activeSegment.redacted!==redacted||(redacted&&activeSegment.closed))) {
      yield* closeActiveSegment();
    }
    if(!activeSegment) {
      activeSegment={kind:'reasoning',index:allocateIndex('reasoning'),text:'',shape:hint,redacted,data,closed:false,annotations:[]};
      segments.push(activeSegment);
    }
    if(deltaText) {
      activeSegment.text+=deltaText;
      reasoning+=deltaText;
    }
    if(data&&!activeSegment.data)activeSegment.data=data;
    const shape=classifyReasoningShape(activeSegment.text,hint??activeSegment.shape,redacted);
    activeSegment.shape=shape;
    yield {type:'reasoning',index:activeSegment.index,text:deltaText,shape,...(redacted?{redacted:true}:{})};
    if(redacted)yield* closeActiveSegment();
  }

  function* pushText(deltaText:string,anns?:StreamAnnotation[]):Generator<ProviderEvent> {
    if(!deltaText&&(!anns||!anns.length))return;
    if(activeSegment&&activeSegment.kind!=='text') {
      yield* closeActiveSegment();
    }
    if(!activeSegment) {
      activeSegment={kind:'text',index:allocateIndex('text'),text:'',closed:false,annotations:[]};
      segments.push(activeSegment);
    }
    if(deltaText) {
      activeSegment.text+=deltaText;
      text+=deltaText;
    }
    if(anns?.length)activeSegment.annotations.push(...anns);
    yield {type:'text',index:activeSegment.index,text:deltaText,...(anns?.length?{annotations:anns}:{})};
  }

  function* processContentWithThinkTags(chunk:string,flush=false):Generator<ProviderEvent> {
    thinkBuf+=chunk;
    while(thinkBuf.length>0) {
      if(!inThink) {
        const openMatch=/<think>/i.exec(thinkBuf);
        if(openMatch && (openMatch.index===0 || !text.trim() || sawThinkOpen || /\s$/.test(thinkBuf.slice(0,openMatch.index)))) {
          const before=thinkBuf.slice(0,openMatch.index);
          if(before)yield* pushText(before);
          thinkBuf=thinkBuf.slice(openMatch.index+openMatch[0].length);
          if(thinkBuf.startsWith('\n'))thinkBuf=thinkBuf.slice(1);
          inThink=true;sawThinkOpen=true;
          continue;
        }
        if(!flush) {
          const keep=longestSuffixPrefix(thinkBuf,'<think>');
          if(keep>0) {
            const safe=thinkBuf.slice(0,thinkBuf.length-keep);
            if(safe)yield* pushText(safe);
            thinkBuf=thinkBuf.slice(thinkBuf.length-keep);
            break;
          }
        }
        yield* pushText(thinkBuf);
        thinkBuf='';
      }else {
        const closeMatch=/<\/think>/i.exec(thinkBuf);
        if(closeMatch) {
          const inside=thinkBuf.slice(0,closeMatch.index);
          if(inside)yield* pushReasoning(inside,'raw');
          yield* closeActiveSegment();
          thinkBuf=thinkBuf.slice(closeMatch.index+closeMatch[0].length);
          if(thinkBuf.startsWith('\n'))thinkBuf=thinkBuf.slice(1);
          inThink=false;
          continue;
        }
        if(!flush) {
          const keep=longestSuffixPrefix(thinkBuf,'</think>');
          if(keep>0) {
            const safe=thinkBuf.slice(0,thinkBuf.length-keep);
            if(safe)yield* pushReasoning(safe,'raw');
            thinkBuf=thinkBuf.slice(thinkBuf.length-keep);
            break;
          }
        }
        yield* pushReasoning(thinkBuf,'raw');
        thinkBuf='';
      }
    }
  }

  for await(const frame of frames) {
    if(frame.data==='[DONE]'){done=true;break;}
    if(!frame.data)continue;
    const e=JsonObjectSchema.parse(JSON.parse(frame.data));streamError(e);
    if(e.usage)u=usage(e.usage);
    const choices=array(e.choices);
    if(!choices.length)continue;
    const choice=object(choices[0]),delta=object(choice.delta);
    if(choice.finish_reason){
      reason=string(choice.finish_reason);
      if(reason==='error')throw new ProviderFailure('Provider stopped with an error','retryable');
    }

    // 1. Structured reasoning details (OpenRouter / multi-block reasoning)
    const details=array(delta.reasoning_details);
    if(details.length) {
      for(const rawDetail of details) {
        const d=object(rawDetail);
        mergeReasoningDetails(rawReasoningDetails, [d]);
        const dtype=string(d.type);
        if(dtype==='reasoning.summary'&&typeof d.summary==='string'&&d.summary) {
          yield* pushReasoning(d.summary,'summary');
        }else if(dtype==='reasoning.text'&&typeof d.text==='string'&&d.text) {
          yield* pushReasoning(d.text,'raw');
        }else if(dtype==='reasoning.encrypted') {
          yield* pushReasoning('','redacted',true,string(d.data)||string(d.encrypted));
        }else if(typeof d.text==='string'&&d.text) {
          yield* pushReasoning(d.text,'raw');
        }
      }
    }

    // 2. Step titles / condensed summary fields
    const titleDelta=string(delta.reasoning_title)||string(delta.thought_title)||string(delta.step_title);
    if(titleDelta) {
      const prefix=activeSegment?.kind==='reasoning'&&activeSegment.text&&!activeSegment.text.endsWith('\n')?'\n':'';
      yield* pushReasoning(`${prefix}${titleDelta}`,'titles');
    }
    const summaryDelta=string(delta.reasoning_summary)||string(delta.thought_summary);
    if(summaryDelta) {
      yield* pushReasoning(summaryDelta,'summary');
    }

    // 3. Standard reasoning_content / reasoning string fields
    for(const field of (details.length ? [] : ['reasoning_content','reasoning'])) {
      if(typeof delta[field]==='string') {
        const t=string(delta[field]);
        reasoningField=field;
        if(t)yield* pushReasoning(t,'raw');
        break;
      }
    }

    // 4. Annotations (citations, images)
    const frameAnnotations:StreamAnnotation[]=[];
    for(const rawAnn of [...array(delta.annotations),...array(object(choice.message).annotations)]) {
      const cit=normalizeCitation(object(rawAnn));
      if(cit)frameAnnotations.push(cit);
    }
    for(const rawImg of array(delta.images)) {
      const img=object(rawImg),url=string(object(img.image_url).url)||string(img.url);
      if(url){
        frameAnnotations.push({type:'image',url,mediaType:string(img.media_type)||'image/png'});
        imageParts.push({type:'image',url,mediaType:string(img.media_type)||'image/png'});
      }
    }

    // 5. Content delta (including inline <think>...</think> tags)
    if(typeof delta.content==='string'&&delta.content) {
      yield* processContentWithThinkTags(delta.content,false);
    }
    if(frameAnnotations.length) {
      yield* pushText('',frameAnnotations);
    }

    // 6. Refusals
    if(typeof delta.refusal==='string'&&delta.refusal) {
      refusal+=delta.refusal;
      yield* pushText(delta.refusal,[{type:'refusal',text:delta.refusal}]);
    }

    // 7. Tool calls
    const toolFragments=array(delta.tool_calls);
    if(toolFragments.length) {
      yield* closeActiveSegment();
    }
    for(const fragment of toolFragments) {
      const f=object(fragment),fn=object(f.function),id=string(f.id),name=string(fn.name);let slot:number|undefined;
      if(typeof f.index==='number') {
        slot=slotForIndex.get(f.index);
        if(slot!==undefined&&id&&slots[slot]!.id&&slots[slot]!.id!==id)slot=slots.findIndex(s=>s.id===id);
        if(slot===undefined||slot<0){slot=slots.length;slots.push({id:'',name:'',args:'',started:false,blockIndex:slot+2});}
        slotForIndex.set(f.index,slot);
      }else{
        const last=slots.at(-1);if(last&&(!id||last.id===id)&&(!name||!last.name))slot=slots.length-1;
        else {slot=slots.length;slots.push({id:'',name:'',args:'',started:false,blockIndex:slot+2});}
      }
      const s=slots[slot]!;if(!s.started&&id)s.id=id;if(name&&!s.name)s.name=name;
      const json=typeof fn.arguments==='string'?fn.arguments:fn.arguments?JSON.stringify(fn.arguments):'';s.args+=json;
      if(!s.started&&s.name){
        s.started=true;s.id||=`call_${crypto.randomUUID()}`;
        yield {type:'tool',index:s.blockIndex,id:s.id,name:s.name};
        if(s.args)yield {type:'arguments',index:s.blockIndex,json:s.args};
      }else if(s.started&&json)yield {type:'arguments',index:s.blockIndex,json};
    }
  }
  if(thinkBuf)yield* processContentWithThinkTags('',true);
  if(!done&&!reason)throw new ProviderFailure('Chat stream ended before completion','retryable');
  yield* closeActiveSegment();

  const calls=slots.filter(s=>s.started);
  if(!calls.length&&!text&&!reasoning&&! segments.some(s=>s.redacted)&&/tool_calls|function_call/.test(reason)) {
    throw new ProviderFailure('Provider promised tools without naming one');
  }
  const parts:MessagePart[]=[];
  for(const seg of segments) {
    if(seg.kind==='reasoning') {
      const shape=classifyReasoningShape(seg.text,seg.shape,seg.redacted);
      parts.push({
        type:'reasoning',
        text:seg.text,
        shape,
        ...(seg.redacted?{redacted:true}:{}),
        ...(seg.data?{data:seg.data}:{}),
      });
    }else if(seg.kind==='text'&&(seg.text||seg.annotations.length)) {
      parts.push({
        type:'text',
        text:seg.text,
        ...(seg.annotations.length?{annotations:seg.annotations}:{}),
      });
    }
  }
  parts.push(...imageParts);
  parts.push(...calls.map(s=>({type:'toolCall' as const,callId:s.id,name:s.name,arguments:s.args||'{}'})));
  const raw:JsonObject={role:'assistant',content:text||null};
  if(reasoning)raw[reasoningField]=reasoning;
  if(refusal)raw.refusal=refusal;
  if(rawReasoningDetails.length)raw.reasoning_details=rawReasoningDetails;
  if(calls.length)raw.tool_calls=calls.map(s=>({id:s.id,type:'function',function:{name:s.name,arguments:s.args||'{}'}}));
  yield {type:'completed',response:{parts,stop:refusal?'refusal':stop(reason,!!calls.length),usage:u,raw:{type:'provider.payload',data:raw}}};
}
