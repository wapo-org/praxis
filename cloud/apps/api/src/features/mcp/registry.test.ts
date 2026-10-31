import {it,expect,vi} from 'vitest';
import {createLocalAdapters} from '../../local-memory.js';
import type {FeatureContext} from '../../contracts.js';
import {searchRegistry} from './registry.js';
it('searches official registry over guarded egress, caches per page and excludes stdio/deleted/private remotes',async()=>{
 const egress=vi.fn(async(url:RequestInfo|URL)=>{const u=new URL(String(url));expect(u.pathname).toBe('/v0.1/servers');expect(u.searchParams.get('search')).toBe('test');expect(u.searchParams.get('version')).toBe('latest');return Response.json({servers:[{server:{name:'test',remotes:[{type:'streamable-http',url:'https://example.com/mcp'},{type:'sse',url:'https://example.com/sse'},{type:'stdio',url:'https://example.com'},{type:'sse',url:'http://127.0.0.1/mcp'}]}},{server:{name:'local-only',packages:[{registryType:'npm'}]}},{server:{name:'deleted',remotes:[{type:'sse',url:'https://example.com'}]},_meta:{'io.modelcontextprotocol.registry/official':{status:'deleted'}}}],metadata:{nextCursor:'second'}});});
 const c:FeatureContext={...createLocalAdapters(),userId:'a',local:false,egress,fetch:vi.fn()};const first=await searchRegistry(c,{q:'test'});expect(first.items).toMatchObject([{input:{type:'connector.input',transport:'streamableHttp'}},{input:{transport:'sse'}}]);expect(first.nextCursor).toBe('second');await searchRegistry(c,{q:'test'});expect(egress).toHaveBeenCalledTimes(1);await searchRegistry(c,{q:'test',cursor:'second'});expect(egress).toHaveBeenCalledTimes(2);
});
