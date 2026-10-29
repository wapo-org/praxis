import { CapabilitiesSchema, StartRunSchema, type MessagePart, type ToolSpec } from '@praxis/protocol';
import { ProviderFailure, AgentRunner } from './runner.js';
import {textResult,type AgentPorts,type AgentTool,type ModelProvider,type ProviderEvent,type ProviderRequest,type ProviderResponse} from './types.js';
export type Script=NonNullable<import('@praxis/protocol').StartRun['script']>;
export function createScriptedProvider(script:Script='text'):ModelProvider {
  StartRunSchema.shape.script.parse(script);
  return {flavor:'openAIChat',capabilities:CapabilitiesSchema.parse({tools:true,vision:true,reasoningEffort:true}),
    async *stream(request:ProviderRequest,signal:AbortSignal):AsyncGenerator<ProviderEvent> {
      if(signal.aborted)throw new Error('Aborted');
      if(script==='error')throw new ProviderFailure('Scripted provider error');
      let start=0;
      for(let i=request.messages.length-1;i>=0;i--)if(request.messages[i]!.role==='user'&&request.messages[i]!.parts.some(p=>p.type==='text')){start=i;break;}
      const done=request.messages.slice(start).some(m=>m.parts.some(p=>p.type==='toolResult'));
      let parts:MessagePart[];
      const toolName=({tools:'local_echo',approval:'local_write',nestedApproval:'local_nested',elicitation:'local_elicit',vision:'look_at_image'} as Partial<Record<Script,string>>)[script];
      if(toolName&&!done) {
        const id=crypto.randomUUID();yield {type:'tool',index:0,id,name:toolName};yield {type:'arguments',index:0,json:'{}'};
        parts=[{type:'toolCall',callId:id,name:toolName,arguments:'{}'}];
      }else{
        const prompt=request.messages.slice(start).flatMap(m=>m.parts).find(p=>p.type==='text')?.text??'';
        const text=script==='long'?'Scripted streaming response. '.repeat(400):done?'Scripted tools completed.':`Scripted response: ${prompt}`;
        parts=[{type:'text',text}];
        for(let i=0;i<text.length;i+=24) {if(signal.aborted)throw new Error('Aborted');yield {type:'text',index:0,text:text.slice(i,i+24)};}
        yield {type:'blockEnd',index:0};
      }
      const response:ProviderResponse={parts,stop:toolName&&!done?'toolUse':'endTurn',usage:{type:'usage',inputTokens:Math.ceil(JSON.stringify(request.messages).length/4),outputTokens:parts[0]?.type==='text'?Math.ceil((parts[0].text??'').length/4):10,cacheReadTokens:0,cacheWriteTokens:0}};
      yield {type:'completed',response};
    },
  };
}
function spec(name:string,source:ToolSpec['source'],traits:ToolSpec['traits']):ToolSpec {
  return {type:'tool.spec',name,description:`Local scripted ${name}`,inputSchema:{type:'object',additionalProperties:true},source,traits};
}
export function scriptedTools():AgentTool[] {
  return [
    {spec:spec('local_echo',{type:'builtin'},['readOnly']),execute:async args=>textResult(JSON.stringify(args))},
    {spec:spec('local_write',{type:'mcp',serverId:'local',serverName:'Local'},['destructive']),execute:async()=>textResult('Local write completed.')},
    {spec:spec('local_nested',{type:'javascript'},['sandboxed']),execute:async(_,ctx)=>ctx.callTool('local_write',{})},
    {spec:spec('local_elicit',{type:'builtin'},['readOnly']),execute:async(_,ctx)=>{
      const reply=await ctx.elicit({message:'Provide a name',schema:{type:'object',properties:{name:{type:'string'}},required:['name']}});
      return textResult(reply.action==='accept'?JSON.stringify(reply.content??{}):'Elicitation declined',reply.action!=='accept');
    }},
    {spec:spec('look_at_image',{type:'builtin'},['readOnly']),execute:async(_,ctx)=>{
      const id=`${ctx.callId}/vision`;await ctx.emit({type:'vision.activity',id,phase:'started',attachmentId:'local-image'});
      await ctx.emit({type:'vision.activity',id,phase:'finished',attachmentId:'local-image',answer:'A scripted image.'});return textResult('A scripted image.');
    }},
  ];
}
export function createScriptedRunner(ports:AgentPorts,script:Script='text'):AgentRunner {
  return new AgentRunner({ports:{...ports,summarize:ports.summarize??(async req=>`Earlier conversation: ${req.messages.map(m=>m.parts.map(p=>p.text??p.type).join(' ')).join('\n').slice(-2000)}`)},provider:createScriptedProvider(script),tools:scriptedTools(),...(script==='compaction'?{contextWindow:1024}:{}),});
}
