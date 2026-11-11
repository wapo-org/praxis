import type {Model} from '@praxis/protocol';
/** Prefer advertised token prices; otherwise the provider's speed metadata, then a lightweight model family. */
export function titleModel(models:Model[]):Model|undefined {
 const cost=(m:Model)=>m.pricing?200*m.pricing.prompt+20*m.pricing.completion:Infinity;
 const small=(m:Model)=>/nano|mini|flash|haiku|small/i.test(m.id)?1:0;
 return [...models].sort((a,b)=>cost(a)-cost(b)||(b.speed??0)-(a.speed??0)||small(b)-small(a)||a.id.localeCompare(b.id))[0];
}
