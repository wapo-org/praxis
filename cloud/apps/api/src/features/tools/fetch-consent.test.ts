import {it,expect,vi} from 'vitest';
import {runSandbox} from './sandbox.js';
import {createLocalAdapters} from '../../local-memory.js';
import type {FeatureContext} from '../../contracts.js';
it('fetches Hacker News after inline consent and propagates durable parking instead of a JS error',async()=>{
 const ctx:FeatureContext={...createLocalAdapters(),local:true,userId:'u',fetch,egress:vi.fn(async()=>Response.json([1,2,3]))};
 const files={list:async()=>[],read:async()=>new Uint8Array()};const args={code:"const r=await fetch('https://hacker-news.firebaseio.com/v0/newstories.json');return await r.json();"};
 const parked=new Error('durable park');const run={chatId:'c',runId:'r',mode:'build' as const,elicit:vi.fn(async()=>{throw parked;})};
 await expect(runSandbox(args,ctx,run,files,[])).rejects.toBe(parked);expect(ctx.egress).not.toHaveBeenCalled();
 const elicit=vi.fn(async()=>({type:'elicitation.response' as const,elicitationId:'e',action:'accept' as const,content:{allow:true}}));
 expect(await runSandbox(args,ctx,{...run,elicit},files,[])).toMatchObject({result:[1,2,3]});expect(elicit).toHaveBeenCalledOnce();
});
