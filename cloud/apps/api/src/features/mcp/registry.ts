import {z} from 'zod';
import {ConnectorInputSchema,type JsonObject} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import {publicFetch} from '../tools/http.js';
import {McpError,remoteUrl} from './shared.js';
const Query=z.object({q:z.string().max(500).optional(),cursor:z.string().max(4000).optional()});
const Remote=z.object({type:z.string(),url:z.string().max(8000),headers:z.array(z.object({name:z.string(),value:z.string().optional(),isSecret:z.boolean().optional()})).default([])});
const Listing=z.object({servers:z.array(z.object({server:z.object({name:z.string().max(500),title:z.string().optional(),description:z.string().optional(),remotes:z.array(Remote).default([])}),_meta:z.record(z.string(),z.unknown()).optional()})).max(1000),metadata:z.object({nextCursor:z.string().max(4000).optional()}).optional()});
export async function searchRegistry(ctx:FeatureContext,query:Record<string,string>):Promise<JsonObject>{
 const q=Query.parse(query),key=JSON.stringify(['mcp-registry',ctx.userId,q]);const cached=await ctx.kv.get<JsonObject>(key);if(cached)return cached;
 const url=new URL('https://registry.modelcontextprotocol.io/v0.1/servers');url.searchParams.set('version','latest');url.searchParams.set('limit','50');if(q.q)url.searchParams.set('search',q.q);if(q.cursor)url.searchParams.set('cursor',q.cursor);
 const {response,bytes}=await publicFetch(ctx,url.href,{headers:{Accept:'application/json'}},false,8<<20);
 if(!response.ok)throw new McpError(502,'registry_failed','MCP registry request failed');
 const listing=Listing.parse(JSON.parse(new TextDecoder().decode(bytes)));const items=[];
 for(const entry of listing.servers){
  if((entry._meta?.['io.modelcontextprotocol.registry/official'] as {status?:string}|undefined)?.status==='deleted')continue;
  for(const remote of entry.server.remotes){
   if(!['streamable-http','sse'].includes(remote.type))continue;
   try{
    // Templates remain visible for clients to fill before POST /connectors; creation owns validation and health checks.
    remoteUrl(remote.url.replace(/\{[^{}]+\}/g,'x'),false);
    const input=ConnectorInputSchema.parse({type:'connector.input',name:entry.server.title??entry.server.name,url:remote.url,transport:remote.type==='sse'?'sse':'streamableHttp',enabled:true});
    items.push({type:'connector.registry.entry',id:entry.server.name,description:entry.server.description??'',input,headerNames:remote.headers.map(h=>h.name),requiresConfiguration:/\{[^{}]+\}/.test(remote.url)||remote.headers.length>0});
   }catch{/* Unusable/non-public remote entries are excluded. */}
  }
 }
 const result={type:'page',items,nextCursor:listing.metadata?.nextCursor||null};await ctx.kv.set(key,result,600);return result;
}
