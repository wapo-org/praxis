import { ConvexError } from 'convex/values';
/** A dedicated high-entropy server credential, never the client session or deployment key. */
export async function requireServer(token:string):Promise<void> {
 const expected=process.env.PRAXIS_CONVEX_SERVER_TOKEN;
 if(!expected || expected.length<32 || token.length>1024)throw new ConvexError('Server authentication required');
 const digest=async(value:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
 const [a,b]=await Promise.all([digest(token),digest(expected)]);let diff=0;
 for(let i=0;i<a.length;i++)diff|=a[i]!^b[i]!;
 if(diff)throw new ConvexError('Server authentication required');
}
export function bounded(value:string){if(!value || value.length>500)throw new ConvexError('Invalid scope');return value;}
