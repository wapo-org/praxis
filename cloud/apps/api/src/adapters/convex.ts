import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { JsonObjectSchema } from '@praxis/protocol';
import type { Store } from '../contracts.js';
import { ChangePageSchema, Limit, RecordSchema, Revision, Scope } from './validation.js';
export interface ConvexOptions {url:string;serverToken:string}
export function createConvexRPC(options:ConvexOptions){
 z.string().url().parse(options.url);z.string().min(32).parse(options.serverToken);
 const client=new ConvexHttpClient(options.url);
 return {
  query:async(name:string,args:Record<string,unknown>)=>client.query(makeFunctionReference<'query'>(name),{...args,serverToken:options.serverToken}),
  mutation:async(name:string,args:Record<string,unknown>)=>client.mutation(makeFunctionReference<'mutation'>(name),{...args,serverToken:options.serverToken}),
 };
}
export type ConvexRPC=ReturnType<typeof createConvexRPC>;
export function storeFromRPC(rpc:ConvexRPC):Store {
 const address=(userId:string,kind:string,id?:string)=>({userId:Scope.parse(userId),kind:Scope.parse(kind),...(id===undefined?{}:{id:Scope.parse(id)})});
 return {
  get:async(u,k,id)=>RecordSchema.nullable().parse(await rpc.query('store:get',address(u,k,id))),
  list:async(u,k)=>z.array(RecordSchema).parse(await rpc.query('store:list',address(u,k))),
  put:async(u,k,id,value)=>RecordSchema.parse(await rpc.mutation('store:put',{...address(u,k,id),value:JsonObjectSchema.parse(value)})),
  delete:async(u,k,id)=>{await rpc.mutation('store:remove',address(u,k,id));},
  changes:async(u,after,limit)=>ChangePageSchema.parse(await rpc.query('store:changes',{userId:Scope.parse(u),after:Revision.parse(after),limit:Limit.parse(limit)})),
 };
}
export function createConvexStore(options:ConvexOptions):Store{return storeFromRPC(createConvexRPC(options));}
