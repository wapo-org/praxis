import { getReplicaIdentity } from '../lib/idb';
import { apiClient } from '../lib/api';
export interface Edit { path: string; method: string; body?: string }
const key = () => `praxis-outbox:${getReplicaIdentity() ?? 'unsigned'}`;
export function pendingEdits(): Edit[] { try { return JSON.parse(localStorage.getItem(key()) ?? '[]'); } catch { return []; } }
export function enqueue(edit: Edit) { localStorage.setItem(key(), JSON.stringify([...pendingEdits(), edit])); }
let flushing = false;
export async function flushEdits() {
  if (flushing) return;
  flushing = true;
  const owner = key();
  try {
    while (owner === key()) {
      const items = pendingEdits();
      if (!items.length) return;
      const edit = items[0]!;
      try { await apiClient.request(edit.path, { method: edit.method, ...(edit.body ? { body: edit.body } : {}) }); }
      catch (error) {
        // A deleted chat cannot be resurrected by an offline rename. Drop that obsolete edit only.
        if (!(error instanceof Error && 'status' in error && (error.status === 404 || (error.status === 409 && edit.path === '/v1/chats' && edit.method === 'POST')))) return;
      }
      if (owner !== key()) return;
      localStorage.setItem(owner, JSON.stringify(pendingEdits().slice(1)));
    }
  } finally { flushing = false; }
}
