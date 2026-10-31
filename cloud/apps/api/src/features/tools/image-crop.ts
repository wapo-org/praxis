import sharp from 'sharp';
import type {AgentTool} from '@praxis/agent';
import type {MessagePart, JsonValue} from '@praxis/protocol';
type Region = {x:number;y:number;width:number;height:number};
export function imageRegion(value: unknown): Region | undefined {
 if(value==null)return undefined;
 const r=value as Region;
 if(!['x','y','width','height'].every(k=>typeof r[k as keyof Region]==='number'&&Number.isFinite(r[k as keyof Region])))throw new Error('region needs x, y, width and height as numbers between 0 and 1.');
 if(r.width<=0||r.height<=0||r.x<0||r.y<0||r.x>=1||r.y>=1)throw new Error('region must lie inside the image: x and y in 0–1, width and height above 0.');
 return {x:r.x,y:r.y,width:Math.min(r.width,1-r.x),height:Math.min(r.height,1-r.y)};
}
export async function cropImage(image:MessagePart,region:Region,signal:AbortSignal):Promise<MessagePart> {
 signal.throwIfAborted();
 if(image.type!=='image'||!image.data)throw new Error("This image can't be decoded on this device, so it can't be cropped. Ask without a region.");
 const rect=imageRegion(region)!;
 try{
  const upright=await sharp(Buffer.from(image.data,'base64'),{limitInputPixels:100_000_000}).rotate().toBuffer({resolveWithObject:true});
  const {width,height}=upright.info;
  const left=Math.floor(rect.x*width),top=Math.floor(rect.y*height);
  const w=Math.min(width-left,Math.ceil((rect.x+rect.width)*width)-left),h=Math.min(height-top,Math.ceil((rect.y+rect.height)*height)-top);
  if(w<1||h<1)throw new Error('That region is too small to crop.');
  const long=Math.max(w,h),scale=long<768?Math.min(4,768/long):long>2000?2000/long:1;
  let pipeline=sharp(upright.data).extract({left,top,width:w,height:h}).resize(Math.max(1,Math.round(w*scale)),Math.max(1,Math.round(h*scale)));
  const png=image.mediaType==='image/png';pipeline=png?pipeline.png():pipeline.jpeg({quality:90});
  const bytes=await pipeline.toBuffer();signal.throwIfAborted();
  return {...image,mediaType:png?'image/png':'image/jpeg',data:bytes.toString('base64')};
 }catch(e){signal.throwIfAborted();throw new Error("This image can't be decoded on this device, so it can't be cropped. Ask without a region.",{cause:e});}
}
/** Normalize Swift's clamped region before the core's stricter JSON schema validates it. */
export function cropImageReaderTool(tool:AgentTool):AgentTool {
 return {...tool,async execute(value,ctx){
  try{
   if(value&&typeof value==='object'&&!Array.isArray(value)){
    const region=imageRegion(value.region);
    if(region)value={...value,region} as JsonValue;
    else if(value.region===null){const {region:_,...rest}=value;value=rest;}
   }
   return await tool.execute(value,ctx);
  }catch(e){if(ctx.signal.aborted)throw e;return {content:[{type:'text',text:e instanceof Error?e.message:'Could not crop image'}],isError:true};}
 }};
}
