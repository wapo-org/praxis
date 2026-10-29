import {z} from 'zod';
import {TranscriptionSchema} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import {unseal} from '../../secrets.js';
import {ApiError} from '../../service.js';
import {readLimited} from './http.js';
import type {ToolsPorts} from './ports.js';
const Options=z.object({model:z.enum(['whisper-large-v3','whisper-large-v3-turbo']).optional(),language:z.string().max(20).regex(/^[a-zA-Z-]*$/).optional(),prompt:z.string().max(10000).optional()});
export async function transcribe(req:Request,ctx:FeatureContext,ports:ToolsPorts){
 const bytes=await readLimited(req.body,34000000);let audio:Blob;let name='audio.webm';let input:z.infer<typeof Options>;
 if(req.headers.get('content-type')?.includes('multipart/form-data')){
  let form:FormData;try{form=await new Response(bytes,{headers:{'content-type':req.headers.get('content-type')!}}).formData();}catch{throw new ApiError(400,'invalid_audio','Malformed multipart audio');}
  const file=form.get('file');if(!(file instanceof Blob))throw new ApiError(400,'invalid_audio','Multipart file is required');audio=file;name=(file as File).name||name;
  input=Options.parse(Object.fromEntries(['model','language','prompt'].map(k=>[k,form.get(k)??undefined])));
 }else{
  let json:unknown;try{json=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ApiError(400,'invalid_audio','Expected multipart or JSON audio');}
  const data=Options.extend({type:z.literal('transcribe.request'),audioBase64:z.string().min(4).max(33333336).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),mediaType:z.string().max(100).default('audio/webm')}).parse(json);
  audio=new Blob([Buffer.from(data.audioBase64,'base64')],{type:data.mediaType});input=data;
 }
 if(audio.size<1||audio.size>25000000)throw new ApiError(400,'invalid_audio','Audio must contain 1–25000000 bytes');
 if(ctx.local)return TranscriptionSchema.parse({type:'transcription',text:'Local deterministic transcription.',language:input.language||'en',segments:[{type:'transcription.segment',start:0,end:1,text:'Local deterministic transcription.'}]});
 const prefs=await ctx.store.get(ctx.userId,'preferences','current');const voice=z.object({model:z.string().optional(),language:z.string().optional()}).parse(prefs&&!prefs.deleted?prefs.value.voice??{}:{});
 const opts=Options.parse({model:input.model??voice.model??'whisper-large-v3-turbo',language:input.language??voice.language,prompt:input.prompt});
 let key=await ports.voiceKey?.(ctx);if(!key){const secret=await ctx.store.get(ctx.userId,'voiceSecret','current');if(secret&&!secret.deleted&&typeof secret.value.key==='string'){if(!ctx.encryptionKey)throw new ApiError(503,'encryption_unconfigured','Voice secret cannot be read');key=unseal(secret.value.key,ctx.userId,'voice',ctx.encryptionKey);}}
 key??=process.env.GROQ_API_KEY;if(!key)throw new ApiError(503,'voice_unconfigured','Voice transcription is not configured');
 const form=new FormData();form.set('file',audio,name);form.set('model',opts.model!);form.set('response_format','verbose_json');if(opts.language)form.set('language',opts.language);if(opts.prompt!==undefined)form.set('prompt',opts.prompt);
 let response:Response;try{response=await ctx.fetch('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(60000)});}catch{throw new ApiError(502,'transcription_failed','Transcription provider is unavailable');}
 if(!response.ok)throw new ApiError(response.status===429?429:502,'transcription_failed','Transcription provider rejected the request');
 const result=z.object({text:z.string(),language:z.string().optional(),segments:z.array(z.object({start:z.number(),end:z.number(),text:z.string()})).optional()}).parse(JSON.parse(new TextDecoder().decode(await readLimited(response.body,2000000))));
 return TranscriptionSchema.parse({type:'transcription',...result,segments:(result.segments??[]).map(s=>({type:'transcription.segment',...s}))});
}
