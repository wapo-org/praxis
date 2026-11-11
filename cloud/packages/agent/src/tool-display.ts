import type {JsonValue, ToolSpec} from '@praxis/protocol';

const clean = (s: string) => s.replace(/mcp__/gi, '').replace(/_[a-f0-9]{8,}\b/gi, '').replace(/__/g, ' ').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
const labels: Record<string,string> = {run_javascript:'Run code',load_skill:'Load skill',read_skill_file:'Read skill file',ask_user:'Ask a question',read_tool_output:'Read tool output',mcp_search_tools:'Find connector tools',mcp_describe_tool:'Describe connector tool',mcp_call_tool:'Call connector tool'};
export function toolDisplay(name: string, spec?: ToolSpec, args?: JsonValue) {
  const connectorName = spec?.source.serverName;
  const raw = clean(spec?.originalName ?? name);
  const action = connectorName ? raw.replace(new RegExp('^'+connectorName.replace(/[^a-z0-9]/gi,'')+' ','i'),'') : raw;
  const title = labels[name] ?? (connectorName ? connectorName+' '+action : action.charAt(0).toUpperCase()+action.slice(1));
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  // Never use code, tokens, arbitrary values, or qualified tool names as a subtitle.
  const value = ['query','url','name','path'].map(k => obj[k]).find(v => typeof v === 'string' && !v.includes('{{secret:') && !v.includes('mcp__'));
  return {title: title.slice(0,60), ...(typeof value === 'string' ? {detail:value.slice(0,60)} : {}),
    ...(spec?.source.serverId ? {connectorId:spec.source.serverId} : {}), ...(connectorName ? {connectorName} : {}),
    icon:connectorName ? 'Plug' : name==='run_javascript' ? 'Code' : name==='load_skill' ? 'BookOpen' : 'Wrench'};
}
