import {ConnectorSchema, type Connector, type JsonObject} from '@praxis/protocol';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import type {FeatureContext} from '../../contracts.js';
import {McpError, readSecret} from './shared.js';

export const BUILTINS = [
  {id:'builtin-exa',name:'Exa',url:'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa',disabledTools:['web_fetch_exa','web_search_advanced_exa','agent_run','get_code_context_exa','crawling_exa','company_research_exa','linkedin_search_exa','deep_researcher_start','deep_researcher_check'],tools:['web_search_exa','web_fetch_exa','web_search_advanced_exa','agent_run'],brief:'Search current web sources with Exa; fetch known URLs, use advanced search for filters, agent_run for multi-step research (requires a key). Cite sources. Prefer ordinary search for simple queries; avoid research for local calculations.'},
  {id:'builtin-firecrawl',name:'Firecrawl',url:'https://mcp.firecrawl.dev/v2/mcp',disabledTools:['firecrawl_search'],tools:['firecrawl_search','firecrawl_scrape','firecrawl_parse','firecrawl_map','firecrawl_crawl','firecrawl_check_crawl_status','firecrawl_find_tools','firecrawl_agent','firecrawl_agent_status','firecrawl_interact','firecrawl_interact_stop'],brief:'Scrape one URL (JSON format for extraction); map discovers URLs; crawl traverses a section, check_crawl_status resumes. Parse documents; agent/status researches unknown sources; interact/stop handles dynamic pages. Alexandria: find_tools discovers typed provider contracts, scrape with alexandria executes (up to 10); needs auth, per-tool credits, admin accepts terms. Search/research/developer/gov indexes find sources; monitor tools schedule checks. Set small crawl limits; close sessions. Keyless: scrape/parse/search only. Avoid crawling when one scrape suffices.'},
  {id:'builtin-e2b',name:'E2B',url:'https://api.e2b.dev',disabledTools:[],tools:['run_code'],brief:'Offload Python, installs, large files, archives over attachment limits, and long/heavy compute to E2B Linux sandboxes. run_code creates a short-lived sandbox and always destroys it. Use run_javascript for small browser-compatible calculations; do not send secrets or assume browser attachments are mounted. Return compact results.'},
  {id:'builtin-browserbase',name:'Browserbase',url:'https://mcp.browserbase.com/mcp',disabledTools:[],tools:['start','end','navigate','observe','act','extract'],brief:'Use a hosted browser for interactive pages, forms and dynamic extraction. Start a session, pass sessionId on every subsequent call, navigate/observe/act/extract, then end to release it. Prefer search or scrape for static content; do not leave sessions running.'},
] as const;
export const builtin = (value: Pick<Connector,'id'>) => BUILTINS.find(b=>b.id===value.id);
/** Atomic, server-owned defaults; a tombstone means the user removed it, never resurrect it. */
export async function ensureBuiltins(store: FeatureContext['store'],userId:string) {
  for(const b of BUILTINS) {
    if(await store.get(userId,'connector',b.id))continue;
    const value=ConnectorSchema.parse({type:'connector',id:b.id,name:b.name,url:b.url,transport:'streamableHttp',enabled:false,trusted:true,disabledTools:[...b.disabledTools],authStatus:'none',updatedAt:new Date().toISOString()});
    await store.putIfRevision(userId,'connector',b.id,value as JsonObject,0);
  }
}
/** Offline settings catalog; actual remote schemas always come from MCP before model exposure. */
export function builtinCatalog(value:Connector):Tool[]|undefined {
  const b=builtin(value);if(!b)return undefined;
  return b.tools.map(name=>({name,description:b.id==='builtin-e2b'?'Run Python or JavaScript in a temporary Linux sandbox.':'Connect to discover the current tool schema and description.',inputSchema:b.id==='builtin-e2b'?{type:'object' as const,properties:{code:{type:'string'},language:{type:'string',enum:['python','javascript']}},required:['code']}:{type:'object' as const}}));
}
export async function runE2B(ctx:FeatureContext,value:Connector,args:JsonObject) {
  const key=await readSecret<string>(ctx,value.id,'token');
  if(!key)throw new McpError(409,'authorization_required','Add your E2B API key in connector settings');
  const {Sandbox}=await import('@e2b/code-interpreter');
  const sandbox=await Sandbox.create({apiKey:key,timeoutMs:60_000}).catch(()=>{throw new McpError(502,'mcp_failed','The E2B sandbox could not be created');});
  try {
    const result=await sandbox.runCode(String(args.code),{language:args.language==='javascript'?'javascript':'python',timeoutMs:50_000});
    return JSON.parse(JSON.stringify({logs:result.logs,results:result.results,error:result.error})) as JsonObject;
  } catch {throw new McpError(502,'mcp_failed','The E2B code execution failed');}
  finally {await sandbox.kill().catch(()=>{});}
}
