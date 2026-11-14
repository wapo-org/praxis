import {it,expect,vi} from 'vitest';
import {runE2B,ensureBuiltins} from './builtins.js';
import {writeSecret} from './shared.js';
import {createLocalAdapters} from '../../local-memory.js';
import type {FeatureContext} from '../../contracts.js';
import {ConnectorSchema} from '@praxis/protocol';
const mocks=vi.hoisted(()=>({runCode:vi.fn(),kill:vi.fn(),create:vi.fn()}));
vi.mock('@e2b/code-interpreter',()=>({Sandbox:{create:mocks.create}}));
it('executes through the official SDK and destroys its sandbox after success and failure',async()=>{
 const ctx:FeatureContext={...createLocalAdapters(),userId:'u',local:true,fetch,egress:fetch,encryptionKey:Buffer.alloc(32,4).toString('base64')};await ensureBuiltins(ctx.store,'u');const value=ConnectorSchema.parse((await ctx.store.get('u','connector','builtin-e2b'))!.value);
 await expect(runE2B(ctx,value,{code:'print(2)'})).rejects.toMatchObject({code:'authorization_required'});await writeSecret(ctx,value.id,'token','fixture-key');
 mocks.kill.mockResolvedValue(undefined);mocks.create.mockResolvedValue({runCode:mocks.runCode,kill:mocks.kill});mocks.runCode.mockResolvedValue({logs:{stdout:['2']},results:[]});
 expect(await runE2B(ctx,value,{code:'print(2)'})).toMatchObject({logs:{stdout:['2']}});expect(mocks.kill).toHaveBeenCalledTimes(1);
 mocks.runCode.mockRejectedValue(new Error('fixture-key'));await expect(runE2B(ctx,value,{code:'raise Exception()'})).rejects.toThrow('The E2B code execution failed');expect(mocks.kill).toHaveBeenCalledTimes(2);
});
