// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { setReplicaIdentity, clearReplica } from '../lib/idb';
import { apiClient } from '../lib/api';
import { enqueue, flushEdits, pendingEdits } from './outbox';
beforeEach(() => {
  const data = new Map<string,string>();
  vi.stubGlobal('localStorage', { getItem: (k:string) => data.get(k) ?? null, setItem: (k:string,v:string) => data.set(k,v), removeItem:(k:string)=>data.delete(k), clear:()=>data.clear() });
});
afterEach(async () => { vi.restoreAllMocks(); await clearReplica(); localStorage.clear(); vi.unstubAllGlobals(); });
it('replays offline field edits in order and retains the failed suffix', async () => {
  await setReplicaIdentity('https://api.test', 'one');
  enqueue({path:'/v1/sync/settings',method:'PATCH',body:JSON.stringify({field:'theme',value:'dark'})});
  enqueue({path:'/v1/sync/settings',method:'PATCH',body:JSON.stringify({field:'palette',value:'forest'})});
  const send = vi.spyOn(apiClient,'request').mockResolvedValueOnce({}).mockRejectedValueOnce(Error('offline'));
  await flushEdits();
  expect(send).toHaveBeenCalledTimes(2);
  expect(pendingEdits()).toHaveLength(1);
  expect(JSON.parse(pendingEdits()[0]!.body!).field).toBe('palette');
  send.mockResolvedValue({}); await flushEdits(); expect(pendingEdits()).toEqual([]);
});
it('isolates queues between accounts and never resurrects a remotely deleted chat', async () => {
  await setReplicaIdentity('https://api.test', 'one');
  enqueue({path:'/v1/chats/deleted',method:'PATCH',body:'{}'});
  const send = vi.spyOn(apiClient,'request').mockRejectedValue(Object.assign(Error('deleted'),{status:404}));
  await flushEdits(); expect(pendingEdits()).toEqual([]);
  enqueue({path:'/v1/chats/private',method:'DELETE'});
  await setReplicaIdentity('https://api.test', 'two');
  await flushEdits(); expect(send).toHaveBeenCalledTimes(1); expect(pendingEdits()).toEqual([]);
});
it('queues a network failure even when navigator reports online and retains the attempted create id', async () => {
  await setReplicaIdentity('https://api.test', 'one');
  const send = vi.spyOn(apiClient, 'request').mockRejectedValue(new TypeError('Failed to fetch'));
  const chat = await apiClient.createChat({title:'Offline creation'});
  const attempted = JSON.parse(send.mock.calls[0]![1]!.body as string);
  const queued = JSON.parse(pendingEdits()[0]!.body!);
  expect(chat.id).toBe(attempted.id);
  expect(queued.id).toBe(attempted.id);
  expect(queued.title).toBe('Offline creation');
});
