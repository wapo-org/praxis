import type { Mode, ToolSpec } from '@praxis/protocol';
import type { Policy } from './types.js';
export type ToolDecision={decision:'allow'|'ask'|'refuse';reason:string};
export function sourceKey(tool:ToolSpec):string {
  return tool.source.type==='mcp'?`mcp:${tool.source.serverId ?? ''}`:tool.source.type;
}
export function canonical(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value && typeof value==='object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function fingerprint(value:unknown):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function alwaysAllowKey(tool:ToolSpec):Promise<string> {
  return `${sourceKey(tool)}/${tool.name}#${await fingerprint({description:tool.description,inputSchema:tool.inputSchema})}`;
}
export function decideTool(tool:ToolSpec,mode:Mode,policy:Policy,key:string):ToolDecision {
  const traits=new Set(tool.source.type==='mcp'&&!policy.trustedSources.includes(sourceKey(tool))?['destructive','openWorld']:tool.traits);
  const destructive=traits.has('destructive'),readOnly=traits.has('readOnly');
  const allowed:ToolDecision={decision:'allow',reason:''};
  const ask=(reason:string):ToolDecision=>({decision:policy.alwaysAllow.includes(key)?'allow':'ask',reason});
  const refuse=(reason:string):ToolDecision=>({decision:'refuse',reason});
  if(tool.source.type==='skill'&&!readOnly) {
    if(mode==='ask'||mode==='plan')return refuse('This mode does not change skills. Propose the change instead.');
    return mode==='auto'&&!destructive?allowed:ask(destructive?'Replaces or deletes a skill':'Saves a new skill');
  }
  if(['builtin','skill','server'].includes(tool.source.type))return allowed;
  if(traits.has('sandboxed'))return mode==='ask'?refuse('Running code is unavailable in Ask mode.'):allowed;
  if(mode==='ask')return refuse('Tools that reach other services are unavailable in Ask mode.');
  if(mode==='plan')return readOnly&&!destructive?allowed:refuse('Plan mode only runs read-only tools.');
  if(mode==='build'&&readOnly&&!destructive)return allowed;
  if(mode==='auto'&&!destructive)return allowed;
  return ask(destructive?'May change or delete data':'Makes changes');
}
