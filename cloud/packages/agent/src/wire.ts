import { z } from 'zod';
import {JsonObjectSchema,type JsonObject,type JsonValue,type Message,type MessagePart} from '@praxis/protocol';
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
const text=(value:string):JsonObject=>({type:'text',text:value});
const note=(p:MessagePart)=>`[Note]\n${p.text??''}`;
const flattenCall=(p:MessagePart)=>`[Tool call ${p.name??''} ${p.callId??''}] ${p.arguments??'{}'}`;
const resultText=(p:MessagePart)=>`${p.isError?'Error: ':''}${(p.content??[]).map(c=>c.type==='image'?`[Image ${string(c.attachmentId)}]`:string(c.text)||JSON.stringify(c)).join('\n')||'(no output)'}`;
function mediaUrl(p:MessagePart):string{return p.url??`data:${p.mediaType??(string((p as unknown as JsonObject).mimeType)||'image/png')};base64,${p.data??''}`;}
function omitted(p:MessagePart,req:ProviderRequest):string {
  const offered=req.capabilities.tools&&req.tools.some(t=>t.name==='look_at_image');
  return `[${p.type} ${p.attachmentId??''} omitted${offered?'; use look_at_image to inspect it':''}]`;
}
/** OpenRouter OpenAI-chat wire request with usage accounting always enabled. */
export function buildProviderRequest(raw:ProviderRequest):JsonObject {
  const req=ProviderRequestSchema.parse(raw),c=req.capabilities;
  const system=req.system+(!c.tools?'\n[Tool use is unavailable for this request. Do not call tools.]':'');
  const effort=c.reasoningEffort?clampEffort(req.effort,req.supportedEfforts):undefined;
  {
    const messages:JsonObject[]=[];if(system)messages.push({role:'system',content:system});
    for(const m of req.messages) {
      if(m.role==='assistant') {
        if(c.tools&&m.raw&&object(m.raw.data).role==='assistant') {
          const raw=structuredClone(object(m.raw.data));raw.role='assistant';
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
        }else if(p.type==='note'&&c.midConversationSystem)notes.push({role:'system',content:p.text??''});
        else if(p.type==='image')content.push(c.vision?{type:'image_url',image_url:{url:mediaUrl(p)}}:text(omitted(p,req)));
        else if(p.type==='document'&&c.documents&&p.data)content.push({type:'file',file:{filename:p.attachmentId??'document.pdf',file_data:mediaUrl(p)}});
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
    const body:JsonObject={model:req.model,messages,stream:true,max_tokens:req.maxTokens,usage:{include:true}};
    if(c.tools&&req.tools.length){body.tools=req.tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}));body.parallel_tool_calls=c.parallelToolCalls;}
    if(effort)body.reasoning={effort};return body;
  }
}
