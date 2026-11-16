import { z } from 'zod';
import {JsonObjectSchema,type JsonObject,type JsonValue,type Message,type MessagePart,type ProviderFlavor} from '@praxis/protocol';
import {ProviderRequestSchema,type ProviderRequest} from './types.js';
export function object(value:unknown):JsonObject {return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{};}
export function array(value:unknown):JsonValue[]{return Array.isArray(value)?value:[];}
export function string(value:unknown):string{return typeof value==='string'?value:'';}
export function number(value:unknown):number{return typeof value==='number'&&Number.isFinite(value)?value:0;}
const effortOrder=['none','minimal','low','medium','high','xhigh','max'];
export function clampEffort(want:string|undefined,supported:string[]|undefined):string|undefined {
  if(!want||supported?.length===0)return undefined;want=want.toLowerCase();if(!supported)return want;
  const values=supported.map(x=>x.toLowerCase());if(values.includes(want))return want;
  const rank=effortOrder.indexOf(want);if(rank<0)return undefined;
  return values.filter(x=>effortOrder.includes(x)).sort((a,b)=>Math.abs(effortOrder.indexOf(a)-rank)-Math.abs(effortOrder.indexOf(b)-rank)||effortOrder.indexOf(a)-effortOrder.indexOf(b))[0];
}
/** Supported values from a provider rejection, or [] when the parameter is unsupported/unknown. */
export function parseEffortRejection(message:string):string[] {
  const lower=message.toLowerCase(),match=/(?:\b(?:supported|allowed)(?: values)?\s*(?::|\bare\b|\bis\b)|\b(?:must|should) be one of)\s*(.*)/.exec(lower);
  if(!match)return [];
  return [...new Set(match[1]!.match(/\b(?:none|minimal|low|medium|high|xhigh|max)\b/g)??[])];
}

const text=(value:string):JsonObject=>({type:'text',text:value});
const note=(p:MessagePart)=>`[Note]\n${p.text??''}`;
const flattenCall=(p:MessagePart)=>`[Tool call ${p.name??''} ${p.callId??''}] ${p.arguments??'{}'}`;
const resultText=(p:MessagePart)=>`${p.isError?'Error: ':''}${(p.content??[]).map(c=>c.type==='image'?`[Image ${string(c.attachmentId)}]`:string(c.text)||JSON.stringify(c)).join('\n')||'(no output)'}`;
function mediaUrl(p:MessagePart):string{return p.url??`data:${p.mediaType??(string((p as unknown as JsonObject).mimeType)||'image/png')};base64,${p.data??''}`;}
function omitted(p:MessagePart,req:ProviderRequest):string {
  const offered=req.capabilities.tools&&req.tools.some(t=>t.name==='look_at_image');
  return `[${p.type} ${p.attachmentId??''} omitted${offered?'; use look_at_image to inspect it':''}]`;
}
function anthropicContent(p:MessagePart,req:ProviderRequest):JsonObject|undefined {
  if(p.type==='text'||p.type==='note')return text(p.type==='note'?note(p):p.text??'');
  if(p.type==='toolCall')return req.capabilities.tools?{type:'tool_use',id:p.callId??'',name:p.name??'',input:safeArguments(p.arguments)}:text(flattenCall(p));
  if(p.type==='toolResult')return req.capabilities.tools?{type:'tool_result',tool_use_id:p.callId??'',content:(p.content??[]).map(c=>c.type==='image'?req.capabilities.vision&&req.capabilities.imagesInToolResults?anthropicImage(c):text(req.capabilities.vision?'[Image attached after tool results]':omitted({type:'image',...c} as MessagePart,req)):c),is_error:p.isError??false}:text(`[Tool result ${p.callId??''}] ${resultText(p)}`);
  if(p.type==='image')return req.capabilities.vision?anthropicImage(p):text(omitted(p,req));
  if(p.type==='document'&&req.capabilities.documents)return {type:'document',source:p.url?{type:'url',url:p.url}:{type:'base64',media_type:p.mediaType??'application/pdf',data:p.data??''}};
  if(p.type==='document')return text(p.text??omitted(p,req));
  return undefined; // Cross-flavor reasoning has no valid signature.
}
function anthropicImage(p:{url?:JsonValue;data?:JsonValue;mediaType?:JsonValue;mimeType?:JsonValue}):JsonObject {
  return {type:'image',source:p.url?{type:'url',url:p.url}:{type:'base64',media_type:p.mediaType??p.mimeType??'image/png',data:p.data??''}};
}
function safeArguments(value:string|undefined):JsonObject {try{return JsonObjectSchema.parse(JSON.parse(value??'{}'));}catch{return {};}}
export interface RequestOptions {systemRole?:'system'|'developer';maxTokensField?:'max_tokens'|'max_completion_tokens'|'omit';replayReasoning?:boolean;webSearchToolType?:string}
export function buildProviderRequest(flavor:ProviderFlavor,raw:ProviderRequest,options:RequestOptions={}):JsonObject {
  const req=ProviderRequestSchema.parse(raw),c=req.capabilities;
  const system=req.system+(!c.tools?'\n[Tool use is unavailable for this request. Do not call tools.]':'');
  const effort=c.reasoningEffort?clampEffort(req.effort,req.supportedEfforts):undefined;
  if(flavor==='anthropicMessages') {
    const messages:JsonObject[]=[];
    for(const m of req.messages) {
      const native=m.role==='assistant'&&m.raw?.flavor===flavor&&c.tools?m.raw.data:undefined;
      const content=native?array(Array.isArray(native)?native:object(native).content):m.parts.map(p=>anthropicContent(p,req)).filter((p):p is JsonObject=>!!p);
      if(m.role==='user'&&c.vision&&(!c.tools||!c.imagesInToolResults))for(const part of m.parts)if(part.type==='toolResult')for(const image of part.content??[])if(image.type==='image')content.push(anthropicImage(image));
      if(!content.length)continue;
      const last=messages.at(-1);if(last?.role===m.role)last.content=[...array(last.content),...content];else messages.push({role:m.role,content});
    }
    for(const m of messages)if(m.role==='user')m.content=[...array(m.content).filter(x=>object(x).type==='tool_result'),...array(m.content).filter(x=>object(x).type!=='tool_result')];
    const body:JsonObject={model:req.model,max_tokens:req.maxTokens,stream:true,messages};
    if(system){body.system=[{type:'text',text:system,...(c.explicitPromptCaching?{cache_control:{type:'ephemeral'}}:{})}];}
    if(c.explicitPromptCaching) {
      const last=[...messages].reverse().find(m=>m.role==='user'),content=array(last?.content),block=content.at(-1);
      if(block&&typeof block==='object'&&!Array.isArray(block))object(block).cache_control={type:'ephemeral'};
    }
    const tools:JsonObject[]=c.tools?req.tools.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema})):[];
    if(c.tools&&req.webSearch&&c.serverWebSearch)tools.push({type:options.webSearchToolType??'web_search_20250305',name:'web_search'});
    if(tools.length)body.tools=tools;
    if(effort){body.thinking={type:'adaptive'};body.output_config={effort};}
    return body;
  }
  if(flavor==='openAIChat') {
    const messages:JsonObject[]=[];if(system)messages.push({role:options.systemRole??'system',content:system});
    for(const m of req.messages) {
      if(m.role==='assistant') {
        if(c.tools&&m.raw?.flavor===flavor) {
          const raw=structuredClone(object(m.raw.data));raw.role='assistant';
          if(options.replayReasoning===false)for(const key of ['reasoning_content','reasoning','reasoning_details'])delete raw[key];
          messages.push(raw);continue;
        }
        const calls=m.parts.filter(p=>p.type==='toolCall'),txt=m.parts.filter(p=>p.type==='text').map(p=>p.text??'').join('');
        if(!txt&&!calls.length)continue;
        const a:JsonObject={role:'assistant',content:!c.tools?[txt,...calls.map(flattenCall)].filter(Boolean).join('\n'):txt||null};
        if(c.tools&&calls.length)a.tool_calls=calls.map(p=>({id:p.callId??'',type:'function',function:{name:p.name??'',arguments:p.arguments??'{}'}}));
        messages.push(a);continue;
      }
      const content:JsonObject[]=[],notes:JsonObject[]=[];
      for(const p of m.parts) {
        if(p.type==='toolResult') {
          if(c.tools)messages.push({role:'tool',tool_call_id:p.callId??'',content:resultText(p)});else content.push(text(`[Tool result ${p.callId??''}] ${resultText(p)}`));
          for(const item of p.content??[])if(item.type==='image'&&c.vision)content.push({type:'image_url',image_url:{url:mediaUrl(item as MessagePart)}});
        }else if(p.type==='note'&&c.midConversationSystem)notes.push({role:options.systemRole??'system',content:p.text??''});
        else if(p.type==='image')content.push(c.vision?{type:'image_url',image_url:{url:mediaUrl(p)}}:text(omitted(p,req)));
        else if(p.type==='document'&&c.documents)content.push({type:'file',file:{filename:p.attachmentId??'document.pdf',file_data:mediaUrl(p)}});
        else if(p.type==='text'||p.type==='note'||p.type==='document')content.push(text(p.type==='note'?note(p):p.text??omitted(p,req)));
      }
      messages.push(...notes);
      if(content.length) {
        const compact=(items:JsonValue[]):JsonValue=>items.every(p=>object(p).type==='text')?items.map(p=>string(object(p).text)).join('\n\n'):items;
        const last=messages.at(-1);
        if(last?.role==='user') {
          const old=typeof last.content==='string'?[text(last.content)]:array(last.content);last.content=compact([...old,...content]);
        }else messages.push({role:'user',content:compact(content)});
      }
    }
    const body:JsonObject={model:req.model,messages,stream:true};
    if(options.maxTokensField!=='omit')body[options.maxTokensField??'max_tokens']=req.maxTokens;
    if(c.streamUsage)body.stream_options={include_usage:true};
    if(c.tools&&req.tools.length){body.tools=req.tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}));body.parallel_tool_calls=c.parallelToolCalls;}
    if(effort)body.reasoning_effort=effort;return body;
  }
  const input:JsonObject[]=[];
  for(const m of req.messages) {
    if(m.role==='assistant'&&c.tools&&m.raw?.flavor===flavor){input.push(...array(Array.isArray(m.raw.data)?m.raw.data:object(m.raw.data).output).map(object));continue;}
    let content:JsonObject[]=[];
    const flush=()=>{if(content.length){input.push({role:m.role,content});content=[];}};
    for(const p of m.parts) {
      if(p.type==='toolCall'&&c.tools){flush();input.push({type:'function_call',call_id:p.callId??'',name:p.name??'',arguments:p.arguments??'{}'});}
      else if(p.type==='toolResult'&&c.tools){flush();input.push({type:'function_call_output',call_id:p.callId??'',output:resultText(p)});
        if(c.vision)for(const image of p.content??[])if(image.type==='image')content.push({type:'input_image',image_url:mediaUrl(image as MessagePart)});
      }
      else if(p.type==='image')content.push(c.vision?{type:'input_image',image_url:mediaUrl(p)}:{type:'input_text',text:omitted(p,req)});
      else if(p.type==='document'&&c.documents)content.push({type:'input_file',...(p.url?{file_url:p.url}:{filename:p.attachmentId??'document.pdf',file_data:mediaUrl(p)})});
      else if(['text','note','toolCall','toolResult','document'].includes(p.type))content.push({type:m.role==='assistant'?'output_text':'input_text',text:p.type==='toolCall'?flattenCall(p):p.type==='toolResult'?`[Tool result ${p.callId??''}] ${resultText(p)}`:p.type==='note'?note(p):p.text??omitted(p,req)});
    }
    flush();
  }
  const body:JsonObject={model:req.model,input,instructions:system,stream:true,store:false,max_output_tokens:req.maxTokens,include:['reasoning.encrypted_content']};
  const tools:JsonObject[]=c.tools?req.tools.map(t=>({type:'function',name:t.name,description:t.description,parameters:t.inputSchema,strict:false})):[];
  if(c.tools&&req.webSearch&&c.serverWebSearch)tools.push({type:'web_search'});
  if(tools.length){body.tools=tools;body.parallel_tool_calls=c.parallelToolCalls;}
  if(effort)body.reasoning={effort};return body;
}
