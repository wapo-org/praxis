import {it,expect} from 'vitest';
import {CapabilitiesSchema,type RunEventPayload} from '@praxis/protocol';
import {createImageReaderTool,textResult,type ModelProvider,type ProviderRequest,type ToolContext} from './index.js';
function context(events:RunEventPayload[]):ToolContext{return {userId:'u',chatId:'c',runId:'r',mode:'ask',signal:new AbortController().signal,callId:'call',callTool:async()=>textResult(''),elicit:async()=>{throw new Error('Unexpected');},emit:async e=>{events.push(e);}};}
function provider(requests:ProviderRequest[]):ModelProvider{return {flavor:'openAIChat',capabilities:CapabilitiesSchema.parse({vision:true}),async *stream(req){requests.push(req);yield {type:'completed',response:{parts:[{type:'text',text:'The image says 42.'}],stop:'endTurn',usage:{type:'usage',inputTokens:10,outputTokens:5,cacheReadTokens:0,cacheWriteTokens:0}}};}};}
it('reads through a separately injected model with scoped image resolution and progress',async()=>{
  const requests:ProviderRequest[]=[],events:RunEventPayload[]=[];const tool=createImageReaderTool({provider:provider(requests),modelId:'reader',resolveImage:async(user,chat,id)=>{expect([user,chat,id]).toEqual(['u','c','img']);return {type:'image',attachmentId:'img',mediaType:'image/png',data:'bytes'};}});
  const result=await tool.execute({image_id:'img',question:'What does it say?'},context(events));expect(result.isError).toBe(false);expect(JSON.stringify(result.content)).toContain('42');expect(requests[0]?.model).toBe('reader');expect(requests[0]?.tools).toEqual([]);expect(requests[0]?.capabilities.tools).toBe(false);expect(events.map(e=>'phase' in e?e.phase:undefined)).toEqual(['started','finished']);
});
it('refuses unknown images or unsupported image readers without a request',async()=>{
  const requests:ProviderRequest[]=[],p=provider(requests);p.capabilities.vision=false;
  const tool=createImageReaderTool({provider:p,modelId:'reader',resolveImage:async()=>null});expect((await tool.execute({image_id:'img',question:'Look'},context([]))).isError).toBe(true);expect(requests).toHaveLength(0);
  p.capabilities.vision=true;expect((await tool.execute({image_id:'missing',question:'Look'},context([]))).isError).toBe(true);expect(requests).toHaveLength(0);
});
it('validates input and uses an injected cropper with bounded region',async()=>{
  const requests:ProviderRequest[]=[],events:RunEventPayload[]=[];let region:unknown;
  const tool=createImageReaderTool({provider:provider(requests),modelId:'reader',resolveImage:async()=>({type:'image',data:'original',mediaType:'image/png'}),crop:async(_,r)=>{region=r;return {type:'image',data:'crop',mediaType:'image/png'};}});
  await expect(tool.execute({image_id:'img',question:'',region:{x:-1,y:0,width:1,height:1}},context(events))).rejects.toThrow();
  const result=await tool.execute({image_id:'img',question:'Look',region:{x:0.75,y:0.5,width:0.5,height:0.75}},context(events));expect(result.isError).toBe(false);expect(region).toEqual({x:0.75,y:0.5,width:0.25,height:0.5});expect(JSON.stringify(requests)).toContain('crop');expect(JSON.stringify(requests)).not.toContain('original');
});
