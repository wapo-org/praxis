import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { z } from 'zod';
export interface ResolvedAddress {address:string;family:number}
export interface SafeFetchOptions {redirects?:'error';allowHttp?:boolean;resolve?:(hostname:string)=>Promise<ResolvedAddress[]>}
function v4Number(ip:string){return ip.split('.').reduce((n,p)=>n*256+Number(p),0);}
function inV4(ip:string,base:string,bits:number){return Math.floor(v4Number(ip)/2**(32-bits))===Math.floor(v4Number(base)/2**(32-bits));}
function v6Number(ip:string){
 const [left,right]=ip.toLowerCase().split('::');const a=left?left.split(':'):[],b=right?right.split(':'):[];
 const parts=right===undefined?a:[...a,...Array(8-a.length-b.length).fill('0'),...b];
 return parts.reduce((n,p)=>(n<<16n)+BigInt(`0x${p||'0'}`),0n);
}
/** Conservative public unicast policy, including IPv4-mapped IPv6 and transition networks. */
export function isPublicAddress(address:string):boolean {
 const family=isIP(address);if(family===4)return ![
 ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3],
 ].some(([base,bits])=>inV4(address,base as string,bits as number));
 if(family!==6||address.includes('.')||address.includes('%'))return false;
 const n=v6Number(address),prefix=(base:string,bits:number)=>(n>>BigInt(128-bits))===(v6Number(base)>>BigInt(128-bits));
 return prefix('2000::',3)&&!prefix('2001::',23)&&!prefix('2001:db8::',32)&&!prefix('2002::',16)&&!prefix('3fff::',20);
}
function parseUrl(input:string|URL,allowHttp=false){
 const u=new URL(z.string().min(1).max(8192).parse(String(input)));
 if((u.protocol!=='https:'&&!(allowHttp&&u.protocol==='http:'))||u.username||u.password)throw new Error('Egress requires a public HTTPS URL without credentials');
 const hostname=u.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
 if(!hostname||hostname==='localhost'||/\.(localhost|local|internal)$/.test(hostname))throw new Error('Private egress destination');
 return {u,hostname};
}
async function resolveUrl(input:string|URL,options:SafeFetchOptions){
 const {u,hostname}=parseUrl(input,options.allowHttp);
 const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await (options.resolve??(h=>lookup(h,{all:true,verbatim:true})))(hostname);
 if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)||isIP(a.address)!==a.family))throw new Error('Private egress destination');
 return {u,hostname,addresses};
}
export async function assertPublicUrl(input:string|URL,options:SafeFetchOptions={}):Promise<URL>{return (await resolveUrl(input,options)).u;}
export function createSafeFetch(options:SafeFetchOptions={}):typeof fetch {
 return async(input,init)=>{
  const request=new Request(input,init);const {hostname,addresses}=await resolveUrl(request.url,options);
  // The dialer uses only this validated result. TLS SNI and Host retain the original hostname.
  const agent=new Agent({connect:{lookup:(host,opts,callback)=>{
   if(host.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase()!==hostname){callback(new Error('Egress host changed'),'',0);return;}
   if(opts.all)(callback as any)(null,addresses);else {const a=addresses.find(x=>!opts.family||x.family===opts.family)??addresses[0]!;callback(null,a.address,a.family);}
  }}});
  try {return await fetch(request,{redirect:'error',dispatcher:agent} as RequestInit);}finally {void agent.close().catch(()=>{});}
 };
}
