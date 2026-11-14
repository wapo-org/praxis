import {
  JsonObjectSchema,
  type JsonObject,
  type MessagePart,
  type ProviderFlavor,
  type ReasoningShape,
  type StreamAnnotation,
  type Usage,
} from '@praxis/protocol';
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
  const rejection=/not support|does not support|unsupported|not allowed|unrecognized|unknown parameter|invalid/;
  const kind=/(?:image|vision|multimodal)/.test(lower)&&rejection.test(lower)?'images':
    /no endpoints found that support tool use/.test(lower)||/(?:tools?|tool_choice|function calling)/.test(lower)&&rejection.test(lower)?'tools':
    /(?:reasoning_effort|reasoning effort|output_config\.effort|adaptive thinking)/.test(lower)&&(rejection.test(lower)||/must be|should be/.test(lower))?'effort':
    /context[_ ]?(length|window)|prompt.{0,8}too long|too many (input )?tokens|maximum context|request_too_large/.test(lower)||status===413?'context':
    [408,409,429].includes(status)||status>=500?'retryable':'fatal';
  return new ProviderFailure(message,kind,retryAfterMs);
}
function streamError(json:JsonObject):void {
  if(json.error||json.type==='error') {
    const error=object(json.error),message=string(error.message)||string(json.message)||'Provider stream error';
    const kind=string(error.type)||string(json.code);
    throw classifyProviderError(message,/overload|api_error|rate_limit|server_error|timeout|502|503|504/.test(kind)?500:400);
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

/**
 * Classifies a reasoning block into one of the five canonical shapes:
 * - 'redacted': encrypted / opaque reasoning without readable text
 * - 'titles': short status/step lines (e.g. "Searching the repo\nChecking types")
 * - 'summary': condensed sections with **Title** headings or explicit summary blocks
 * - 'raw': full token-by-token chain-of-thought
 * - 'none': empty non-redacted reasoning
 */
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

export async function* decodeAnthropic(frames:AsyncIterable<SSEFrame>):AsyncGenerator<ProviderEvent> {
  const blocks=new Map<number,JsonObject>(),args=new Map<number,string>(),closed=new Set<number>();
  const annotationsByBlock=new Map<number,StreamAnnotation[]>();
  let raw:JsonObject={},u=zero(),reason='',done=false;
  for await(const frame of frames) {
    if(!frame.data||frame.data==='[DONE]')continue;
    const e=JsonObjectSchema.parse(JSON.parse(frame.data));streamError(e);
    const type=string(e.type)||frame.event,index=number(e.index);
    if(type==='message_start'){if(done)continue;raw=object(e.message);u=usage(raw.usage,'anthropicMessages');}
    else if(type==='content_block_start') {
      if(done)continue;
      const block=structuredClone(object(e.content_block));blocks.set(index,block);
      if(block.type==='tool_use')yield {type:'tool',index,id:string(block.id),name:string(block.name)};
      else if(block.type==='server_tool_use')yield {type:'tool',index,id:string(block.id),name:string(block.name),server:true};
      else if(block.type==='text'&&string(block.text))yield {type:'text',index,text:string(block.text)};
      else if(block.type==='thinking'){
        const t=string(block.thinking);
        yield {type:'reasoning',index,text:t,shape:classifyReasoningShape(t,'raw')};
      }else if(block.type==='image'){
        const image=normalizeImage(block);if(image){annotationsByBlock.set(index,[image]);yield {type:'text',index,text:'',annotations:[image]};}
      }else if(block.type==='redacted_thinking'){
        yield {type:'reasoning',index,text:'',shape:'redacted',redacted:true};
      }
    }else if(type==='content_block_delta') {
      if(done)continue;
      const block=blocks.get(index);if(!block)throw new ProviderFailure('Delta references missing content block');
      const delta=object(e.delta);
      if(delta.type==='text_delta'){
        const t=string(delta.text);
        if(t){block.text=string(block.text)+t;yield {type:'text',index,text:t};}
      }else if(delta.type==='citations_delta'){
        const cit=normalizeCitation(object(delta.citation));
        if(cit){
          const list=annotationsByBlock.get(index)??[];list.push(cit);annotationsByBlock.set(index,list);
          block.citations=[...array(block.citations),object(delta.citation)];
          yield {type:'text',index,text:'',annotations:[cit]};
        }
      }else if(delta.type==='thinking_delta'){
        const t=string(delta.thinking);
        if(t){
          block.thinking=string(block.thinking)+t;
          yield {type:'reasoning',index,text:t,shape:classifyReasoningShape(string(block.thinking),'raw')};
        }
      }else if(delta.type==='signature_delta'){
        block.signature=string(block.signature)+string(delta.signature);
      }else if(delta.type==='input_json_delta') {
        const json=string(delta.partial_json);
        args.set(index,(args.get(index)??'')+json);
        if(block.type==='tool_use'&&json)yield {type:'arguments',index,json};
      }
    }else if(type==='content_block_stop') {
      if(done||closed.has(index))continue;
      closed.add(index);
      const block=blocks.get(index),json=args.get(index);
      if(block&&json){try{block.input=JSON.parse(json);}catch{block.input={};}}
      if(block?.type==='redacted_thinking')yield {type:'blockEnd',index,shape:'redacted',redacted:true};
      else if(block?.type==='thinking')yield {type:'blockEnd',index,shape:classifyReasoningShape(string(block.thinking),'raw')};
      else yield {type:'blockEnd',index};
    }else if(type==='message_delta') {
      if(done)continue;
      const delta=object(e.delta);
      reason=string(delta.stop_reason)||reason;
      const updated=object(e.usage);
      u={...u,...(typeof updated.output_tokens==='number'?{outputTokens:updated.output_tokens}:{}),...(typeof updated.input_tokens==='number'?{inputTokens:updated.input_tokens}:{})};
    }else if(type==='message_stop'){
      if(done)continue;
      done=true;break;
    }
  }
  if(!done)throw new ProviderFailure('Anthropic stream ended before message_stop','retryable');
  for(const [index,b] of [...blocks].sort(([a],[b])=>a-b)) {
    if(!closed.has(index)) {
      closed.add(index);
      if(b.type==='redacted_thinking')yield {type:'blockEnd',index,shape:'redacted',redacted:true};
      else if(b.type==='thinking')yield {type:'blockEnd',index,shape:classifyReasoningShape(string(b.thinking),'raw')};
      else yield {type:'blockEnd',index};
    }
  }
  const parts:MessagePart[]=[];
  for(const [index,b] of [...blocks].sort(([a],[b])=>a-b)) {
    if(b.type==='text'){
      const anns=annotationsByBlock.get(index);
      parts.push({type:'text',text:string(b.text),...(anns?.length?{annotations:anns}:{})});
    }else if(b.type==='image'){
      const image=normalizeImage(b);if(image)parts.push({type:'image',...(image.url?{url:image.url}:{}),...(image.data?{data:image.data}:{}),mediaType:image.mediaType});
    }else if(b.type==='thinking'){
      const t=string(b.thinking),shape=classifyReasoningShape(t,'raw');
      parts.push({type:'reasoning',text:t,shape,...(string(b.signature)?{signature:string(b.signature)}:{})});
    }else if(b.type==='redacted_thinking'){
      parts.push({type:'reasoning',text:'',shape:'redacted',redacted:true,...(string(b.data)?{data:string(b.data)}:{})});
    }else if(b.type==='tool_use'){
      parts.push({type:'toolCall',callId:string(b.id),name:string(b.name),arguments:args.get(index)||JSON.stringify(b.input??{})});
    }
  }
  raw={...raw,content:[...blocks].sort(([a],[b])=>a-b).map(([,b])=>b),stop_reason:reason,usage:{input_tokens:u.inputTokens,output_tokens:u.outputTokens,cache_read_input_tokens:u.cacheReadTokens,cache_creation_input_tokens:u.cacheWriteTokens}};
  yield {type:'completed',response:{parts,stop:stop(reason,parts.some(p=>p.type==='toolCall')),usage:u,raw:{type:'provider.payload',flavor:'anthropicMessages',data:raw}}};
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
    if(e.usage)u=usage(e.usage,'openAIChat');
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
        rawReasoningDetails.push(d);
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
  yield {type:'completed',response:{parts,stop:refusal?'refusal':stop(reason,!!calls.length),usage:u,raw:{type:'provider.payload',flavor:'openAIChat',data:raw}}};
}

export async function* decodeOpenAIResponses(frames:AsyncIterable<SSEFrame>):AsyncGenerator<ProviderEvent> {
  const items=new Map<number,JsonObject>(),doneItems=new Map<number,JsonObject>(),indices=new Map<string,number>();
  const closed=new Set<number>(),emittedReasoningOutputs=new Set<number>(),reasoningAcc=new Map<number,{text:string;shape:ReasoningShape}>();
  const annotationsByIndex=new Map<number,StreamAnnotation[]>();
  let nextIndex=0,response:JsonObject|undefined;
  const blockIndex=(key:string)=>{if(!indices.has(key))indices.set(key,nextIndex++);return indices.get(key)!;};
  for await(const frame of frames) {
    if(!frame.data||frame.data==='[DONE]')continue;
    const e=JsonObjectSchema.parse(JSON.parse(frame.data));streamError(e);
    const type=string(e.type)||frame.event,output=number(e.output_index),content=number(e.content_index);
    if(type==='response.output_item.added') {
      if(response)continue;
      const item=structuredClone(object(e.item));items.set(output,item);
      if(item.type==='function_call')yield {type:'tool',index:blockIndex(`tool.${output}`),id:string(item.call_id)||string(item.id),name:string(item.name)};
      if(item.type==='reasoning')yield {type:'reasoning',index:blockIndex(`reasoning.${output}.0`),text:'',shape:'none'};
    }else if(type==='response.output_item.done'){
      if(response)continue;
      const item=structuredClone(object(e.item));items.set(output,item);doneItems.set(output,item);
      if(item.type==='image_generation_call'){const image=normalizeImage(item);if(image)yield {type:'text',index:blockIndex(`image.${output}`),text:'',annotations:[image]};}
      if(item.type==='reasoning'&&!emittedReasoningOutputs.has(output)) {
        const summaries=array(item.summary).map(s=>string(object(s).text)).filter(Boolean);
        if(!summaries.length&&string(item.encrypted_content)) {
          const idx=blockIndex(`reasoning.${output}.0`);
          emittedReasoningOutputs.add(output);
          closed.add(idx);
          yield {type:'reasoning',index:idx,text:'',shape:'redacted',redacted:true};
          yield {type:'blockEnd',index:idx,shape:'redacted',redacted:true};
        }
      }
    }else if(type==='response.output_text.delta') {
      if(response)continue;
      const t=string(e.delta);
      if(t)yield {type:'text',index:blockIndex(`text.${output}.${content}`),text:t};
    }else if(type==='response.refusal.delta'){
      const text=string(e.delta);if(text)yield {type:'text',index:blockIndex(`text.${output}.${content}`),text,annotations:[{type:'refusal',text}]};
    }else if(type==='response.refusal.done'){
      const index=blockIndex(`text.${output}.${content}`);if(!closed.has(index)){closed.add(index);yield {type:'blockEnd',index};}
    }else if(type==='response.output_text.annotation.added') {
      if(response)continue;
      const cit=normalizeCitation(object(e.annotation));
      if(cit) {
        const idx=blockIndex(`text.${output}.${content}`);
        const list=annotationsByIndex.get(idx)??[];list.push(cit);annotationsByIndex.set(idx,list);
        yield {type:'text',index:idx,text:'',annotations:[cit]};
      }
    }else if(type==='response.reasoning_summary_text.delta'||type==='response.reasoning_text.delta') {
      if(response)continue;
      const t=string(e.delta);
      if(t) {
        const idx=blockIndex(`reasoning.${output}.${number(e.summary_index)}`);
        emittedReasoningOutputs.add(output);
        const hint:ReasoningShape=type==='response.reasoning_summary_text.delta'?'summary':'raw';
        const prev=reasoningAcc.get(idx)??{text:'',shape:hint};
        prev.text+=t;
        prev.shape=classifyReasoningShape(prev.text,hint);
        reasoningAcc.set(idx,prev);
        yield {type:'reasoning',index:idx,text:t,shape:prev.shape};
      }
    }else if(type==='response.function_call_arguments.delta') {
      if(response)continue;
      const delta=string(e.delta);
      const item=items.get(output);if(item)item.arguments=string(item.arguments)+delta;
      if(delta)yield {type:'arguments',index:blockIndex(`tool.${output}`),json:delta};
    }else if(/response\.(output_text|reasoning_summary_text|reasoning_text)\.done/.test(type)) {
      if(response)continue;
      const isR=type.includes('reasoning');
      const idx=blockIndex(isR?`reasoning.${output}.${number(e.summary_index)}`:`text.${output}.${content}`);
      if(!closed.has(idx)) {
        closed.add(idx);
        const acc=reasoningAcc.get(idx);
        yield {type:'blockEnd',index:idx,...(isR&&acc?{shape:acc.shape}:{})};
      }
    }else if(type==='response.completed'||type==='response.incomplete'){
      if(!response)response=object(e.response);break;
    }else if(type==='response.failed') {
      const error=object(object(e.response).error);throw classifyProviderError(string(error.message)||'Response failed',/server|rate|timeout/.test(string(error.code))?500:400);
    }
  }
  if(!response)throw new ProviderFailure('Responses stream ended before completion','retryable');
  const outputs=array(response.output).length?array(response.output):[...items].sort(([a],[b])=>a-b).map(([,b])=>b);
  // Prefer completed item snapshots for encrypted reasoning; added snapshots may be partial.
  const completed=outputs.map((item,i)=>doneItems.get(i)??object(item));
  const parts:MessagePart[]=[];let refused=false;
  for(let outIdx=0;outIdx<completed.length;outIdx++) {
    const b=completed[outIdx]!;
    if(b.type==='function_call'){
      parts.push({type:'toolCall',callId:string(b.call_id)||string(b.id),name:string(b.name),arguments:string(b.arguments)||'{}'});
    }else if(b.type==='message'){
      const contentArr=array(b.content);
      for(let cIdx=0;cIdx<contentArr.length;cIdx++) {
        const p=object(contentArr[cIdx]);
        if(p.type==='output_text'){
          const idx=indices.get(`text.${outIdx}.${cIdx}`);
          const anns=[...(idx!==undefined?annotationsByIndex.get(idx)??[]:[])];
          for(const rawAnn of array(p.annotations)){const cit=normalizeCitation(object(rawAnn));if(cit&&!anns.some(a=>a.url===cit.url&&a.title===cit.title))anns.push(cit);}
          parts.push({type:'text',text:string(p.text),...(anns.length?{annotations:anns}:{})});
        }
        if(p.type==='refusal'){refused=true;const text=string(p.refusal);parts.push({type:'text',text,annotations:[{type:'refusal',text}]});}
      }
    }else if(b.type==='image_generation_call'){
      const image=normalizeImage(b);if(image)parts.push({type:'image',mediaType:image.mediaType,...(image.data?{data:image.data}:{}),...(image.url?{url:image.url}:{})});
    }else if(b.type==='reasoning'){
      const summaryTexts=array(b.summary).map(s=>string(object(s).text)).filter(Boolean);
      const rawTexts=array(b.content).map(s=>string(object(s).text)).filter(Boolean);
      const joined=summaryTexts.length?summaryTexts.join('\n'):rawTexts.join('\n');
      const isRedacted=!joined&&Boolean(string(b.encrypted_content));
      if(isRedacted&&!emittedReasoningOutputs.has(outIdx)) {
        const idx=blockIndex(`reasoning.${outIdx}.0`);
        emittedReasoningOutputs.add(outIdx);
        closed.add(idx);
        yield {type:'reasoning',index:idx,text:'',shape:'redacted',redacted:true};
        yield {type:'blockEnd',index:idx,shape:'redacted',redacted:true};
      }
      const hint:ReasoningShape=isRedacted?'redacted':summaryTexts.length?'summary':'raw';
      const shape=classifyReasoningShape(joined,hint,isRedacted);
      parts.push({
        type:'reasoning',
        text:joined,
        shape,
        ...(isRedacted?{redacted:true}:{}),
        ...(string(b.encrypted_content)?{data:string(b.encrypted_content)}:{}),
      });
    }
  }
  yield {type:'completed',response:{parts,stop:refused?'refusal':stop(string(object(response.incomplete_details).reason),parts.some(p=>p.type==='toolCall')),usage:usage(response.usage,'openAIResponses'),raw:{type:'provider.payload',flavor:'openAIResponses',data:completed}}};
}
