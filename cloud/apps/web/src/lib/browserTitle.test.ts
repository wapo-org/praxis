import {afterEach,expect,it,vi} from 'vitest';
import {browserTitle} from './browserTitle';
afterEach(()=>vi.unstubAllGlobals());
it('does not start a model download for a title',async()=>{
 const create=vi.fn();
 vi.stubGlobal('LanguageModel',{availability:async()=> 'downloadable',create});
 expect(await browserTitle('Plan a Lisbon trip')).toBeUndefined();
 expect(create).not.toHaveBeenCalled();
});
it('uses an available model and destroys the session',async()=>{
 const destroy=vi.fn(),prompt=vi.fn(async()=> 'Lisbon Trip Plan');
 vi.stubGlobal('LanguageModel',{availability:async()=> 'available',create:async()=>({prompt,destroy})});
 expect(await browserTitle('Plan a Lisbon trip')).toBe('Lisbon Trip Plan');
 expect(destroy).toHaveBeenCalledOnce();
});
