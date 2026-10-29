import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {CapabilitiesSchema,type JsonObject,type Message,type ProviderFlavor} from '@praxis/protocol';
import {createHTTPProvider,parseSSE,decodeAnthropic,decodeOpenAIChat,decodeOpenAIResponses,buildProviderRequest,parseModelMetadata,providerURL,clampEffort,classifyProviderError,scriptedTools,type ProviderEvent,type ProviderRequest} from './index.js';
const time='2026-10-29T12:00:00.000Z';
const caps=CapabilitiesSchema.parse({tools:true,vision:true,reasoningEffort:true});
const message=(role:Message['role'],parts:Message['parts']):Message=>({type:'message',id:crypto.randomUUID(),chatId:'c',role,parts,createdAt:time,updatedAt:time});
const request=():ProviderRequest=>({model:'test-model',system:'System',messages:[message('user',[{type:'text',text:'Hello'}])],tools:scriptedTools().map(t=>t.spec),capabilities:caps,maxTokens:1000,effort:'high',webSearch:false});
const fixture=(name:string)=>readFileSync(new URL(`../../../../Packages/PraxisAgent/Tests/AgentProvidersTests/Fixtures/${name}`,import.meta.url),'utf8');
function bytes(value:string,chunk=7):ReadableStream<Uint8Array>{const data=new TextEncoder().encode(value);return new ReadableStream({start(controller){for(let i=0;i<data.length;i+=chunk)controller.enqueue(data.slice(i,i+chunk));controller.close();}});}
async function collect<T>(source:AsyncIterable<T>):Promise<T[]>{const events:T[]=[];for await(const event of source)events.push(event);return events;}
const sse=(...events:unknown[])=>events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('');
function final(events:ProviderEvent[]){const last=events.at(-1);if(last?.type!=='completed')throw new Error('No completed');return last.response;}
describe('bounded SSE',()=>{
  it('handles byte-split Unicode, CR/LF variants, comments, multiline and EOF',async()=>{
    const frames=await collect(parseSSE(bytes(': ping\r\nevent: test\r\ndata: one 🙂\r\ndata: two\r\n\r\ndata: end\r\rdata: eof',1)));
    expect(frames).toEqual([{event:'test',data:'one 🙂\ntwo'},{event:'',data:'end'},{event:'',data:'eof'}]);
  });
  it('bounds event and total buffers',async()=>{
    await expect(collect(parseSSE(bytes('data: '+ 'x'.repeat(100)),undefined,{maxBytes:1000,maxEventBytes:20}))).rejects.toThrow('buffer');
    await expect(collect(parseSSE(bytes(':ignored\n'.repeat(100)),undefined,{maxBytes:100,maxEventBytes:100}))).rejects.toThrow('buffer');
  });
});
describe('frozen Swift provider fixtures',()=>{
  it.each(['anthropic_text_thinking_tool.sse','anthropic_web_search.sse','anthropic_pause_turn.sse','anthropic_refusal.sse'])('decodes %s',async name=>{
    const response=final(await collect(decodeAnthropic(parseSSE(bytes(fixture(name))))));expect(response.raw?.flavor).toBe('anthropicMessages');
    if(name.includes('thinking')){expect(response.parts.some(p=>p.type==='reasoning'&&p.signature)).toBe(true);expect(response.parts.some(p=>p.type==='toolCall')).toBe(true);}
    if(name.includes('pause'))expect(response.stop).toBe('pauseTurn');if(name.includes('refusal'))expect(response.stop).toBe('refusal');
  });
  it.each(['openai_text.sse','openai_reasoning_content.sse','openai_parallel_tools.sse','openai_missing_index.sse'])('decodes %s',async name=>{
    const response=final(await collect(decodeOpenAIChat(parseSSE(bytes(fixture(name))))));expect(response.raw?.flavor).toBe('openAIChat');
    if(name.includes('reasoning'))expect(response.parts.some(p=>p.type==='reasoning')).toBe(true);
    if(name.includes('parallel')){expect(response.parts.filter(p=>p.type==='toolCall')).toHaveLength(2);expect(new Set(response.parts.filter(p=>p.type==='toolCall').map(p=>p.callId)).size).toBe(2);}
  });
  it.each(['anthropic_error_midstream.sse','openai_stream_error.sse'])('maps %s errors',async name=>{
    await expect(collect((name.startsWith('anthropic')?decodeAnthropic:decodeOpenAIChat)(parseSSE(bytes(fixture(name)))))).rejects.toThrow();
  });
  it('rejects prematurely closed streams',async()=>{
    await expect(collect(decodeAnthropic(parseSSE(bytes(sse({type:'message_start',message:{content:[]}})))))).rejects.toThrow('before');
    await expect(collect(decodeOpenAIChat(parseSSE(bytes(sse({choices:[{delta:{content:'partial'}}]})))))).rejects.toThrow('before');
  });
});
describe('Responses streaming',()=>{
  const output=[{type:'reasoning',id:'reasoning-1',summary:[{type:'summary_text',text:'Think'}],encrypted_content:'complete-encrypted'}, {type:'function_call',id:'fc1',call_id:'call1',name:'local_echo',arguments:'{"x":1}'}];
  it('streams unique block indices, arguments, and replays final encrypted reasoning',async()=>{
    const stream=sse(
      {type:'response.output_item.added',output_index:0,item:{...output[0],encrypted_content:'partial'}},
      {type:'response.reasoning_summary_text.delta',output_index:0,summary_index:0,delta:'Think'},
      {type:'response.output_item.done',output_index:0,item:output[0]},
      {type:'response.output_item.added',output_index:1,item:{...output[1],arguments:''}},
      {type:'response.function_call_arguments.delta',output_index:1,delta:'{"x":1}'},
      {type:'response.output_item.done',output_index:1,item:output[1]},
      {type:'response.completed',response:{output,usage:{input_tokens:20,output_tokens:10,input_tokens_details:{cached_tokens:4}}}},
    );
    const events=await collect(decodeOpenAIResponses(parseSSE(bytes(stream))));const result=final(events);expect(result.stop).toBe('toolUse');expect(result.usage.inputTokens).toBe(16);expect(result.raw?.data).toEqual(output);
    const req=request();req.messages.push({...message('assistant',result.parts),raw:result.raw});const body=buildProviderRequest('openAIResponses',req);expect(JSON.stringify(body)).toContain('complete-encrypted');expect(JSON.stringify(body)).not.toContain('partial');
    const indices=events.filter(e=>e.type==='reasoning'||e.type==='tool').map(e=>e.index);expect(new Set(indices).size).toBe(2);
  });
  it('keeps final response output when item snapshots are incomplete',async()=>{
    const result=final(await collect(decodeOpenAIResponses(parseSSE(bytes(sse({type:'response.output_item.added',output_index:0,item:{type:'message',content:[]}},{type:'response.completed',response:{output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Final'}]}]}}))))));expect(result.parts[0]?.text).toBe('Final');
  });
  it('maps incomplete output and failure events',async()=>{
    const r=final(await collect(decodeOpenAIResponses(parseSSE(bytes(sse({type:'response.incomplete',response:{output:[],incomplete_details:{reason:'max_output_tokens'}}}))))));expect(r.stop).toBe('maxTokens');
    await expect(collect(decodeOpenAIResponses(parseSSE(bytes(sse({type:'response.failed',response:{error:{code:'server_error',message:'Unavailable'}}})))))).rejects.toMatchObject({kind:'retryable'});
  });
});
describe('request transforms and raw replay',()=>{
  it.each(['anthropicMessages','openAIChat','openAIResponses'] as ProviderFlavor[])('gates tools, images, effort with capabilities for %s',flavor=>{
    const r=request();r.capabilities={...caps,tools:false,vision:false,reasoningEffort:false};r.messages.push(message('assistant',[{type:'toolCall',callId:'call1',name:'test',arguments:'{}'}]),message('user',[{type:'toolResult',callId:'call1',content:[{type:'text',text:'Result'}]},{type:'image',attachmentId:'img',data:'bytes',mediaType:'image/png'}]));
    const before=structuredClone(r),body=buildProviderRequest(flavor,r);expect(body.tools).toBeUndefined();expect(body.reasoning_effort).toBeUndefined();expect(body.thinking).toBeUndefined();expect(body.reasoning).toBeUndefined();expect(JSON.stringify(body)).not.toContain('bytes');expect(r).toEqual(before);
  });
  it('replays Anthropic signed/opaque blocks and merges adjacent results before text',()=>{
    const r=request();const content:JsonObject[]=[{type:'thinking',thinking:'Think',signature:'signature'},{type:'redacted_thinking',data:'opaque'},{type:'text',text:'Answer'}];r.messages=[{...message('assistant',[{type:'text',text:'Answer'}]),raw:{type:'provider.payload',flavor:'anthropicMessages',data:{content}}},message('user',[{type:'text',text:'Next'}]),message('user',[{type:'toolResult',callId:'call',content:[{type:'text',text:'result'}]}])];
    const body=buildProviderRequest('anthropicMessages',r);const wire=body.messages as JsonObject[];expect(wire[0]?.content).toEqual(content);expect((wire[1]?.content as JsonObject[])[0]?.type).toBe('tool_result');
  });
  it('preserves Chat raw reasoning fields only for same flavor',()=>{
    const r=request();r.messages.push({...message('assistant',[{type:'text',text:'Answer'}]),raw:{type:'provider.payload',flavor:'openAIChat',data:{role:'assistant',content:'Answer',reasoning_details:[{opaque:'data'}]}}});
    expect(JSON.stringify(buildProviderRequest('openAIChat',r))).toContain('reasoning_details');expect(JSON.stringify(buildProviderRequest('anthropicMessages',r))).not.toContain('reasoning_details');
    expect(JSON.stringify(buildProviderRequest('openAIChat',r,{replayReasoning:false}))).not.toContain('reasoning_details');
  });
  it('clamps effort down on ties and drops known unsupported effort',()=>{expect(clampEffort('high',['medium','max'])).toBe('medium');expect(clampEffort('high',[])).toBeUndefined();expect(clampEffort('high',undefined)).toBe('high');});
});
describe('injected HTTP provider and models',()=>{
  it.each(['anthropicMessages','openAIChat','openAIResponses'] as ProviderFlavor[])('calls %s endpoint with configured auth',async flavor=>{
    let called:URL|undefined,headers:Headers|undefined,body:JsonObject|undefined;
    const payload=flavor==='anthropicMessages'?fixture('anthropic_text_thinking_tool.sse'):flavor==='openAIChat'?fixture('openai_text.sse'):sse({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}});
    const fetcher=(async(url,init)=>{called=new URL(String(url));headers=new Headers(init?.headers);body=JSON.parse(String(init?.body));return new Response(bytes(payload),{headers:{'content-type':'text/event-stream'}});}) as typeof fetch;
    const p=createHTTPProvider({flavor,baseUrl:'https://endpoint.invalid/custom/v1',apiKey:'test-secret',capabilities:caps},fetcher);expect(final(await collect(p.stream(request(),new AbortController().signal))).parts.length).toBeGreaterThan(0);
    expect(called?.pathname).toBe(`/custom/v1/${flavor==='anthropicMessages'?'messages':flavor==='openAIChat'?'chat/completions':'responses'}`);expect(headers?.get(flavor==='anthropicMessages'?'x-api-key':'authorization')).toContain('test-secret');expect(body?.stream).toBe(true);
  });
  it('redacts keys from HTTP errors and honors retry-after',async()=>{
    const p=createHTTPProvider({flavor:'openAIChat',baseUrl:'https://endpoint.invalid',apiKey:'do-not-leak'},(async()=>new Response(JSON.stringify({error:{message:'Failure do-not-leak'}}),{status:429,headers:{'retry-after':'2'}})) as typeof fetch);
    await expect(collect(p.stream(request(),new AbortController().signal))).rejects.toMatchObject({message:'Failure [redacted]',kind:'retryable',retryAfterMs:2000});
  });
  it('lists Anthropic model pages and parses frozen metadata',async()=>{
    const paths:string[]=[];const p=createHTTPProvider({flavor:'anthropicMessages',baseUrl:'https://endpoint.invalid',providerId:'p'},(async url=>{paths.push(String(url));return new Response(fixture(paths.length===1?'anthropic_models_page1.json':'anthropic_models_page2.json'));}) as typeof fetch);
    const models=await p.listModels();expect(paths).toHaveLength(2);expect(paths[1]).toContain('after_id=');expect(models[0]?.contextWindow).toBe(1000000);expect(models[0]?.maxOutputTokens).toBe(128000);
  });
  it('parses capability and effort metadata without provider-name gates',()=>{
    const model=parseModelMetadata({id:'any-model',architecture:{input_modalities:['text','image']},supported_parameters:['tools','reasoning'],reasoning:{supported_efforts:['low','xhigh']},context_length:10000},'arbitrary',CapabilitiesSchema.parse({}));expect(model.capabilities.vision).toBe(true);expect(model.reasoningEfforts).toEqual(['low','xhigh']);
    const no=parseModelMetadata({id:'plain',capabilities:{tool_use:{supported:false},effort:{supported:false},image_input:{supported:false}}},'p',caps);expect(no.capabilities.tools).toBe(false);expect(no.capabilities.vision).toBe(false);expect(no.reasoningEfforts).toEqual([]);
  });
  it('normalizes known full URLs, rejects embedded secrets, classifies feature rejections first',()=>{
    expect(providerURL('https://example.invalid/v1/chat/completions','models').pathname).toBe('/v1/models');expect(()=>providerURL('https://key@example.invalid','models')).toThrow();expect(classifyProviderError('Tools are not supported',500).kind).toBe('tools');expect(classifyProviderError('Image input not supported',500).kind).toBe('images');expect(classifyProviderError('Invalid reasoning_effort',400).kind).toBe('effort');
  });
});
