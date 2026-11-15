import {createServer} from 'node:http';
import {it,expect} from 'vitest';
import {CapabilitiesSchema,type JsonObject} from '@praxis/protocol';
import {AgentRunner,OPENROUTER_API_BASE,createOpenRouterProvider,scriptedTools,type AgentCheckpoint} from './index.js';
const frame=(data:unknown)=>`data: ${JSON.stringify(data)}\n\n`;
it('runs a complete model→tool→model turn through real HTTP on the chat completions path',async()=>{
  const seenBodies:JsonObject[]=[];
  const server=createServer(async(req,res)=>{
    try{
      let text='';for await(const chunk of req)text+=String(chunk);const body=JSON.parse(text) as JsonObject;const turn=seenBodies.length;seenBodies.push(body);
      expect(req.url).toBe('/api/v1/chat/completions');expect(req.headers.authorization).toBe('Bearer local-only');res.setHeader('content-type','text/event-stream');
      res.write(frame({choices:[{index:0,delta:turn===0?{tool_calls:[{index:0,id:'call-b',type:'function',function:{name:'local_echo',arguments:'{}'}}]}:{content:'HTTP complete'},finish_reason:turn===0?'tool_calls':'stop'}]}));
      res.write(frame({choices:[{index:0,delta:{content:''},finish_reason:turn===0?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:5,cost:0.001}}));res.end('data: [DONE]\n\n');
    }catch(error){res.destroy(error instanceof Error?error:undefined);}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(8788,'127.0.0.1',resolve);});
  try{
    // Redirects the pinned OpenRouter URL to the local test server.
    const toLocal=((url,init)=>fetch(String(url).replace(new URL(OPENROUTER_API_BASE).origin,'http://127.0.0.1:8788'),init)) as typeof fetch;
    const provider=createOpenRouterProvider({apiKey:'local-only',capabilities:CapabilitiesSchema.parse({tools:true})},toLocal);let last:AgentCheckpoint|undefined;let eventId=0;
    const runner=new AgentRunner({provider,tools:scriptedTools(),ports:{save:async(user,cp)=>{expect(user).toBe('http-user');last=structuredClone(cp);},emit:async()=>++eventId,isCancelled:async()=>false}});
    const time=new Date().toISOString();const cp=await runner.run({userId:'http-user',run:{type:'run',id:'r-http',chatId:'http-chat',status:'queued',createdAt:time,updatedAt:time,lastEventId:0,clientTurnId:'client-turn'},chat:{type:'chat',id:'http-chat',title:'HTTP',pinned:false,mode:'build',connectorIds:[],disabledConnectorIds:[],createdAt:time,updatedAt:time},modelId:'local-model',messages:[{type:'message',id:'user',chatId:'http-chat',role:'user',parts:[{type:'text',text:'Use the echo tool'}],createdAt:time,updatedAt:time}]});
    expect(cp.run.outcome).toBe('completed');expect(last?.run.status).toBe('completed');expect(cp.messages).toHaveLength(4);expect(cp.messages.at(-1)?.parts[0]?.text).toBe('HTTP complete');expect(cp.messages.at(-1)?.clientTurnId).toBe('client-turn');
    expect(seenBodies).toHaveLength(2);expect(seenBodies[0]?.usage).toEqual({include:true});expect(cp.usage.cost).toBeCloseTo(0.002,10);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
