import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {inspect} from 'node:util';
import {CapabilitiesSchema,type JsonObject,type Message} from '@praxis/protocol';
import {OPENROUTER_API_BASE,createOpenRouterProvider,parseSSE,decodeOpenAIChat,buildProviderRequest,clampEffort,classifyProviderError,redactKey,scriptedTools,type ProviderEvent,type ProviderRequest} from './index.js';
import {SealedSecret} from '@praxis/types';
import * as agent from './index.js';
const time='2026-10-29T12:00:00.000Z';
const caps=CapabilitiesSchema.parse({tools:true,vision:true,reasoningEffort:true});
const message=(role:Message['role'],parts:Message['parts']):Message=>({type:'message',id:crypto.randomUUID(),chatId:'c',role,parts,createdAt:time,updatedAt:time});
const request=():ProviderRequest=>({model:'anthropic/test-model',system:'System',messages:[message('user',[{type:'text',text:'Hello'}])],tools:scriptedTools().map(t=>t.spec),capabilities:caps,maxTokens:1000,effort:'high',webSearch:false});
const fixture=(name:string)=>readFileSync(new URL(`../../../../Packages/PraxisAgent/Tests/AgentProvidersTests/Fixtures/${name}`,import.meta.url),'utf8');
function bytes(value:string,chunk=7):ReadableStream<Uint8Array>{const data=new TextEncoder().encode(value);return new ReadableStream({start(controller){for(let i=0;i<data.length;i+=chunk)controller.enqueue(data.slice(i,i+chunk));controller.close();}});}
async function collect<T>(source:AsyncIterable<T>):Promise<T[]>{const events:T[]=[];for await(const event of source)events.push(event);return events;}
const sse=(...events:unknown[])=>events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n';
function final(events:ProviderEvent[]){const last=events.at(-1);if(last?.type!=='completed')throw new Error('No completed');return last.response;}
const chunk=(delta:object,finish:string|null=null,extra:object={})=>({choices:[{index:0,delta,finish_reason:finish}],...extra});
const signal=()=>new AbortController().signal;

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

describe('chat stream decoding',()=>{
  it.each(['openai_text.sse','openai_reasoning_content.sse','openai_parallel_tools.sse','openai_missing_index.sse'])('decodes the frozen fixture %s',async name=>{
    const response=final(await collect(decodeOpenAIChat(parseSSE(bytes(fixture(name))))));expect(response.raw?.type).toBe('provider.payload');
    if(name.includes('reasoning'))expect(response.parts.some(p=>p.type==='reasoning')).toBe(true);
    if(name.includes('parallel')){expect(response.parts.filter(p=>p.type==='toolCall')).toHaveLength(2);expect(new Set(response.parts.filter(p=>p.type==='toolCall').map(p=>p.callId)).size).toBe(2);}
  });
  it('maps a frozen stream error and a prematurely closed stream',async()=>{
    await expect(collect(decodeOpenAIChat(parseSSE(bytes(fixture('openai_stream_error.sse')))))).rejects.toThrow();
    await expect(collect(decodeOpenAIChat(parseSSE(bytes(`data: ${JSON.stringify(chunk({content:'partial'}))}\n\n`))))).rejects.toThrow('before');
  });
  it('reads tokens, cache counts and cost from the final usage chunk',async()=>{
    const usage={prompt_tokens:194,completion_tokens:2,total_tokens:196,cost:0.00014,prompt_tokens_details:{cached_tokens:50,cache_write_tokens:100},completion_tokens_details:{reasoning_tokens:0}};
    const response=final(await collect(decodeOpenAIChat(parseSSE(bytes(sse(chunk({content:'Hi'}),chunk({},'stop'),chunk({content:''},'stop',{usage})))))));
    expect(response.usage).toEqual({type:'usage',inputTokens:44,outputTokens:2,cacheReadTokens:50,cacheWriteTokens:100,cost:0.00014});expect(response.stop).toBe('endTurn');
  });
  it('leaves cost absent when OpenRouter sends none',async()=>{
    const response=final(await collect(decodeOpenAIChat(parseSSE(bytes(sse(chunk({content:'Hi'},'stop',{usage:{prompt_tokens:3,completion_tokens:1}})))))));expect('cost' in response.usage).toBe(false);
  });
  it('merges streamed reasoning_details per index and replays them unchanged with tools',async()=>{
    const stream=sse(
      chunk({reasoning:'Thi',reasoning_details:[{type:'reasoning.text',index:0,text:'Thi',format:'anthropic-claude-v1'}]}),
      chunk({reasoning:'nk',reasoning_details:[{type:'reasoning.text',index:0,text:'nk',signature:'sig-1'}]}),
      chunk({reasoning_details:[{type:'reasoning.encrypted',index:1,data:'opaque',id:'r2'}]}),
      chunk({tool_calls:[{index:0,id:'call1',type:'function',function:{name:'local_echo',arguments:'{}'}}]},'tool_calls'),
    );
    const response=final(await collect(decodeOpenAIChat(parseSSE(bytes(stream)))));
    const details=[{type:'reasoning.text',index:0,text:'Think',format:'anthropic-claude-v1',signature:'sig-1'},{type:'reasoning.encrypted',index:1,data:'opaque',id:'r2'}];
    expect((response.raw?.data as JsonObject|undefined)?.reasoning_details).toEqual(details);expect(response.parts[0]).toMatchObject({type:'reasoning',text:'Think',shape:'raw'});
    const req=request();req.messages.push({...message('assistant',response.parts),raw:response.raw},message('user',[{type:'toolResult',callId:'call1',content:[{type:'text',text:'ok'}]}]));
    const wire=buildProviderRequest(req).messages as JsonObject[];expect(wire[2]?.reasoning_details).toEqual(details);expect(wire[3]).toEqual({role:'tool',tool_call_id:'call1',content:'ok'});
  });
  it.each([[401,'keyInvalid'],[402,'creditExhausted'],[429,'retryable']] as const)('classifies a mid-stream error chunk with code %d as %s',async(code,kind)=>{
    const stream=`data: ${JSON.stringify(chunk({content:'partial'}))}\n\ndata: ${JSON.stringify({error:{code,message:'Stopped'},choices:[{index:0,delta:{content:''},finish_reason:'error'}]})}\n\n`;
    await expect(collect(decodeOpenAIChat(parseSSE(bytes(stream))))).rejects.toMatchObject({kind,message:'Stopped'});
  });
});

describe('request building',()=>{
  it('asks for usage accounting, streams, and sends effort as OpenRouter reasoning',()=>{
    const body=buildProviderRequest(request());
    expect(body).toMatchObject({model:'anthropic/test-model',stream:true,max_tokens:1000,usage:{include:true},reasoning:{effort:'high'},parallel_tool_calls:false});
    expect(body.reasoning_effort).toBeUndefined();expect((body.messages as JsonObject[])[0]).toEqual({role:'system',content:'System'});expect((body.tools as JsonObject[])[0]?.type).toBe('function');
  });
  it('gates tools, images and effort by the catalogue capabilities',()=>{
    const r=request();r.capabilities={...caps,tools:false,vision:false,reasoningEffort:false};r.messages.push(message('assistant',[{type:'toolCall',callId:'call1',name:'test',arguments:'{}'}]),message('user',[{type:'toolResult',callId:'call1',content:[{type:'text',text:'result'}]},{type:'image',attachmentId:'img',data:'AAAA',mediaType:'image/png'}]));
    const before=structuredClone(r),body=buildProviderRequest(r);expect(body.tools).toBeUndefined();expect(body.reasoning).toBeUndefined();expect(JSON.stringify(body)).not.toContain('image_url');expect(JSON.stringify(body)).toContain('Tool use is unavailable');expect(r).toEqual(before);
  });
  it('sends images as image_url parts when the model takes them',()=>{
    const r=request();r.messages=[message('user',[{type:'text',text:'Look'},{type:'image',attachmentId:'img',data:'AAAA',mediaType:'image/png'}])];
    expect((buildProviderRequest(r).messages as JsonObject[])[1]?.content).toEqual([{type:'text',text:'Look'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]);
  });
  it('clamps effort down on ties and drops known unsupported effort',()=>{expect(clampEffort('high',['medium','max'])).toBe('medium');expect(clampEffort('max',['low','medium','high'])).toBe('high');expect(clampEffort('high',[])).toBeUndefined();expect(clampEffort('high',undefined)).toBe('high');});
});

describe('OpenRouter provider',()=>{
  it('keeps the key out of a logged or serialised provider config',()=>{
    const config={apiKey:SealedSecret.of('sk-or-v1-config-key'),capabilities:caps};
    const printed=[JSON.stringify(config),inspect(config,{depth:null}),String(config.apiKey)].join('\n');
    expect(printed).not.toContain('sk-or-v1-config-key');
    expect(printed).toContain('[redacted]');
  });
  it('posts to the pinned chat completions URL with the user key',async()=>{
    let called='',headers:Headers|undefined,body:JsonObject|undefined,redirect:string|undefined;
    const fetcher=(async(url,init)=>{called=String(url);headers=new Headers(init?.headers);body=JSON.parse(String(init?.body));redirect=init?.redirect;return new Response(bytes(fixture('openai_text.sse')),{headers:{'content-type':'text/event-stream'}});}) as typeof fetch;
    const p=createOpenRouterProvider({apiKey:SealedSecret.of('sk-or-v1-user-key'),capabilities:caps},fetcher);expect(final(await collect(p.stream(request(),signal()))).parts.length).toBeGreaterThan(0);
    expect(OPENROUTER_API_BASE).toBe('https://openrouter.ai/api/v1');expect(called).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headers?.get('authorization')).toBe('Bearer sk-or-v1-user-key');expect(body?.stream).toBe(true);expect(body?.usage).toEqual({include:true});expect(redirect).toBe('error');
  });
  it.each([[401,'keyInvalid'],[402,'creditExhausted']] as const)('maps HTTP %d to %s and keeps OpenRouter\'s message',async(status,kind)=>{
    const p=createOpenRouterProvider({apiKey:SealedSecret.of('sk-or-v1-user-key'),capabilities:caps},(async()=>Response.json({error:{code:status,message:'OpenRouter says no'}},{status})) as typeof fetch);
    await expect(collect(p.stream(request(),signal()))).rejects.toMatchObject({kind,message:'OpenRouter says no'});
  });
  it('surfaces the upstream reason from error metadata (data policy, moderation)',async()=>{
    const p=createOpenRouterProvider({apiKey:SealedSecret.of('k'),capabilities:caps},(async()=>Response.json({error:{code:404,message:'No endpoints found matching your data policy',metadata:{raw:'Enable prompt training'}}},{status:404})) as typeof fetch);
    await expect(collect(p.stream(request(),signal()))).rejects.toMatchObject({kind:'fatal',message:'No endpoints found matching your data policy: Enable prompt training'});
  });
  it('redacts the key from errors and honours retry-after',async()=>{
    const p=createOpenRouterProvider({apiKey:SealedSecret.of('sk-or-v1-do-not-leak'),capabilities:caps},(async()=>new Response(JSON.stringify({error:{message:'Failure sk-or-v1-do-not-leak'}}),{status:429,headers:{'retry-after':'2'}})) as typeof fetch);
    await expect(collect(p.stream(request(),signal()))).rejects.toMatchObject({message:'Failure [redacted]',kind:'retryable',retryAfterMs:2000});
    expect(redactKey('Authorization: Bearer abc.def and sk-or-v1-0123456789abcdef',SealedSecret.of('other'))).toBe('Authorization: Bearer [redacted] and [redacted]');
  });
  it('reports an unreachable OpenRouter as retryable and refuses to call without a key',async()=>{
    const down=createOpenRouterProvider({apiKey:SealedSecret.of('k'),capabilities:caps},(async()=>{throw new TypeError('fetch failed');}) as typeof fetch);
    await expect(collect(down.stream(request(),signal()))).rejects.toMatchObject({kind:'retryable'});
    let called=false;const none=createOpenRouterProvider({apiKey:SealedSecret.of(''),capabilities:caps},(async()=>{called=true;return new Response('');}) as typeof fetch);
    await expect(collect(none.stream(request(),signal()))).rejects.toMatchObject({kind:'keyInvalid'});expect(called).toBe(false);
  });
  it('classifies feature rejections before status, and 401/402 before text',()=>{
    expect(classifyProviderError('Tools are not supported',500).kind).toBe('tools');expect(classifyProviderError('Image input is not supported',400).kind).toBe('images');
    expect(classifyProviderError('Invalid tool key',401).kind).toBe('keyInvalid');expect(classifyProviderError('This request requires more credits',402).kind).toBe('creditExhausted');
  });
  it('exports no multi-provider surface',()=>{
    for(const name of ['createHTTPProvider','providerURL','parseModelMetadata','parseEffortRejection','decodeAnthropic','decodeOpenAIResponses'])expect(name in agent).toBe(false);
  });
});
