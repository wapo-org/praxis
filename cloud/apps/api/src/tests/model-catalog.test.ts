import {it,expect} from 'vitest';
import {createPraxisApp} from '../server.js';
import {createLocalAdapters} from '../local-memory.js';
it('returns all 537 refreshed models and bootstraps the complete catalog',async()=>{
 const {app}=createPraxisApp({adapters:createLocalAdapters(),local:true,fetcher:async()=>Response.json({data:Array.from({length:537},(_,i)=>({id:`model-${i}`}))})});
 const req=(path:string,body?:unknown)=>app.request(`/v1${path}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer dev-local','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const provider=await(await req('/providers',{type:'provider.input',name:'Many',baseUrl:'https://example.com/v1',flavor:'openAIChat'})).json();
 const result=await(await req(`/providers/${provider.id}/refresh-models`,{type:'models.refresh'})).json();expect(result.items).toHaveLength(537);expect(result.nextCursor).toBeNull();
 const boot=await(await req('/bootstrap')).json();expect(boot.models.filter((m:{providerId:string})=>m.providerId===provider.id)).toHaveLength(537);
});
