import type { JsonObject, JsonValue } from '@praxis/protocol';
export interface StoredRecord { userId:string; kind:string; id:string; value:JsonObject; revision:number; updatedAt:string; deleted:boolean }
export interface Store {
 get(userId:string,kind:string,id:string):Promise<StoredRecord|null>;
 list(userId:string,kind:string):Promise<StoredRecord[]>;
 put(userId:string,kind:string,id:string,value:JsonObject):Promise<StoredRecord>;
 delete(userId:string,kind:string,id:string):Promise<void>;
 changes(userId:string,after:number,limit:number):Promise<{records:StoredRecord[];cursor:number;hasMore:boolean}>;
}
export interface KV {
 get<T=JsonValue>(key:string):Promise<T|null>;
 set<T>(key:string,value:T,ttlSeconds?:number):Promise<void>;
 del(key:string):Promise<void>;
}
export interface EventRecord {id:number;payload:JsonObject}
export interface Events {
 append(userId:string,channel:string,payload:JsonObject):Promise<EventRecord>;
 read(userId:string,channel:string,after:number,limit?:number):Promise<EventRecord[]>;
}
export interface AdapterBundle {store:Store;kv:KV;events:Events}
export interface FeatureContext {userId:string;store:Store;kv:KV;fetch:typeof fetch;local:boolean;encryptionKey?:string}
export interface FeatureTool {
 name:string;description:string;inputSchema:JsonObject;
 source:{type:'builtin'|'skill'|'javascript'|'mcp'|'server';serverId?:string;serverName?:string};
 traits:('readOnly'|'destructive'|'idempotent'|'openWorld'|'sandboxed')[];
 classify?(args:JsonValue):{traits:FeatureTool['traits'];policyKey?:string};
 execute(args:JsonValue,context:{chatId:string;runId:string;mode:'ask'|'plan'|'build'|'auto';callId?:string;signal?:AbortSignal;elicit?:(request:{message:string;schema:JsonObject})=>Promise<{type:'elicitation.response';elicitationId:string;action:'accept'|'decline'|'cancel';content?:JsonObject}>;callTool?:(name:string,args:JsonValue)=>Promise<JsonValue>;emit?:(event:JsonObject)=>Promise<void>}):Promise<JsonValue>;
}
