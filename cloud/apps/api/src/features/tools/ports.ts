import type {Attachment,JsonObject} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
export interface UploadInput {name:string;mediaType:string;size:number;chatId?:string}
/** Implementations MUST authorize every storageId for userId; never trust the client claim. */
export interface ToolsState {
 get(userId:string,kind:string,id:string):Promise<JsonObject|null>;
 put(userId:string,kind:string,id:string,value:JsonObject):Promise<void>;
 delete(userId:string,kind:string,id:string):Promise<void>;
}
export interface ToolsStorage {
 state?:ToolsState;
 createUpload(userId:string,input:UploadInput):Promise<{uploadUrl:string;expiresAt:string;method?:'POST'|'PUT'}>;
 verify(userId:string,storageId:string,input:UploadInput):Promise<void>;
 read(userId:string,storageId:string):Promise<{bytes:Uint8Array;mediaType:string}>;
 delete(userId:string,storageId:string):Promise<void>;
 acceptUpload?(userId:string,token:string,bytes:Uint8Array,mediaType:string):Promise<string>;
}
export interface VisionProvider {
 host:string;
 read(input:{userId:string;attachment:Attachment;bytes:Uint8Array;question:string;region?:{x:number;y:number;width:number;height:number}}):Promise<string>;
}
export interface ToolsPorts {
 storage?:ToolsStorage;
 vision?:VisionProvider;
 voiceKey?:(ctx:FeatureContext)=>Promise<string|undefined>;
 /** Notify the root service/cache/event layer after a public resource mutation. */
 changed?:(ctx:FeatureContext,kind:string,id:string,value:JsonObject|null)=>Promise<void>;
}
