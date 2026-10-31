import {it,expect} from 'vitest';
import {createPraxisApp} from '../server.js';
import {createLocalAdapters} from '../local-memory.js';
import {localModules} from '../modules.js';
it('allows configured cross-origin local preflight and authenticated PUT through an upload ticket',async()=>{
 const {app}=createPraxisApp({adapters:createLocalAdapters(),local:true,allowedOrigins:['https://web.example'],modules:localModules('http://localhost:8820')});
 const headers={Authorization:'Bearer dev-local','Content-Type':'application/json',Origin:'https://web.example'};
 const ticket=await (await app.request('/v1/uploads',{method:'POST',headers,body:JSON.stringify({type:'upload.request',name:'a.txt',mediaType:'text/plain',size:2})})).json();
 const preflight=await app.request(ticket.uploadUrl,{method:'OPTIONS',headers:{Origin:headers.Origin,'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization,content-type'}});
 expect(preflight.status).toBe(204);expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(headers.Origin);expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
 const uploaded=await app.request(ticket.uploadUrl,{method:'PUT',headers:{...headers,'Content-Type':'text/plain'},body:'ok'});expect(uploaded.status).toBe(200);expect(uploaded.headers.get('Access-Control-Allow-Origin')).toBe(headers.Origin);
 const denied=await app.request(ticket.uploadUrl,{method:'OPTIONS',headers:{Origin:'https://evil.example','Access-Control-Request-Method':'PUT'}});expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
 const {app:production}=createPraxisApp({adapters:createLocalAdapters(),local:false,allowedOrigins:['https://web.example']});const prod=await production.request('/v1/uploads/content/a',{method:'OPTIONS',headers:{Origin:headers.Origin,'Access-Control-Request-Method':'PUT'}});expect(prod.headers.get('Access-Control-Allow-Methods')).not.toContain('PUT');
});
