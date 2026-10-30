import type {AdapterBundle,EventRecord,StoredRecord} from '../contracts.js';
export function fixtures():AdapterBundle{
 const rows=new Map<string,StoredRecord>(),changes:StoredRecord[]=[],kv=new Map<string,unknown>(),events=new Map<string,EventRecord[]>();let revision=0;const key=(u:string,k:string,id:string)=>JSON.stringify([u,k,id]);
 return {store:{
  async get(u,k,id){return structuredClone(rows.get(key(u,k,id))??null);},
  async list(u,k,o){return [...rows.values()].filter(x=>x.userId===u&&x.kind===k&&!x.deleted&&(o?.parentId===undefined||x.parentId===o.parentId)).map(x=>structuredClone(x));},
  async put(u,k,id,value,o){const parentId=o?.parentId??rows.get(key(u,k,id))?.parentId;const r:StoredRecord={userId:u,kind:k,id,value:structuredClone(value),revision:++revision,updatedAt:new Date().toISOString(),deleted:false,...(parentId===undefined?{}:{parentId})};rows.set(key(u,k,id),r);changes.push(r);return structuredClone(r);},
  async putIfRevision(u,k,id,value,expected,o){if((rows.get(key(u,k,id))?.revision??0)!==expected)return null;return this.put(u,k,id,value,o);},
  async delete(u,k,id){const r={userId:u,kind:k,id,value:{},revision:++revision,updatedAt:new Date().toISOString(),deleted:true};rows.set(key(u,k,id),r);changes.push(r);},
  async head(u){return changes.filter(r=>r.userId===u).at(-1)?.revision??0;},
  async changes(u,after,limit){const all=changes.filter(r=>r.userId===u&&r.revision>after),batch=all.slice(0,limit);return {records:structuredClone(batch),cursor:batch.at(-1)?.revision??after,hasMore:all.length>limit};},
 },kv:{async get<T>(k:string){return (structuredClone(kv.get(k))??null) as T|null;},async set(k,v){kv.set(k,structuredClone(v));},async del(k){kv.delete(k);}},events:{
  async append(u,c,payload){const k=key(u,c,''),list=events.get(k)??[];const item={id:(list.at(-1)?.id??0)+1,payload:structuredClone(payload)};list.push(item);events.set(k,list);return item;},
  async read(u,c,after,limit=100){return structuredClone((events.get(key(u,c,''))??[]).filter(x=>x.id>after).slice(0,limit));},
 }};
}
