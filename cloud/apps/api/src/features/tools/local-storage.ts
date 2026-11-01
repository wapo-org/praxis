import {createLocalToolsState} from './state.js';
import {randomUUID} from 'node:crypto';
import {ApiError} from '../../service.js';
import type {ToolsStorage,UploadInput} from './ports.js';
/** Explicit local fixture only. Never instantiate this adapter in production. */
export function createLocalToolsStorage(baseUrl:string):ToolsStorage{
 if(process.env.NODE_ENV==='production'||process.env.VERCEL)throw new Error('Local fixture storage forbidden in production');
 const tickets=new Map<string,{userId:string;input:UploadInput;expires:number}>();
 const files=new Map<string,{userId:string;input:UploadInput;bytes:Uint8Array}>();
 function file(userId:string,id:string){const f=files.get(id);if(!f||f.userId!==userId)throw new ApiError(404,'not_found','File not found');return f;}
 const state=createLocalToolsState();
 return {
  state,
  async purgeOwner(userId){for(const [id,row]of tickets)if(row.userId===userId)tickets.delete(id);for(const [id,row]of files)if(row.userId===userId)files.delete(id);await state.purgeOwner?.(userId);},
  async createUpload(userId,input){const token=randomUUID(),expires=Date.now()+600000;tickets.set(token,{userId,input,expires});return {uploadUrl:new URL(`/v1/uploads/content/${token}`,baseUrl).href,expiresAt:new Date(expires).toISOString(),method:'PUT'};},
  async acceptUpload(userId,token,bytes,mediaType){const t=tickets.get(token);if(!t||t.userId!==userId||t.expires<Date.now())throw new ApiError(404,'not_found','Upload ticket not found');if(bytes.byteLength!==t.input.size||mediaType.split(';')[0]!==t.input.mediaType)throw new ApiError(400,'upload_mismatch','Upload size or media type differs from request');tickets.delete(token);const id=randomUUID();files.set(id,{...t,bytes:bytes.slice()});return id;},
  async verify(userId,id,input){const f=file(userId,id);if(f.bytes.byteLength!==input.size||f.input.name!==input.name||f.input.mediaType!==input.mediaType||f.input.chatId!==input.chatId)throw new ApiError(400,'upload_mismatch','Completion differs from upload request');},
  async read(userId,id){const f=file(userId,id);return {bytes:f.bytes.slice(),mediaType:f.input.mediaType};},
  async delete(userId,id){file(userId,id);files.delete(id);},
 };
}
