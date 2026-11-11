import type {Model} from '@praxis/protocol';
/** Cheap, small text models that can answer without a mandatory reasoning budget. */
export function titleModels(models:Model[]):Model[] {
 const cost=(m:Model)=>m.pricing?200*m.pricing.prompt+32*m.pricing.completion:Infinity;
 const small=(m:Model)=>/nano|mini|flash(?:-lite)?|haiku|small/i.test(m.id)?1:0;
 return models.filter(m=>!/:free(?:$|:)|^openrouter\/(?:free|auto)$|(?:^|[\/-])(?:o[134](?:-|$)|.*reasoning|.*thinking|deepseek-r1)/i.test(m.id)&&(!m.pricing||(m.pricing.prompt>0&&m.pricing.completion>0))&&m.reasoningMandatory!==true&&(!m.outputModalities||m.outputModalities.includes('text'))&&(!m.capabilities.reasoningEffort||m.reasoningEfforts.some(e=>['none','minimal','low'].includes(e))))
 .sort((a,b)=>small(b)-small(a)||cost(a)-cost(b)||(b.speed??0)-(a.speed??0)||a.id.localeCompare(b.id));
}
export const titleModel=(models:Model[])=>titleModels(models)[0];
