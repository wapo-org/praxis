import {getDomain} from 'tldts';
import {createSafeFetch} from './adapters/security.js';
import type {FeatureContext} from './contracts.js';
const MAX=256_000,TTL=86400000;
export function connectorDomain(url:string){const host=new URL(url).hostname;const domain=getDomain(host,{allowPrivateDomains:true});if(!domain)throw new Error('Public domain required');return domain;}
async function bytes(response:Response){
 if(!response.ok||Number(response.headers.get('content-length')??0)>MAX)throw new Error('Icon unavailable');
 const reader=response.body?.getReader();if(!reader)throw new Error('Empty response');
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>MAX)throw new Error('Icon too large');chunks.push(value);}}finally{await reader.cancel();}
 return Buffer.concat(chunks);
}
/** Every fetch (including discovered URLs and redirects) uses DNS-pinned public egress. */
export async function connectorIcon(ctx:FeatureContext,id:string,fetcher:typeof fetch=createSafeFetch({maxRedirects:3})) {
 const row=await ctx.store.get(ctx.userId,'connector',id);if(!row||row.deleted) return null;
 const domain=connectorDomain(String(row.value.url));
 const prior=await ctx.store.get(ctx.userId,'connectorIcon',domain);
 if(prior&&!prior.deleted&&Number(prior.value.expires)>Date.now())return prior.value.data?prior.value:null;
 const signal=AbortSignal.timeout(3500),origin=`https://${domain}`;
 let data:Buffer|undefined,mediaType='';
 try{
  let candidates:string[]=[];
  try{
   const html=(await bytes(await fetcher(origin,{signal}))).toString('utf8');
   for(const tag of html.match(/<link\b[^>]*>/gi)??[]){
    const attrs=Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1]!.toLowerCase(),m[2]!]));
    if(/(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(attrs.rel??'')&&attrs.href)candidates.push(new URL(attrs.href,origin).href);
   }
  }catch{}
  candidates=[...candidates.slice(0,4),origin+'/favicon.ico'];
  for(const url of candidates)try{
   const response=await fetcher(url,{signal});const type=response.headers.get('content-type')?.split(';')[0]??'';
   // Raster formats only: never relay active SVG/HTML through the authenticated origin.
   if(!['image/png','image/jpeg','image/gif','image/webp','image/x-icon','image/vnd.microsoft.icon'].includes(type)){await response.body?.cancel();continue;}
   data=await bytes(response);mediaType=type;break;
  }catch{}
 }catch{}
 const value={data:data?.toString('base64')??'',mediaType,expires:Date.now()+(data?TTL:300000)};
 await ctx.store.put(ctx.userId,'connectorIcon',domain,value);
 return data?value:null;
}
