import {it,expect} from 'vitest';
import {createPraxisApp} from '../server.js';
import {createLocalAdapters} from '../local-memory.js';
it('pages the complete 537-model OpenRouter catalogue',async()=>{
 const {app}=createPraxisApp({adapters:createLocalAdapters(),local:true,fetcher:async()=>Response.json({data:Array.from({length:537},(_,i)=>({id:`model-${i}`,context_length:128000}))})});
 const ids:string[]=[];
 let cursor:string|null=null;
 do {
  const query=new URLSearchParams({limit:'100',q:'model-'});
  if(cursor)query.set('cursor',cursor);
  const response=await app.request(`/v1/models?${query}`,{headers:{Authorization:'Bearer dev-local'}});
  expect(response.ok).toBe(true);
  const page=await response.json();ids.push(...page.items.map((m:{id:string})=>m.id));cursor=page.nextCursor;
 }while(cursor);
 expect(new Set(ids).size).toBe(537);
});
