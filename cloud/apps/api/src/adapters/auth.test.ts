import { describe,it,expect } from 'vitest';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../../../../convex/schema.js';
import { authFromRPC } from './auth.js';
const serverToken='test-server-token-with-more-than-32-characters';
function fixture(){process.env.PRAXIS_CONVEX_SERVER_TOKEN=serverToken;const t=convexTest(schema,{'../../../../convex/_generated/api.js':async()=>({}),'../../../../convex/auth.ts':()=>import('../../../../convex/auth.js')});
 const rpc={query:(n:string,args:Record<string,unknown>)=>t.query(makeFunctionReference<'query'>(n),{...args,serverToken}),mutation:(n:string,args:Record<string,unknown>)=>t.mutation(makeFunctionReference<'mutation'>(n),{...args,serverToken})};
 return authFromRPC({convexUrl:'http://localhost:3210',serverToken,baseURL:'http://localhost:8788',trustedOrigins:['http://localhost:5173'],secret:'test-better-auth-secret-long-enough-for-test'},rpc);
}
const req=(path:string,body:unknown,headers:Record<string,string>={})=>new Request(`http://localhost:8788/v1/auth/${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
const credentials={type:'auth.input',email:'alice@example.com',password:'a-long-test-password',name:'Alice'};
describe('Real Better Auth with executable Convex database',()=>{
 it('signs up, resolves cookie and bearer, signs in, rejects wrong password, revokes session',async()=>{
  const auth=fixture();const response=await auth.authHandler(req('sign-up',credentials));expect(response.status).toBe(201);const body=await response.json();expect(body.type).toBe('session');expect(body.bearerToken).toBeTruthy();expect(body.user.name).toBe('Alice');expect(body.password).toBeUndefined();
  const bearer=new Request('http://localhost:8788/v1/bootstrap',{headers:{authorization:`Bearer ${body.bearerToken}`}});expect((await auth.resolveSession(bearer))?.user.id).toBe(body.user.id);
  const cookie=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');expect(cookie).toContain('session_token');expect((await auth.resolveSession(new Request('http://localhost:8788/v1/bootstrap',{headers:{cookie}})))?.user.id).toBe(body.user.id);
  expect(await auth.resolveSession(new Request('http://localhost:8788/v1/bootstrap',{headers:{authorization:'Bearer forged'}}))).toBeNull();
  expect((await auth.authHandler(req('sign-in',{...credentials,password:'wrong-password'}))).status).toBe(401);
  const login=await auth.authHandler(req('sign-in',credentials));expect(login.status).toBe(200);
  expect((await auth.authHandler(req('sign-out',{}, {authorization:`Bearer ${body.bearerToken}`}))).status).toBe(200);expect(await auth.resolveSession(bearer)).toBeNull();
 });
 it('rejects untrusted origins and duplicate emails',async()=>{const auth=fixture();expect((await auth.authHandler(req('sign-up',credentials,{origin:'https://evil.example'}))).status).toBe(403);expect((await auth.authHandler(req('sign-up',credentials))).status).toBe(201);expect((await auth.authHandler(req('sign-up',credentials))).ok).toBe(false);});
});
