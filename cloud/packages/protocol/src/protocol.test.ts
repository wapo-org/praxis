import { describe,it,expect } from 'vitest';
import { StartRunSchema,RunEventSchema,ProviderInputSchema,CapabilitiesSchema } from './index.js';
describe('plain JSON protocol',()=>{
 it('defaults local run options and rejects invalid modes',()=>{expect(StartRunSchema.parse({type:'run.start',chatId:'c'}).text).toBe('');expect(StartRunSchema.safeParse({type:'run.start',chatId:'c',mode:'admin'}).success).toBe(false);});
 it('round trips discriminated nested approvals',()=>{const e={type:'run.event',id:1,runId:'r',chatId:'c',createdAt:"2026-10-29T14:00:00.000Z",event:{type:'approval.requested',approval:{type:'approval',id:'a',callId:'t',toolName:'delete',source:{type:'mcp',serverId:'s'},arguments:{id:3},reason:'Destructive',title:'Delete',parentCallId:'js'}}};expect(RunEventSchema.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);});
 it('requires valid IDs and known event payloads',()=>{expect(RunEventSchema.safeParse({type:'run.event',id:0,event:{type:'secret'}}).success).toBe(false);});
 it('defaults conservative capabilities and validates provider input',()=>{expect(CapabilitiesSchema.parse({}).vision).toBe(false);expect(ProviderInputSchema.safeParse({type:'provider.input',name:'custom',flavor:'openAIChat',baseUrl:'oops'}).success).toBe(false);});
});
