import type { JsonObject, JsonValue } from '@praxis/protocol';
export interface StoredRecord { userId:string; kind:string; id:string; value:JsonObject; revision:number; updatedAt:string; deleted:boolean; parentId?:string }
/** `parentId` is a secondary index (e.g. a message's chatId) so per-chat reads never scan a user's whole kind. */
export interface ListOptions { parentId?:string }
export interface Store {
 get(userId:string,kind:string,id:string):Promise<StoredRecord|null>;
 list(userId:string,kind:string,options?:ListOptions):Promise<StoredRecord[]>;
 put(userId:string,kind:string,id:string,value:JsonObject,options?:ListOptions):Promise<StoredRecord>;
 delete(userId:string,kind:string,id:string):Promise<void>;
 /** Compare-and-set write: succeeds only if the row's current revision equals `expectedRevision` (0 = must not exist); else null. */
 putIfRevision(userId:string,kind:string,id:string,value:JsonObject,expectedRevision:number,options?:ListOptions):Promise<StoredRecord|null>;
 changes(userId:string,after:number,limit:number):Promise<{records:StoredRecord[];cursor:number;hasMore:boolean}>;
 /** Latest revision for the owner (0 when empty): the sync cursor a fresh bootstrap hands out. */
 head(userId:string):Promise<number>;
}
export interface KV {
 get<T=JsonValue>(key:string):Promise<T|null>;
 set<T>(key:string,value:T,ttlSeconds?:number,ownerId?:string):Promise<void>;
 del(key:string):Promise<void>;
}
export interface EventRecord {id:number;payload:JsonObject}
export interface Events {
 append(userId:string,channel:string,payload:JsonObject,eventKey?:string):Promise<EventRecord>;
 read(userId:string,channel:string,after:number,limit?:number):Promise<EventRecord[]>;
 /** Id of the newest event (0 if none), so a client can subscribe from "now" without replaying the channel. */
 latest?(userId:string,channel:string):Promise<number>;
}
export interface AdapterBundle {store:Store;kv:KV;events:Events;purgeOwner?(userId:string):Promise<void>}
export interface FeatureContext {userId:string;store:Store;kv:KV;fetch:typeof fetch;
 /** SSRF-guarded fetch for user-controlled URLs: DNS validated and pinned per hop (adapters/security.ts createSafeFetch). */
 egress:typeof fetch;
 local:boolean;encryptionKey?:string}
export interface FeatureTool {
 name:string;description:string;inputSchema:JsonObject;
 source:{type:'builtin'|'skill'|'javascript'|'mcp'|'server';serverId?:string;serverName?:string};
 traits:('readOnly'|'destructive'|'idempotent'|'openWorld'|'sandboxed')[];
 /** Hidden tools are not offered to the model; they are reachable through nested callTool (e.g. the MCP gateway). */
 hidden?:boolean;
 classify?(args:JsonValue):{traits:FeatureTool['traits'];policyKey?:string};
 execute(args:JsonValue,context:{chatId:string;runId:string;mode:'ask'|'plan'|'build'|'auto';callId?:string;signal?:AbortSignal;elicit?:(request:{message:string;schema:JsonObject})=>Promise<{type:'elicitation.response';elicitationId:string;action:'accept'|'decline'|'cancel';content?:JsonObject}>;callTool?:(name:string,args:JsonValue)=>Promise<JsonValue>;emit?:(event:JsonObject)=>Promise<void>}):Promise<JsonValue>;
}
