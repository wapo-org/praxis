import {writeFile,mkdir} from 'node:fs/promises';
import {TOOL_BRIEFS} from '../tool-briefs.js';
import {buildSystemPrompt} from '../conversation.js';
const dir=process.env.CAPTURE_DIR!;
await mkdir(dir,{recursive:true});
const briefs=Object.entries(TOOL_BRIEFS).flatMap(([connector,tools])=>Object.entries(tools).map(([name,description])=>({connector,name,description})));
const text=buildSystemPrompt({toolNotes:briefs.map(t=>t.connector+' '+t.name+': '+t.description)});
await writeFile(dir+'/system-prompt-sample.txt',text+'\n\nBrief-only token estimate: '+Math.ceil(briefs.map(t=>t.description).join('\n').length/4)+'\nSystem sample token estimate: '+Math.ceil(text.length/4)+'\nMethod: characters/4; not provider tokenizer. Schemas excluded.\n');
const {setup,toolCall}=await import('./harness.js');
const {createExecutionDriver}=await import('../execution.js');
const {featureContext}=await import('../features.js');
const {skillTools}=await import('../features/tools/builtin.js');
const name='mcp__firecrawl__firecrawl_search_bbc9571288db';
const f=setup([toolCall(name,{query:'Praxis news'})]);
const chat=await f.chat();
f.service.driver=createExecutionDriver({service:f.service,fetcher:f.fake.fetcher,features:{tools:async()=>[
 ...skillTools(featureContext(f.service,'local-user')),
 {name,originalName:'firecrawl_search',description:'Find web sources; query, limit. Credits per search.',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']},source:{type:'mcp',serverId:'builtin-firecrawl',serverName:'Firecrawl'},traits:['readOnly'],execute:async()=>({content:[{type:'text',text:'Synthetic source found'}]})},
]}});
const snapshot=await f.run(chat.id,'Search Firecrawl for Praxis news');
const full=(await f.req('/v1/chats/'+chat.id).then(r=>r.json())).setup;
await writeFile(dir+'/first-turn-direct.json',JSON.stringify({firstRequest:f.fake.requests[0],snapshot},null,2));
await writeFile(dir+'/actual-tool-budget.json',JSON.stringify({toolCount:full.tools.length,briefTokens:Math.ceil(full.tools.map((t:any)=>t.description).join('\n').length/4),schemaAndDefinitionsTokens:Math.ceil(JSON.stringify(full.tools).length/4),method:'characters/4, approximate; no remote provider tokenizer'},null,2));
const local=setup();
const localChat=await local.req('/v1/chats',{type:'chat.input',providerId:'scripted',modelId:'scripted'}).then(r=>r.json());
await local.run(localChat.id,'Plan a short Lisbon trip');
await writeFile(dir+'/title-metrics.json',JSON.stringify(await local.service.adapters.store.get('local-user','titleMetric',localChat.id).then(r=>r?.value),null,2));
