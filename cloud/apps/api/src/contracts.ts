import type { JsonObject, JsonValue, Message } from '@praxis/protocol';
export interface StoredRecord { userId:string; kind:string; id:string; value:JsonObject; revision:number; updatedAt:string; deleted:boolean; parentId?:string }
/** Secondary index (e.g. chatId) so list queries never scan a whole kind. */
export interface ListOptions { parentId?:string }
export interface Store {
 commitMessages?(userId: string, chatId: string, messages: Message[]): Promise<Message[]>;
 get(userId:string,kind:string,id:string):Promise<StoredRecord|null>;
 list(userId:string,kind:string,options?:ListOptions):Promise<StoredRecord[]>;
 put(userId:string,kind:string,id:string,value:JsonObject,options?:ListOptions):Promise<StoredRecord>;
 delete(userId:string,kind:string,id:string):Promise<void>;
 /** CAS write failing with null unless revision matches expectedRevision (0 = absent). */
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
 /** Newest event id (0 if none) so clients subscribe from now without replay. */
 latest?(userId:string,channel:string):Promise<number>;
}
export interface AdapterBundle {store:Store;kv:KV;events:Events;purgeOwner?(userId:string):Promise<void>;
 /** dev:local only: lets a fresh dev sign-in recreate an erased user as a clean, empty account. */
 reopenOwner?(userId:string):Promise<void>}
export interface FeatureContext {userId:string;store:Store;kv:KV;fetch:typeof fetch;
 /** SSRF-guarded fetch for user URLs with per-hop DNS pinning. */
 egress:typeof fetch;
 local:boolean;encryptionKey?:string}
export interface FeatureTool {
 originalName?:string;name:string;description:string;inputSchema:JsonObject;
 source:{type:'builtin'|'skill'|'javascript'|'mcp'|'server';serverId?:string;serverName?:string};
 traits:('readOnly'|'destructive'|'idempotent'|'openWorld'|'sandboxed')[];
 /** Hidden from the model; reachable only via nested callTool (e.g. MCP gateway). */
 hidden?:boolean;
 /** Tool arguments can contain credentials and must not be streamed or committed publicly. */
 privateArguments?:boolean;
 classify?(args:JsonValue):{traits:FeatureTool['traits'];policyKey?:string};
 execute(args:JsonValue,context:{chatId:string;runId:string;mode:'ask'|'plan'|'build'|'auto';callId?:string;signal?:AbortSignal;elicit?:(request:{message:string;schema:JsonObject})=>Promise<{type:'elicitation.response';elicitationId:string;action:'accept'|'decline'|'cancel';content?:JsonObject}>;callTool?:(name:string,args:JsonValue)=>Promise<JsonValue>;emit?:(event:JsonObject)=>Promise<void>}):Promise<JsonValue>;
}
