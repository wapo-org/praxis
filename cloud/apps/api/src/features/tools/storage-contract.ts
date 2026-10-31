import type {JsonObject} from '@praxis/protocol';
import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {ToolsStorage} from './ports.js';
/** `upload` performs the client's byte transfer for the issued URL and returns the storageId the client would get back. */
export type ClientUpload=(s:ToolsStorage,user:string,url:{uploadUrl:string;method?:string},bytes:Uint8Array,mediaType:string)=>Promise<string>;
export function toolsStorageContract(name:string,create:()=>ToolsStorage,upload:ClientUpload){
 describe(name,()=>{
  it('uploads once, checks metadata, isolates owners, reads copies and deletes',async()=>{
   const s=create(),user=randomUUID(),other=randomUUID();const input={name:'test.txt',mediaType:'text/plain',size:5,chatId:randomUUID()};
   const url=await s.createUpload(user,input);
   const id=await upload(s,user,url,new TextEncoder().encode('hello'),'text/plain');
   await s.verify(user,id,input);await s.verify(user,id,input);await expect(s.verify(other,id,input)).rejects.toThrow();
   for(const change of [{name:'x'},{size:6},{mediaType:'x'},{chatId:'x'}])await expect(s.verify(user,id,{...input,...change})).rejects.toThrow();
   await expect(s.read(other,id)).rejects.toThrow();await expect(s.delete(other,id)).rejects.toThrow();
   const read=await s.read(user,id);expect(new TextDecoder().decode(read.bytes)).toBe('hello');read.bytes[0]=0;expect((await s.read(user,id)).bytes[0]).toBe(104);
   await s.delete(user,id);await expect(s.read(user,id)).rejects.toThrow();
  });
  it.each(['skill','javascriptKV'])('persists and isolates %s state by owner and id',async kind=>{
   const s=create().state!,user=randomUUID(),other=randomUUID(),id=randomUUID();
   const value:JsonObject=kind==='skill'?{files:{'ref.md':'hello'},conversationId:'chat'}:{data:{answer:42}};
   expect(await s.get(user,kind,id)).toBeNull();await s.put(user,kind,id,value);
   expect(await s.get(user,kind,id)).toEqual(value);expect(await s.get(other,kind,id)).toBeNull();expect(await s.get(user,kind,'other')).toBeNull();
   await s.delete(other,kind,id);expect(await s.get(user,kind,id)).toEqual(value);
   await s.put(user,kind,id,{updated:true});expect(await s.get(user,kind,id)).toEqual({updated:true});await s.delete(user,kind,id);expect(await s.get(user,kind,id)).toBeNull();
  });
 });
}
