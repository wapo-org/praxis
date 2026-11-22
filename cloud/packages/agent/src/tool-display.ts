import {READ_TOOL_OUTPUT_TOOL_NAME, type JsonValue, type ToolSpec} from '@praxis/protocol';

const clean = (s: string) => s.replace(/mcp__/gi, '').replace(/_[a-f0-9]{8,}\b/gi, '').replace(/__/g, ' ').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
const labels: Record<string,string> = {run_javascript:'Run code',load_skill:'Load skill',read_skill_file:'Read skill file',ask_user:'Ask a question',[READ_TOOL_OUTPUT_TOOL_NAME]:'Read tool output',mcp_search_tools:'Find connector tools',mcp_describe_tool:'Describe connector tool',mcp_call_tool:'Call connector tool'};
export function toolDisplay(name: string, spec?: ToolSpec, args?: JsonValue) {
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(spec?.originalName ?? name);
  const connectorName = spec?.source.serverName;
  const serverKey = (connectorName ?? mcp?.[1] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const raw = clean(mcp ? mcp[2]! : (spec?.originalName ?? name));
  const actionParts = raw.split(' ').filter((p, i, arr) => !(serverKey && p.toLowerCase() === serverKey && arr.length > 1 && (i === 0 || i === arr.length - 1)));
  const action = actionParts.join(' ') || raw;
  const prefix = connectorName ?? (mcp ? mcp[1]!.charAt(0).toUpperCase() + mcp[1]!.slice(1) : '');
  const title = labels[name] ?? (prefix ? `${prefix} ${action}` : action.charAt(0).toUpperCase() + action.slice(1));
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  // Never use code, tokens, arbitrary values, or qualified tool names as a subtitle.
  const value = ['query','url','name','path'].map(k => obj[k]).find(v => typeof v === 'string' && !v.includes('{{secret:') && !v.includes('mcp__'));
  return {title: title.slice(0,60), ...(typeof value === 'string' ? {detail:value.slice(0,60)} : {}),
    ...(spec?.source.serverId ? {connectorId:spec.source.serverId} : {}), ...(connectorName ? {connectorName} : {}),
    icon:spec?.source.serverId ? `/v1/connectors/${encodeURIComponent(spec.source.serverId)}/icon` : connectorName ? 'Plug' : name==='run_javascript' ? 'Code' : name==='load_skill' ? 'BookOpen' : 'Wrench'};
}
