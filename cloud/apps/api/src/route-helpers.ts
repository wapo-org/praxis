import type {Context} from 'hono';
import type {z} from 'zod';
import {ApiError} from './service.js';

/** Parses a JSON request body against a protocol schema, with the size cap every route shares. */
export async function body<T extends z.ZodType>(c:Context,schema:T,allowEmpty=false):Promise<z.infer<T>>{const length=Number(c.req.header('content-length')??0);if(length>1000000)throw new ApiError(413,'too_large','Request is too large');let data:unknown;try{const text=await c.req.text();if(Buffer.byteLength(text)>1000000)throw new ApiError(413,'too_large','Request is too large');data=allowEmpty&&!text.trim()?{}:JSON.parse(text);}catch(e){if(e instanceof ApiError)throw e;throw new ApiError(400,'invalid_json','Expected a JSON request body');}return schema.parse(data);}
/** One page of `items`; the opaque cursor is bound to `scope` (endpoint + filters). */
export function page<T>(items:T[],query:{cursor?:string|undefined;limit:number},scope:string){let offset=0;if(query.cursor){try{const value=JSON.parse(Buffer.from(query.cursor,'base64url').toString());if(value.scope!==scope||!Number.isSafeInteger(value.offset)||value.offset<0)throw 0;offset=value.offset;}catch{throw new ApiError(400,'invalid_cursor','Invalid page cursor');}}const end=offset+query.limit;return {type:'page',items:items.slice(offset,end),nextCursor:end<items.length?Buffer.from(JSON.stringify({scope,offset:end})).toString('base64url'):null};}
