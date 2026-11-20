import {type Capabilities, type JsonObject, type JsonValue, type MessagePart} from '@praxis/protocol';
import {ProviderRequestSchema, type ProviderRequest} from './types.js';
import {groupByEnvelope, toModelMessages, type ModelMessage} from './model-messages.js';
export function object(value:unknown):JsonObject {return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{};}
export function array(value:unknown):JsonValue[]{return Array.isArray(value)?value:[];}
export function string(value:unknown):string{return typeof value==='string'?value:'';}
export function number(value:unknown):number{return typeof value==='number'&&Number.isFinite(value)?value:0;}
const text=(value:string):JsonObject=>({type:'text',text:value});
const note=(p:MessagePart)=>`[Note]\n${p.text??''}`;
const flattenCall=(p:MessagePart)=>`[Tool call ${p.name??''} ${p.callId??''}] ${p.arguments??'{}'}`;
const resultText=(p:MessagePart)=>`${p.isError?'Error: ':''}${(p.content??[]).map(c=>c.type==='image'?`[Image ${string(c.attachmentId)}]`:string(c.text)||JSON.stringify(c)).join('\n')||'(no output)'}`;
function mediaUrl(p:MessagePart):string{return p.url??`data:${p.mediaType??(string((p as unknown as JsonObject).mimeType)||'image/png')};base64,${p.data??''}`;}
function omitted(p:MessagePart,req:ProviderRequest):string {
  const offered=req.capabilities.tools&&req.tools.some(t=>t.name==='look_at_image');
  return `[${p.type} ${p.attachmentId??''} omitted${offered?'; use look_at_image to inspect it':''}]`;
}

/** Wire messages for one stored message; user-side content collects here and is flushed after the group. */
interface GroupOutput {
  messages: JsonObject[];
  content: JsonObject[];
  notes: JsonObject[];
}

function assistantMessage(model: ModelMessage & {kind: 'ai'}, c: Capabilities): JsonObject | undefined {
  const raw = model.envelope.raw;
  // The provider's own assistant object carries reasoning_details (with signatures) that must replay unchanged.
  if (c.tools && raw && object(raw.data).role === 'assistant') {
    const replay = structuredClone(object(raw.data));
    replay.role = 'assistant';
    return replay;
  }
  const calls = model.parts.filter(p => p.type === 'toolCall');
  const txt = model.parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
  if (!txt && !calls.length) return undefined;
  const content = c.tools ? txt || null : [txt, ...calls.map(flattenCall)].filter(Boolean).join('\n');
  const message: JsonObject = {role: 'assistant', content};
  if (c.tools && calls.length) {
    message.tool_calls = calls.map(p => ({
      id: p.callId ?? '', type: 'function', function: {name: p.name ?? '', arguments: p.arguments ?? '{}'},
    }));
  }
  return message;
}

function addToolResult(out: GroupOutput, part: MessagePart, c: Capabilities): void {
  if (c.tools) out.messages.push({role: 'tool', tool_call_id: part.callId ?? '', content: resultText(part)});
  else out.content.push(text(`[Tool result ${part.callId ?? ''}] ${resultText(part)}`));
  for (const item of part.content ?? []) {
    if (item.type === 'image' && c.vision) out.content.push({type: 'image_url', image_url: {url: mediaUrl(item as MessagePart)}});
  }
}

function addHumanPart(out: GroupOutput, p: MessagePart, req: ProviderRequest): void {
  const c = req.capabilities;
  if (p.type === 'note' && c.midConversationSystem) out.notes.push({role: 'system', content: p.text ?? ''});
  else if (p.type === 'image') out.content.push(c.vision ? {type: 'image_url', image_url: {url: mediaUrl(p)}} : text(omitted(p, req)));
  else if (p.type === 'document' && c.documents && p.data) {
    out.content.push({type: 'file', file: {filename: p.attachmentId ?? 'document.pdf', file_data: mediaUrl(p)}});
  } else out.content.push(text(p.type === 'note' ? note(p) : p.text ?? omitted(p, req)));
}

function compact(items: JsonValue[]): JsonValue {
  return items.every(p => object(p).type === 'text') ? items.map(p => string(object(p).text)).join('\n\n') : items;
}

/** Consecutive user-side content shares one wire user message, as providers require alternating roles. */
function flushContent(messages: JsonObject[], content: JsonObject[]): void {
  if (!content.length) return;
  const last = messages.at(-1);
  if (last?.role === 'user') {
    const old = typeof last.content === 'string' ? [text(last.content)] : array(last.content);
    last.content = compact([...old, ...content]);
  } else messages.push({role: 'user', content: compact(content)});
}

function wireMessages(req: ProviderRequest, system: string): JsonObject[] {
  const messages: JsonObject[] = [];
  if (system) messages.push({role: 'system', content: system});
  for (const group of groupByEnvelope(toModelMessages(req.messages))) {
    const out: GroupOutput = {messages, content: [], notes: []};
    for (const model of group) {
      if (model.kind === 'ai') {
        const assistant = assistantMessage(model, req.capabilities);
        if (assistant) messages.push(assistant);
      } else if (model.kind === 'tool') addToolResult(out, model.part, req.capabilities);
      else for (const part of model.parts) addHumanPart(out, part, req);
    }
    messages.push(...out.notes);
    flushContent(messages, out.content);
  }
  return messages;
}

/** OpenRouter OpenAI-chat wire request with usage accounting always enabled. */
export function buildProviderRequest(raw: ProviderRequest): JsonObject {
  const req = ProviderRequestSchema.parse(raw), c = req.capabilities;
  const system = req.system + (!c.tools ? '\n[Tool use is unavailable for this request. Do not call tools.]' : '');
  const effort = c.reasoningEffort ? req.effort : undefined;
  const body: JsonObject = {
    model: req.model, messages: wireMessages(req, system), stream: true, max_tokens: req.maxTokens, usage: {include: true},
  };
  if (c.tools && req.tools.length) {
    body.tools = req.tools.map(t => ({type: 'function', function: {name: t.name, description: t.description, parameters: t.inputSchema}}));
    body.parallel_tool_calls = c.parallelToolCalls;
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (effort) body.reasoning = {effort};
  return body;
}
