import type {FeatureTool} from '../../contracts.js';
/** Connector descriptions are deliberately excluded: they are untrusted text. */
export function connectorToolNotes(tools:FeatureTool[]):string[] {
 const servers=new Map<string,{name:string;count:number}>();
 for(const t of tools){if(t.source.type!=='mcp'||!t.source.serverId)continue;const id=t.source.serverId;const s=servers.get(id)??{name:t.source.serverName??id,count:0};s.count++;servers.set(id,s);}
 if(!servers.size)return [];
 return [...servers.values()].map(s=>`${s.name} (MCP connector): ${s.count} tool${s.count===1?'':'s'}.`).concat('Code run with run_javascript can call connector tools as tools.<server>.<tool>(args); use it to chain or batch calls.');
}
