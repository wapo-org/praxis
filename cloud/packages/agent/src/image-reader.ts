import {z} from 'zod';
import {IdSchema,MessagePartSchema,TimestampSchema,JsonObjectSchema,type MessagePart,type ToolError,type ToolErrorCode} from '@praxis/protocol';
import {ProviderEventSchema,textResult,type AgentTool,type ModelProvider,type ProviderRequest,type ToolResult} from './types.js';
import {toolError} from './boundary/errors.js';
import {ProviderFailure,providerToolError} from './provider-error.js';

const RegionSchema=z.object({x:z.number().min(0).lt(1),y:z.number().min(0).lt(1),width:z.number().positive().max(1),height:z.number().positive().max(1)}).strict();
const ImageQuestionSchema=z.object({image_id:IdSchema,question:z.string().trim().min(1).max(2000),region:RegionSchema.optional()}).strict();
const READER_SYSTEM='Read the image precisely for another assistant. Answer its question in plain text. Transcribe relevant text and numbers exactly. Say when details are unclear or not visible.';
const READER_MAX_TOKENS=4096;
const READER_RESPONSE_MAX_BYTES=16_000_000;
export interface ImageReaderOptions {
  provider:ModelProvider;modelId:string;maxTokens?:number;
  resolveImage(userId:string,chatId:string,imageId:string):Promise<MessagePart|null>;
  /** Optional cropper so core stays free of native image deps. */
  crop?(image:MessagePart,region:z.infer<typeof RegionSchema>,signal:AbortSignal):Promise<MessagePart>;
  now?():string;
}

/** A failed tool call the model can act on: the message and its remediation travel together. */
export function toolFailure(error:ToolError):ToolResult {
  return {content:[{type:'text',text:`${error.message}\n${error.remediation}`}],isError:true,error};
}
const fail=(code:ToolErrorCode,message:string)=>toolFailure(toolError(code,message));

/** Frozen tool spec; reads stay user/chat scoped. */
export function createImageReaderTool(options:ImageReaderOptions):AgentTool {
  IdSchema.parse(options.modelId);
  return {
    spec:{type:'tool.spec',name:'look_at_image',description:'Ask an image-reading model about an image from an [image ID omitted] placeholder. Supply image_id and a specific question. Optional region uses fractions of width and height from the top-left corner.',inputSchema:JsonObjectSchema.parse(z.toJSONSchema(ImageQuestionSchema)),source:{type:'builtin'},traits:['readOnly','idempotent']},
    async execute(value,context) {
      const args=ImageQuestionSchema.parse(value);
      if(!options.provider.capabilities.vision) {
        return fail('upstream','The selected image-reading model does not accept images. Choose a model with image input.');
      }
      let image=await options.resolveImage(context.userId,context.chatId,args.image_id);
      if(!image)return fail('not-found','No image with this ID exists in this conversation.');
      image=MessagePartSchema.parse(image);
      if(image.type!=='image'||(!image.url&&!image.data))return fail('not-found','The image bytes are unavailable.');
      if(args.region) {
        if(!options.crop)return fail('schema','Image cropping is unavailable. Ask about the complete image.');
        const region={...args.region,width:Math.min(args.region.width,1-args.region.x),height:Math.min(args.region.height,1-args.region.y)};
        image=MessagePartSchema.parse(await options.crop(image,region,context.signal));
        if(image.type!=='image'||(!image.url&&!image.data))return fail('upstream','The image crop is unavailable.');
      }
      const event={id:`vision-${crypto.randomUUID()}`,attachmentId:args.image_id,modelId:options.modelId,question:args.question};
      await context.emit({type:'vision.activity',phase:'started',...event});
      try {
        const answer=await readImage(options,readerRequest(options,image,args.question,context.chatId),context.signal);
        await context.emit({type:'vision.activity',phase:'finished',...event,answer});
        return textResult(`[${args.image_id}]\n${answer}`);
      }catch(error) {
        if(context.signal.aborted)throw error;
        await context.emit({type:'vision.activity',phase:'failed',...event});
        if(error instanceof ProviderFailure)return toolFailure(providerToolError(error));
        return fail('upstream',error instanceof Error?error.message:'Image reading failed');
      }
    },
  };
}

function readerRequest(options:ImageReaderOptions,image:MessagePart,question:string,chatId:string):ProviderRequest {
  const now=TimestampSchema.parse(options.now?.()??new Date().toISOString());
  return {
    model:options.modelId,system:READER_SYSTEM,tools:[],
    messages:[{type:'message',id:crypto.randomUUID(),chatId,role:'user',parts:[image,{type:'text',text:question}],createdAt:now,updatedAt:now}],
    capabilities:{...options.provider.capabilities,tools:false},
    maxTokens:Math.min(options.maxTokens??READER_MAX_TOKENS,READER_MAX_TOKENS),
  };
}

async function readImage(options:ImageReaderOptions,request:ProviderRequest,signal:AbortSignal):Promise<string> {
  let size=0;
  for await(const raw of options.provider.stream(request,signal)) {
    if(signal.aborted)throw new Error('Image reading cancelled');
    const event=ProviderEventSchema.parse(raw);
    size+=JSON.stringify(event).length;
    if(size>READER_RESPONSE_MAX_BYTES)throw new Error('Image reader response exceeds buffer limit');
    if(event.type!=='completed')continue;
    if(event.response.stop!=='endTurn')throw new Error('Image reader did not finish its answer');
    const answer=event.response.parts.filter(p=>p.type==='text').map(p=>p.text??'').join('');
    if(!answer.trim())break;
    return answer;
  }
  throw new Error('The image-reading model returned no answer');
}
