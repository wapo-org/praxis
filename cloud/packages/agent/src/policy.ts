import type { Mode, ToolSpec } from '@praxis/protocol';
import type { Policy } from './types.js';
export type ToolDecision={decision:'allow'|'ask'|'refuse';reason:string};
export function sourceKey(tool:ToolSpec):string {
  return tool.source.type==='mcp'?`mcp:${tool.source.serverId ?? ''}`:tool.source.type;
}
export function canonical(value:unknown):string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export async function fingerprint(value:unknown):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function alwaysAllowKey(tool:ToolSpec):Promise<string> {
  return `${sourceKey(tool)}/${tool.name}#${await fingerprint({description:tool.description,inputSchema:tool.inputSchema})}`;
}
export function decideTool(tool: ToolSpec, mode: Mode, policy: Policy, _key: string): ToolDecision {
  const trusted = tool.source.type !== 'mcp' || policy.trustedSources.includes(sourceKey(tool));
  const readOnly = trusted && tool.traits.includes('readOnly') &&
    !tool.traits.includes('destructive') && !tool.traits.includes('openWorld');
  if (mode === 'ask' && (tool.source.type === 'mcp' || tool.traits.includes('sandboxed'))) {
    return {decision: 'refuse', reason: 'This tool is unavailable in Ask mode.'};
  }
  if (readOnly) return {decision: 'allow', reason: ''};
  if (mode === 'ask' || mode === 'plan') {
    return {decision: 'refuse', reason: mode === 'plan' ? 'Plan mode only runs read-only tools.' : 'Ask mode only runs read-only tools.'};
  }
  return {decision: 'ask', reason: 'This tool may change data or send it to an outside service.'};
}
