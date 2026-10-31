// Test-only upstreams. The UI talks to real local API routes; upstream network is deterministic.
import { createHash } from 'node:crypto';
let version=1;
export function advance(){version++;}
export const fixtureFetch:typeof fetch=async(input,init)=>{
 const url=new URL(String(input));
 if(url.hostname==='registry.modelcontextprotocol.io')return Response.json({servers:[{server:{name:'test/docs',title:'X1 Docs',description:'Deterministic MCP fixture',remotes:[{type:'streamable-http',url:'https://example.com/x1/mcp'}]}},{server:{name:'test/keyed',title:'X1 Keyed Docs',description:'Needs an API key header',remotes:[{type:'streamable-http',url:'https://example.com/x1/keyed-mcp',headers:[{name:'X-Api-Key',isSecret:true}]}]}}],metadata:{}});
 if(url.pathname==='/x1/skills'){const document=`---\nname: x1-registry\ndescription: Registry fixture\n---\nVersion ${version}`;return Response.json([{id:'entry',name:'x1-registry',document,digest:`sha256:${createHash('sha256').update(document).digest('hex')}`}]);}
 if(url.pathname==='/x1/keyed-mcp'&&new Headers(init?.headers).get('x-api-key')!=='k-123')return new Response('missing key',{status:401});
 if(url.pathname==='/x1/mcp'||url.pathname==='/x1/keyed-mcp'){
  const req=JSON.parse(String(init?.body||'{}'));
  if(req.method==='notifications/initialized')return new Response(null,{status:202});
  return Response.json({jsonrpc:'2.0',id:req.id,result:req.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'x1',version:'1'}}:req.method==='tools/list'?{tools:[]}:{} });
 }
 // A provider whose key is refused: the probe must report the real failure, never success.
 if(url.pathname==='/x1bad/v1/chat/completions')return Response.json({error:{message:'Invalid API key provided'}},{status:401});
 if(url.pathname.endsWith('/models'))return Response.json({data:[{id:'x1-model',object:'model',owned_by:'test'}]});
 if(url.pathname.endsWith('/chat/completions')){const body=JSON.parse(String(init?.body)),tool=!!body.tools;return new Response(`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'c',function:{name:'probe_echo',arguments:'{"value":"ping"}'}}]}:{content:'ok'}}]})}\n\ndata: ${JSON.stringify({choices:[{finish_reason:tool?'tool_calls':'stop',delta:{}}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});}
 throw Error(`Unexpected X1 upstream ${url}`);
};
