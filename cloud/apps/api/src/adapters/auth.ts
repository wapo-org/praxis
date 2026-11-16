import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { createAdapterFactory, type CustomAdapter } from 'better-auth/adapters';
import { AuthInputSchema, SessionSchema } from '@praxis/protocol';
import { z } from 'zod';
import { createConvexRPC, type ConvexRPC } from './convex.js';
export function convexAuthDatabase(rpc:ConvexRPC){
 const call=(operation:string,input:unknown)=>{
  const args={operation,input:JSON.parse(JSON.stringify(input))};
  return ['findOne','findMany','count'].includes(operation)?rpc.query('auth:read',args):rpc.mutation('auth:execute',args);
 };
 return createAdapterFactory({config:{adapterId:'praxis-convex',adapterName:'Server-only Convex',supportsDates:false,supportsJSON:true,supportsBooleans:true,supportsArrays:true,transaction:false,debugLogs:false},adapter:()=>({
  create:input=>call('create',input),findOne:input=>call('findOne',input),findMany:input=>call('findMany',input),update:input=>call('update',input),updateMany:input=>call('updateMany',input),
  delete:async input=>{await call('delete',input);},deleteMany:input=>call('deleteMany',input),count:input=>call('count',input),consumeOne:input=>call('consumeOne',input),incrementOne:input=>call('incrementOne',input),
 } as CustomAdapter)});
}
export interface ProductionAuthOptions {convexUrl:string;serverToken:string;baseURL:string;secret:string;trustedOrigins:string[]}
export function createProductionAuth(options:ProductionAuthOptions){return authFromRPC(options,createConvexRPC({url:options.convexUrl,serverToken:options.serverToken}));}
export function authFromRPC(options:ProductionAuthOptions,rpc:ConvexRPC){
 z.string().min(32).parse(options.secret);const base=new URL(options.baseURL);if(base.protocol!=='https:'&&base.hostname!=='localhost'&&base.hostname!=='127.0.0.1')throw new Error('Authentication requires HTTPS');
 const auth=betterAuth({database:convexAuthDatabase(rpc),baseURL:base.origin,basePath:'/api/auth',secret:options.secret,trustedOrigins:options.trustedOrigins,emailAndPassword:{enabled:true,minPasswordLength:12},plugins:[bearer()],advanced:{useSecureCookies:base.protocol==='https:'},logger:{disabled:true}});
 const sessionDTO=(session:any,token?:string)=>SessionSchema.parse({type:'session',user:{type:'user',id:session.user.id,name:session.user.name,email:session.user.email},expiresAt:new Date(session.session.expiresAt).toISOString(),...(token?{bearerToken:token}:{})});
 const resolveSession=async(request:Request)=>{const session=await auth.api.getSession({headers:request.headers,query:{disableCookieCache:true}});return session?sessionDTO(session):null;};
 const authHandler=async(request:Request)=>{
  const path=new URL(request.url).pathname;const operation=path.split('/').at(-1);
  if(!['sign-in','sign-up','sign-out'].includes(operation??''))return Response.json({type:'error',code:'not_found',message:'Auth route not found'},{status:404});
  const headers=new Headers(request.headers);headers.delete('content-length');let body:string|undefined;
  if(operation!=='sign-out'){const input=AuthInputSchema.parse(await request.json());body=JSON.stringify({email:input.email,password:input.password,...(operation==='sign-up'?{name:input.name??input.email.split('@')[0]}:{})});}else body='{}';
  headers.set('content-type','application/json');
  const response=await auth.handler(new Request(new URL(`/api/auth/${operation}${operation==='sign-out'?'':'/email'}`,base),{method:'POST',headers,body}));
  const outgoing=new Headers(response.headers);outgoing.set('Cache-Control','no-store');outgoing.delete('content-length');outgoing.delete('set-auth-token');
  if(!response.ok)return Response.json({type:'error',code:'auth_failed',message:'Authentication failed'},{status:response.status,headers:outgoing});
  if(operation==='sign-out')return Response.json({type:'ok'},{headers:outgoing});
  const data=await response.json() as {token?:string};const token=response.headers.get('set-auth-token')??data.token;
  if(!token)throw new Error('Authentication did not produce a session');
  const session=await auth.api.getSession({headers:new Headers({authorization:`Bearer ${token}`}),query:{disableCookieCache:true}});
  if(!session)throw new Error('Authentication session could not be verified');
  return Response.json(sessionDTO(session,token),{status:operation==='sign-up'?201:200,headers:outgoing});
 };
 return {authHandler,resolveSession};
}
