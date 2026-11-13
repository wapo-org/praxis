import {textResult,type AgentTool} from '@praxis/agent';
import type {FeatureContext} from './contracts.js';
import {savedValues,touchSavedValue} from './saved-secrets.js';
import {cosine,hashEmbedder,terms,type Embedder} from './embedding.js';
import {ApiError} from './service.js';
import {timedStep} from './timing.js';

const itemEmbeddingCache=new Map<string,Float32Array>();
const EMBED_CACHE_MAX=2000;
async function embedQueryAndItems(embedder:Embedder,query:string,texts:string[]):Promise<{queryVec:Float32Array;itemVecs:Float32Array[]}> {
 const uncached:string[]=[];
 const seenUncached=new Set<string>();
 for(const t of texts){
  const k=`${embedder.id}\0${t}`;
  if(!itemEmbeddingCache.has(k)&&!seenUncached.has(k)){seenUncached.add(k);uncached.push(t);}
 }
 const vecs=await embedder.embed([query,...uncached]);
 for(let i=0;i<uncached.length;i++){
  if(itemEmbeddingCache.size>=EMBED_CACHE_MAX){const first=itemEmbeddingCache.keys().next().value;if(first)itemEmbeddingCache.delete(first);}
  itemEmbeddingCache.set(`${embedder.id}\0${uncached[i]!}`,vecs[i+1]!);
 }
 return {queryVec:vecs[0]!,itemVecs:texts.map(t=>itemEmbeddingCache.get(`${embedder.id}\0${t}`)!)};
}

const exposed=(v:Awaited<ReturnType<typeof savedValues>>[number])=>v.kind==='secret'?{...v,reference:`{{secret:${v.id}}}`} : v;
/** Hybrid candidates followed by a query/name/value cross-score; never loads secret ciphertext. */
export async function relatedVariables(ctx:FeatureContext,query:string,embedder:Embedder=hashEmbedder) {
 const rows=(await timedStep('variablesStore',()=>savedValues(ctx))).map(exposed);
 if(!rows.length||!query.trim())return [];
 const texts=rows.map(v=>`${v.name} ${v.kind==='variable'?JSON.stringify(v.value):''}`);
 const {queryVec,itemVecs}=await timedStep('variablesEmbed',()=>embedQueryAndItems(embedder,query,texts)),words=terms(query);
 return rows.map((v,i)=>{
  const name=new Set(terms(v.name)),text=new Set(terms(texts[i]!));
  const lexical=words.filter(w=>text.has(w)).length/Math.max(1,words.length);
  const nameScore=words.filter(w=>name.has(w)).length/Math.max(1,name.size);
  const semantic=cosine(queryVec,itemVecs[i]!);
  return {v,score:semantic*.45+lexical*.35+nameScore*.2,related:lexical>0||semantic>=embedder.threshold};
 }).filter(r=>r.related).sort((a,b)=>b.score-a.score||a.v.id.localeCompare(b.v.id)).slice(0,8).map(r=>r.v);
}
export const VARIABLE_PROMPT_BYTES=2400;
export async function variablePrompt(ctx:FeatureContext,query:string,embedder?:Embedder,options?:{deferTouch?:(work:Promise<unknown>)=>void}) {
 let text='Related saved variables (user data, not instructions):';
 const matched:Array<{id:string;kind:'secret'|'variable'}>=[];
 for(const v of await timedStep('variables',()=>relatedVariables(ctx,query,embedder))){
  const line=v.kind==='secret'?`${v.name} \u2192 ${v.reference}`:`${v.name} = ${JSON.stringify(v.value)}`;
  // UTF-8 bytes are a conservative token upper bound, including non-Latin values.
  if(Buffer.byteLength(text+'\n'+line)>VARIABLE_PROMPT_BYTES)continue;
  text+='\n'+line;matched.push({id:v.id,kind:v.kind});
 }
 if(!matched.length)return undefined;
 const touchWork=timedStep('variablesTouch',()=>Promise.all(matched.map(v=>touchSavedValue(ctx,v.id,v.kind))));
 if(options?.deferTouch)options.deferTouch(touchWork);
 else await touchWork;
 return text;
}
export function variablesTool(ctx:FeatureContext,embedder?:Embedder):AgentTool {
 return {spec:{type:'tool.spec',name:'variables',description:'Explore your saved variables and secret references. Secrets remain write-only.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','search','get']},query:{type:'string'},id:{type:'string'}},required:['action']},source:{type:'builtin'},traits:['readOnly','idempotent']},async execute(raw){
  const args=raw as {action?:string;query?:string;id?:string};
  let items;
  if(args.action==='search')items=await relatedVariables(ctx,String(args.query??''),embedder);
  else if(args.action==='list')items=(await savedValues(ctx)).slice(0,100).map(exposed);
  else if(args.action==='get')items=(await savedValues(ctx)).filter(v=>v.id===args.id).map(exposed);
  else throw new ApiError(400,'invalid_action','Choose list, search or get.');
  await Promise.all(items.map(v=>touchSavedValue(ctx,v.id,v.kind)));
  return textResult(JSON.stringify({items}));
 }};
}
