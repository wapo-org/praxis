import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {JsonObjectSchema} from '@praxis/protocol';
import {createConvexRPC, type ConvexRPC, type ConvexOptions} from '../../adapters/convex.js';
import {ApiError} from '../../service.js';
import type {ToolsStorage, UploadInput} from './ports.js';
/** API proxies uploads: Convex owns the ticket before it receives any bytes. */
/** `fetcher` reads Convex storage URLs (the deployment's own origin, from CONVEX_URL; not user-controlled). */
export function toolsStorageFromRPC(rpc:ConvexRPC,baseUrl:string,fetcher:typeof fetch=fetch):ToolsStorage {
 void baseUrl;
 const scope=(userId:string,kind:string,id:string)=>({userId,kind,id});
 return {
  state:{
   async get(userId,kind,id){const value=await rpc.query('tools:get',scope(userId,kind,id));return value===null?null:JsonObjectSchema.parse(value);},
   async put(userId,kind,id,value){await rpc.mutation('tools:put',{...scope(userId,kind,id),value:JsonObjectSchema.parse(value)});},
   async delete(userId,kind,id){await rpc.mutation('tools:remove',scope(userId,kind,id));},
  },
  async createUpload(userId,input){
   const ticket=randomUUID(),expiresAt=Date.now()+600_000;
   await rpc.mutation('files:createTicket',{userId,ticket,...input,expiresAt});
   // Direct-to-storage: the client POSTs the raw bytes to Convex and gets {storageId}; no bearer token goes there.
   const uploadUrl=z.string().url().parse(await rpc.mutation('files:generateUploadUrl',{}));
   return {uploadUrl,expiresAt:new Date(expiresAt).toISOString(),method:'POST'};
  },
  async verify(userId,storageId,input:UploadInput){
   const result=await rpc.mutation('files:claim',{userId,storageId,name:input.name,mediaType:input.mediaType,size:input.size,...(input.chatId===undefined?{}:{chatId:input.chatId})}).catch(()=>null);
   if(!z.object({ok:z.literal(true)}).safeParse(result).success)throw new ApiError(400,'upload_mismatch','Upload does not match an open upload request');
  },
  async read(userId,storageId){
   const value=await rpc.query('files:url',{userId,storageId});if(!value)throw new ApiError(404,'not_found','File not found');
   const file=z.object({url:z.string().url(),mediaType:z.string(),size:z.number()}).parse(value);
   const response=await fetcher(file.url);if(!response.ok)throw new ApiError(502,'storage_failed','File could not be read');
   const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength!==file.size)throw new ApiError(502,'storage_failed','File size mismatch');
   return {bytes,mediaType:file.mediaType};
  },
  async delete(userId,storageId){if(!await rpc.mutation('files:remove',{userId,storageId}))throw new ApiError(404,'not_found','File not found');},
 };
}
export function createConvexToolsStorage(options:ConvexOptions&{baseUrl:string}):ToolsStorage {
 return toolsStorageFromRPC(createConvexRPC(options),options.baseUrl);
}
