import {BUILTINS} from '../mcp/builtins.js';
import type {Connector} from '@praxis/protocol';
import type {FeatureTool} from '../../contracts.js';
/** Connector descriptions are deliberately excluded: they are untrusted text. */
export function connectorToolNotes(tools:FeatureTool[],enabled:Connector[]=[]):string[] {
 const servers=new Map<string,{name:string;count:number;names:string[]}>();
 for(const c of enabled)servers.set(c.id,{name:c.name,count:0,names:[]});
 for(const t of tools){if(t.source.type!=='mcp'||!t.source.serverId)continue;const id=t.source.serverId;const s=servers.get(id)??{name:t.source.serverName??id,count:0,names:[]};s.count++;s.names.push(t.name);servers.set(id,s);}
 if(!servers.size)return [];
 return [...servers.entries()].map(([id,s])=>`${s.name} (MCP connector): ${BUILTINS.find(b=>b.id===id)?.brief??'Use these connector tools for tasks in this service.'} Enabled tools: ${s.names.length<=4 ? [...s.names].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join(', ')||'none (all tools disabled or unavailable)' : s.count+' available; relevant definitions are callable directly; catalogue for the long tail'}.`).concat('Code run with run_javascript can call connector tools as tools[toolName](args); use it to chain or batch calls.');
}
