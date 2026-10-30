import {createServer} from 'node:http';
import {it,expect} from 'vitest';
import {CapabilitiesSchema,type JsonObject,type ProviderFlavor} from '@praxis/protocol';
import {AgentRunner,createHTTPProvider,scriptedTools,type AgentCheckpoint} from './index.js';
const frame=(data:unknown)=>`data: ${JSON.stringify(data)}\n\n`;
it('runs complete model→tool→model turns through real HTTP for all three API flavors',async()=>{
  const calls=new Map<string,number>(),seenBodies:JsonObject[]=[];
  const server=createServer(async(req,res)=>{
    try{
      if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'local-model'}],has_more:false}));return;}
      let text='';for await(const chunk of req)text+=String(chunk);const body=JSON.parse(text) as JsonObject;seenBodies.push(body);
      const path=req.url??'',turn=calls.get(path)??0;calls.set(path,turn+1);res.setHeader('content-type','text/event-stream');
      if(path.endsWith('/messages')) {
        expect(req.headers['x-api-key']).toBe('local-only');
        res.write(frame({type:'message_start',message:{role:'assistant',content:[],usage:{input_tokens:20,output_tokens:0}}}));
        res.write(frame({type:'content_block_start',index:0,content_block:turn===0?{type:'tool_use',id:'call-a',name:'local_echo',input:{}}:{type:'text',text:''}}));
        res.write(frame({type:'content_block_delta',index:0,delta:turn===0?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text:'HTTP complete'}}));
        res.write(frame({type:'content_block_stop',index:0}));res.write(frame({type:'message_delta',delta:{stop_reason:turn===0?'tool_use':'end_turn'},usage:{output_tokens:5}}));res.end(frame({type:'message_stop'}));
      }else if(path.endsWith('/chat/completions')) {
        expect(req.headers.authorization).toBe('Bearer local-only');
        res.write(frame({choices:[{index:0,delta:turn===0?{tool_calls:[{index:0,id:'call-b',type:'function',function:{name:'local_echo',arguments:'{}'}}]}:{content:'HTTP complete'},finish_reason:turn===0?'tool_calls':'stop'}]}));res.end('data: [DONE]\n\n');
      }else if(path.endsWith('/responses')) {
        expect(req.headers.authorization).toBe('Bearer local-only');
        const item=turn===0?{type:'function_call',id:'fc-c',call_id:'call-c',name:'local_echo',arguments:'{}'}:{type:'message',role:'assistant',content:[{type:'output_text',text:'HTTP complete'}]};
        res.write(frame({type:'response.output_item.added',output_index:0,item:turn===0?{...item,arguments:''}:item}));
        if(turn===0)res.write(frame({type:'response.function_call_arguments.delta',output_index:0,delta:'{}'}));else res.write(frame({type:'response.output_text.delta',output_index:0,content_index:0,delta:'HTTP complete'}));
        res.write(frame({type:'response.output_item.done',output_index:0,item}));res.end(frame({type:'response.completed',response:{output:[item],usage:{input_tokens:20,output_tokens:5}}}));
      }else {res.statusCode=404;res.end();}
    }catch(error){res.destroy(error instanceof Error?error:undefined);}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(8788,'127.0.0.1',resolve);});
  try{
    for(const flavor of ['anthropicMessages','openAIChat','openAIResponses'] as ProviderFlavor[]) {
      const provider=createHTTPProvider({flavor,baseUrl:'http://127.0.0.1:8788/v1',apiKey:'local-only',capabilities:CapabilitiesSchema.parse({tools:true})});
      expect((await provider.listModels())[0]?.id).toBe('local-model');let last:AgentCheckpoint|undefined;let eventId=0;
      const runner=new AgentRunner({provider,tools:scriptedTools(),ports:{save:async(user,cp)=>{expect(user).toBe('http-user');last=structuredClone(cp);},emit:async()=>++eventId,isCancelled:async()=>false}});
      const time=new Date().toISOString();const cp=await runner.run({userId:'http-user',run:{type:'run',id:`r-${flavor}`,chatId:'http-chat',status:'queued',createdAt:time,updatedAt:time,lastEventId:0,clientTurnId:'client-turn'},chat:{type:'chat',id:'http-chat',title:'HTTP',pinned:false,mode:'build',connectorIds:[],disabledConnectorIds:[],createdAt:time,updatedAt:time},modelId:'local-model',messages:[{type:'message',id:'user',chatId:'http-chat',role:'user',parts:[{type:'text',text:'Use the echo tool'}],createdAt:time,updatedAt:time}]});
      expect(cp.run.outcome).toBe('completed');expect(last?.run.status).toBe('completed');expect(cp.messages).toHaveLength(4);expect(cp.messages.at(-1)?.parts[0]?.text).toBe('HTTP complete');expect(cp.messages.at(-1)?.clientTurnId).toBe('client-turn');
    }
    expect([...calls.values()]).toEqual([2,2,2]);expect(seenBodies).toHaveLength(6);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
