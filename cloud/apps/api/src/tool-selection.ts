import type {Chat, Message, RunSnapshot} from '@praxis/protocol';
import type {FeatureContext, FeatureTool} from './contracts.js';
import {cosine, hashEmbedder, terms, type Embedder} from './embedding.js';
import {createMcpGateway} from './features/mcp/tools.js';
import {briefTool} from './tool-briefs.js';
import {timedStep} from './timing.js';

const toolEmbeddingCache = new Map<string, Float32Array>();
const TOOL_CACHE_MAX = 2000;

async function embedToolQueryAndCatalog(embedder: Embedder, query: string, texts: string[]): Promise<{queryVec: Float32Array; itemVecs: Float32Array[]}> {
  const uncached: string[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    const k = `${embedder.id}\0${t}`;
    if (!toolEmbeddingCache.has(k) && !seen.has(k)) {
      seen.add(k);
      uncached.push(t);
    }
  }
  const vectors = await embedder.embed([query, ...uncached]);
  for (let i = 0; i < uncached.length; i++) {
    if (toolEmbeddingCache.size >= TOOL_CACHE_MAX) {
      const first = toolEmbeddingCache.keys().next().value;
      if (first) toolEmbeddingCache.delete(first);
    }
    toolEmbeddingCache.set(`${embedder.id}\0${uncached[i]!}`, vectors[i + 1]!);
  }
  return {
    queryVec: vectors[0]!,
    itemVecs: texts.map((t) => toolEmbeddingCache.get(`${embedder.id}\0${t}`)!),
  };
}

/** Frequency is account-wide; stickiness is conversation-wide. Ranking is deterministic on ties. */
export async function selectRunTools(ctx:FeatureContext,chat:Chat,catalog:FeatureTool[],embedder:Embedder=hashEmbedder):Promise<FeatureTool[]> {
  return timedStep('toolSelection', async () => {
    // Small catalogues need no discovery or embedding; short-circuit before scanning message/snapshot history.
    if(catalog.length<=18)return catalog.map(briefTool);
    const [msgRows, snapRows] = await timedStep('toolSelectionStore', () => Promise.all([
      ctx.store.list(ctx.userId,'message'),
      ctx.store.list(ctx.userId,'snapshot'),
    ]));
    const history=msgRows.filter(r=>!r.deleted).map(r=>r.value as unknown as Message);
    const counts=new Map<string,number>(),sticky=new Set<string>();
    const snapshots=snapRows.filter(r=>!r.deleted).map(r=>r.value as unknown as RunSnapshot);
    const captured=new Set(snapshots.map(s=>s.run.id));
    for(const s of snapshots)for(const t of s.tools) {
      counts.set(t.activity.name,(counts.get(t.activity.name)??0)+1);
      if(s.run.chatId===chat.id)sticky.add(t.activity.name);
    }
    for(const m of history)for(const p of m.parts)if(p.type==='toolCall'&&p.name&&!captured.has(m.runId??'')) {
      counts.set(p.name,(counts.get(p.name)??0)+1);
      if(m.chatId===chat.id)sticky.add(p.name);
    }
    const query=history.filter(m=>m.chatId===chat.id&&m.role==='user').sort((a,b)=>(b.sequence??0)-(a.sequence??0)).find(m=>m.parts.some(p=>p.type==='text'))?.parts.filter(p=>p.type==='text').map(p=>p.text??'').join(' ')??'';
    const selected=new Set(sticky);
    [...catalog].filter(t=>counts.has(t.name)).sort((a,b)=>(counts.get(b.name)??0)-(counts.get(a.name)??0)||a.name.localeCompare(b.name)).slice(0,10).forEach(t=>selected.add(t.name));
    if(query&&catalog.length) {
      const texts=catalog.map(t=>(t.originalName??t.name)+' '+t.description);
      let queryVec:Float32Array,itemVecs:Float32Array[];
      try{
        ({queryVec,itemVecs}=await timedStep('toolSelectionEmbed',()=>embedToolQueryAndCatalog(embedder,query,texts)));
      }catch{
        ({queryVec,itemVecs}=await embedToolQueryAndCatalog(hashEmbedder,query,texts));
      }
      const qt=new Set(terms(query));
      const ranked=catalog.map((t,i)=>({t,score:cosine(queryVec,itemVecs[i]!)+0.6*terms(texts[i]!).filter(w=>qt.has(w)).length/Math.max(1,qt.size)}));
      ranked.sort((a,b)=>b.score-a.score||a.t.name.localeCompare(b.t.name)).filter(x=>x.score>0.1).slice(0,8).forEach(x=>selected.add(x.t.name));
    }
    const tools=catalog.map(briefTool);
    return [...createMcpGateway(tools),...tools.map(t=>({...t,hidden:!selected.has(t.name)}))];
  });
}
/** Estimate for concise usage briefs (schemas are provider-specific and measured separately). */
export const briefTokenEstimate=(tools:FeatureTool[])=>Math.ceil(tools.filter(t=>!t.hidden).map(t=>t.description).join('\n').length/4);
