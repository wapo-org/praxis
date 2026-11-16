import {z} from 'zod';
import {IdSchema,MessagePartSchema,TimestampSchema,JsonObjectSchema,type MessagePart} from '@praxis/protocol';
import {ProviderEventSchema,textResult,type AgentTool,type ModelProvider} from './types.js';

const RegionSchema=z.object({x:z.number().min(0).lt(1),y:z.number().min(0).lt(1),width:z.number().positive().max(1),height:z.number().positive().max(1)}).strict();
const ImageQuestionSchema=z.object({image_id:IdSchema,question:z.string().trim().min(1).max(2000),region:RegionSchema.optional()}).strict();
export interface ImageReaderOptions {
  provider:ModelProvider;modelId:string;maxTokens?:number;
  resolveImage(userId:string,chatId:string,imageId:string):Promise<MessagePart|null>;
  /** Optional injected cropper. The core never imports a native image library. */
  crop?(image:MessagePart,region:z.infer<typeof RegionSchema>,signal:AbortSignal):Promise<MessagePart>;
  now?():string;
}
/** Frozen spec is independent of the selected reader. All reads remain user/chat scoped. */
export function createImageReaderTool(options:ImageReaderOptions):AgentTool {
  IdSchema.parse(options.modelId);
  return {
    spec:{type:'tool.spec',name:'look_at_image',description:'Ask an image-reading model about an image from an [image ID omitted] placeholder. Supply image_id and a specific question. Optional region uses fractions of width and height from the top-left corner.',inputSchema:JsonObjectSchema.parse(z.toJSONSchema(ImageQuestionSchema)),source:{type:'builtin'},traits:['readOnly','idempotent']},
    async execute(value,context) {
      const args=ImageQuestionSchema.parse(value),id=`vision-${crypto.randomUUID()}`;
      if(!options.provider.capabilities.vision)return textResult('The selected image-reading model does not accept images. Choose a model with image input.',true);
      let image=await options.resolveImage(context.userId,context.chatId,args.image_id);
      if(!image)return textResult('No image with this ID exists in this conversation.',true);
      image=MessagePartSchema.parse(image);if(image.type!=='image'||(!image.url&&!image.data))return textResult('The image bytes are unavailable.',true);
      if(args.region) {
        if(!options.crop)return textResult('Image cropping is unavailable. Ask about the complete image.',true);
        const region={...args.region,width:Math.min(args.region.width,1-args.region.x),height:Math.min(args.region.height,1-args.region.y)};
        image=MessagePartSchema.parse(await options.crop(image,region,context.signal));
        if(image.type!=='image'||(!image.url&&!image.data))return textResult('The image crop is unavailable.',true);
      }
      const event={id,attachmentId:args.image_id,modelId:options.modelId,question:args.question};
      await context.emit({type:'vision.activity',phase:'started',...event});
      try{
        const now=TimestampSchema.parse(options.now?.()??new Date().toISOString());let answer='',complete=false,size=0;
        for await(const raw of options.provider.stream({model:options.modelId,system:'Read the image precisely for another assistant. Answer its question in plain text. Transcribe relevant text and numbers exactly. Say when details are unclear or not visible.',messages:[{type:'message',id:crypto.randomUUID(),chatId:context.chatId,role:'user',parts:[image,{type:'text',text:args.question}],createdAt:now,updatedAt:now}],tools:[],capabilities:{...options.provider.capabilities,tools:false},maxTokens:Math.min(options.maxTokens??4096,4096),webSearch:false},context.signal)) {
          if(context.signal.aborted)throw new Error('Image reading cancelled');
          const e=ProviderEventSchema.parse(raw);size+=JSON.stringify(e).length;if(size>16_000_000)throw new Error('Image reader response exceeds buffer limit');
          if(e.type==='completed'){if(e.response.stop!=='endTurn')throw new Error('Image reader did not finish its answer');answer=e.response.parts.filter(p=>p.type==='text').map(p=>p.text??'').join('');complete=true;}
        }
        if(!complete||!answer.trim())throw new Error('The image-reading model returned no answer');
        await context.emit({type:'vision.activity',phase:'finished',...event,answer});return textResult(`[${args.image_id}]\n${answer}`);
      }catch(error){
        if(context.signal.aborted)throw error;
        await context.emit({type:'vision.activity',phase:'failed',...event});
        return textResult(error instanceof Error?error.message:'Image reading failed',true);
      }
    },
  };
}
