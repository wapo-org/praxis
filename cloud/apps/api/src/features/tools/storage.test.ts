import {describe,it,expect} from 'vitest';
import {convexTest} from 'convex-test';
import {makeFunctionReference} from 'convex/server';
import schema from '../../../../../convex/schema.js';
import {createConvexRPC,type ConvexRPC} from '../../adapters/convex.js';
import {toolsStorageFromRPC} from './convex-storage.js';
import {createLocalToolsStorage} from './local-storage.js';
import {toolsStorageContract} from './storage-contract.js';
const token='test-tools-server-credential-with-32-characters';
function harness(){
 process.env.PRAXIS_CONVEX_SERVER_TOKEN=token;
 const t=convexTest(schema,{
  '../../../../../convex/_generated/api.js':async()=>({}),
  '../../../../../convex/tools.ts':()=>import('../../../../../convex/tools.js'),
  '../../../../../convex/files.ts':()=>import('../../../../../convex/files.js'),
 });
 const rpc:ConvexRPC={query:(n,a)=>t.query(makeFunctionReference<'query'>(n),{...a,serverToken:token}),mutation:(n,a)=>t.mutation(makeFunctionReference<'mutation'>(n),{...a,serverToken:token}),action:(n,a)=>t.action(makeFunctionReference<'action'>(n),{...a,serverToken:token})};
 return {t,storage:toolsStorageFromRPC(rpc,'https://api.example.com')};
}
toolsStorageContract('tools storage: local',()=>createLocalToolsStorage('http://localhost'));
toolsStorageContract('tools storage: Convex database',()=>harness().storage);
describe('tools Convex authentication',()=>{
 it.each(['get','put','remove'])('rejects unauthorized %s',async name=>{
  const {t}=harness(),a={serverToken:'wrong',userId:'a',kind:'skill',id:'x',...(name==='put'?{value:{}}:{})};
  if(name==='get')await expect(t.query(makeFunctionReference<'query'>(`tools:${name}`),a)).rejects.toThrow('Server authentication');
  else await expect(t.mutation(makeFunctionReference<'mutation'>(`tools:${name}`),a)).rejects.toThrow('Server authentication');
 });
});
const live=!!(process.env.PRAXIS_TEST_CONVEX_URL&&process.env.PRAXIS_TEST_CONVEX_SERVER_TOKEN);
describe.skipIf(!live)('live tools storage',()=>{
 toolsStorageContract('Convex live contract',()=>toolsStorageFromRPC(createConvexRPC({url:process.env.PRAXIS_TEST_CONVEX_URL!,serverToken:process.env.PRAXIS_TEST_CONVEX_SERVER_TOKEN!}),'https://api.example.com'));
});
