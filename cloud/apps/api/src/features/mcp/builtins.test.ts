import {expect,it,vi} from 'vitest';
import {BUILTINS,ensureBuiltins,builtinCatalog} from './builtins.js';
import {createLocalAdapters} from '../../local-memory.js';
import type {FeatureContext} from '../../contracts.js';
import {ConnectorSchema} from '@praxis/protocol';
import {requireConsent,returnTarget} from './shared.js';
import {connectorToolNotes} from '../tools/tool-notes.js';
import {getMcpTools,catalogKey} from './tools.js';
it('installs disabled defaults once per owner, preserving deletions',async()=>{
 const {store}=createLocalAdapters();await Promise.all([ensureBuiltins(store,'u'),ensureBuiltins(store,'u')]);
 const rows=await store.list('u','connector');expect(rows).toHaveLength(4);expect(rows.every(r=>r.value.enabled===false)).toBe(true);
 await store.delete('u','connector','builtin-exa');await ensureBuiltins(store,'u');expect((await store.get('u','connector','builtin-exa'))?.deleted).toBe(true);
 await ensureBuiltins(store,'v');expect(await store.list('v','connector')).toHaveLength(4);
});
it('advertises enabled tools for every connector combination',async()=>{
 const ctx:FeatureContext={...createLocalAdapters(),userId:'u',local:true,fetch,egress:fetch};await ensureBuiltins(ctx.store,'u');await ctx.store.put('u','chat','c',{disabledConnectorIds:[]});
 for(let mask=0;mask<16;mask++) {
  for(const [i,b] of BUILTINS.entries()) {
   const value=ConnectorSchema.parse((await ctx.store.get('u','connector',b.id))!.value),next={...value,enabled:!!(mask&(1<<i))};await ctx.store.put('u','connector',b.id,next);
   await ctx.kv.set(catalogKey(ctx,b.id),{url:next.url,transport:next.transport,tools:builtinCatalog(next),resources:true});
  }
  const tools=await getMcpTools(ctx,{chatId:'c',disabledConnectorIds:[]}),notes=connectorToolNotes(tools).join('\n');
  for(const [i,b] of BUILTINS.entries())expect(notes.includes(`${b.name} (MCP connector)`)).toBe(!!(mask&(1<<i)));
  expect(tools.some(t=>t.name.includes('resources'))).toBe(false);
  expect(tools.some(t=>t.description==='Exa: web_fetch_exa')).toBe(false);
  expect(tools.some(t=>t.description==='Firecrawl: firecrawl_search')).toBe(false);
 }
});
it('resumes host consent inline and records it',async()=>{
 const ctx:FeatureContext={...createLocalAdapters(),userId:'u',local:true,fetch,egress:fetch};const value={url:'https://example.com/mcp'} as import('@praxis/protocol').Connector;
 const elicit=vi.fn(async()=>({type:'elicitation.response' as const,elicitationId:'e',action:'accept' as const,content:{allow:true}}));
 await requireConsent(ctx,value,{chatId:'c',runId:'r',mode:'build',elicit});expect(elicit).toHaveBeenCalledWith(expect.objectContaining({message:'Allow example.com'}));
 await requireConsent(ctx,value);expect((await ctx.store.get('u','consent','example.com'))?.value.allowed).toBe(true);
});
it.each(['localhost','127.0.0.1','[::1]'])('allows only development loopback returns: %s',host=>{
 vi.stubEnv('NODE_ENV','test');const url=`http://${host}:5251/callback`,options={webReturnOrigins:[new URL(url).origin]};
 expect(returnTarget(url,options)).toBe(url);expect(()=>returnTarget(url,{})).toThrow();vi.stubEnv('NODE_ENV','production');expect(()=>returnTarget(url,options)).toThrow();vi.unstubAllEnvs();
});
it('stores builtin keys encrypted and never echoes them through connector APIs',async()=>{
 const {createMcpRoutes}=await import('./index.js');const {Hono}=await import('hono');
 const ctx:FeatureContext={...createLocalAdapters(),userId:'u',local:true,fetch,egress:fetch,encryptionKey:Buffer.alloc(32,4).toString('base64')};await ensureBuiltins(ctx.store,'u');
 const app=new Hono().route('/v1',createMcpRoutes(async()=>ctx));
 const response=await app.request('/v1/connectors/builtin-e2b',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({type:'connector.patch',token:'fixture-private-key'})});
 expect(response.ok).toBe(true);expect(await response.text()).not.toContain('fixture-private-key');expect(JSON.stringify(await ctx.store.get('u','mcpSecret','builtin-e2b'))).not.toContain('fixture-private-key');
});
it('keeps a compact connector brief when every tool is disabled',async()=>{
 const ctx:FeatureContext={...createLocalAdapters(),userId:'u',local:true,fetch,egress:fetch};await ensureBuiltins(ctx.store,'u');
 const value=ConnectorSchema.parse((await ctx.store.get('u','connector','builtin-exa'))!.value);
 expect(connectorToolNotes([],[{...value,enabled:true}]).join('\n')).toContain('Enabled tools: none');
});
it('reports E2B as needing credentials until a key is configured',async()=>{
 const {probeConnector}=await import('./health.js');const ctx:FeatureContext={...createLocalAdapters(),userId:'u',local:true,fetch,egress:fetch};await ensureBuiltins(ctx.store,'u');
 const value=ConnectorSchema.parse((await ctx.store.get('u','connector','builtin-e2b'))!.value);
 expect(await probeConnector(ctx,{...value,enabled:true})).toMatchObject({status:'needs_auth'});
});
