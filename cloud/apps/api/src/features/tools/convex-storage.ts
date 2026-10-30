import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {JsonObjectSchema} from '@praxis/protocol';
import {createConvexRPC, type ConvexRPC, type ConvexOptions} from '../../adapters/convex.js';
import {ApiError} from '../../service.js';
import type {ToolsStorage, UploadInput} from './ports.js';
const metadata=z.object({name:z.string(),mediaType:z.string(),size:z.number(),chatId:z.string().optional()});
/** API proxies uploads: Convex owns the ticket before it receives any bytes. */
export function toolsStorageFromRPC(rpc:ConvexRPC,baseUrl:string):ToolsStorage {
 const scope=(userId:string,kind:string,id:string)=>({userId,kind,id});
 return {
  state:{
   async get(userId,kind,id){const value=await rpc.query('tools:get',scope(userId,kind,id));return value===null?null:JsonObjectSchema.parse(value);},
   async put(userId,kind,id,value){await rpc.mutation('tools:put',{...scope(userId,kind,id),value:JsonObjectSchema.parse(value)});},
   async delete(userId,kind,id){await rpc.mutation('tools:remove',scope(userId,kind,id));},
  },
  async createUpload(userId,input){const ticket=randomUUID(),expiresAt=Date.now()+600_000;await rpc.mutation('files:createTicket',{userId,ticket,...input,expiresAt});return {uploadUrl:new URL(`/v1/uploads/content/${ticket}`,baseUrl).href,expiresAt:new Date(expiresAt).toISOString(),method:'PUT'};},
  async acceptUpload(userId,ticket,bytes,mediaType){return z.string().parse(await rpc.action('files:store',{userId,ticket,bytes:Uint8Array.from(bytes).buffer,mediaType:mediaType.split(';')[0]}));},
  async verify(userId,storageId,input:UploadInput){const value=await rpc.query('files:metadata',{userId,storageId});if(!value)throw new ApiError(404,'not_found','File not found');const m=metadata.parse(value);if(m.name!==input.name||m.size!==input.size||m.mediaType!==input.mediaType||m.chatId!==input.chatId)throw new ApiError(400,'upload_mismatch','Completion differs from upload request');},
  async read(userId,storageId){const value=await rpc.action('files:read',{userId,storageId});if(!value)throw new ApiError(404,'not_found','File not found');const file=z.object({bytes:z.instanceof(ArrayBuffer),mediaType:z.string()}).parse(value);return {bytes:new Uint8Array(file.bytes),mediaType:file.mediaType};},
  async delete(userId,storageId){if(!await rpc.mutation('files:remove',{userId,storageId}))throw new ApiError(404,'not_found','File not found');},
 };
}
export function createConvexToolsStorage(options:ConvexOptions&{baseUrl:string}):ToolsStorage {
 return toolsStorageFromRPC(createConvexRPC(options),options.baseUrl);
}
