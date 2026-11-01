import type {
  Bootstrap,
  Chat,
  Connector,
  Message,
  Model,
  Provider,
  Skill,
} from '@praxis/protocol';
import type { Consent, Preferences, Registry } from './api';

export interface LocalReplicaSnapshot {
  bootstrap?: Bootstrap;
  chats: Chat[];
  messagesByChat: Record<string, Message[]>;
  providers: Provider[];
  models: Model[];
  connectors: Connector[];
  skills: Skill[];
  consents: Consent[];
  registries: Registry[];
  preferences?: Preferences;
  syncCursor: string;
  updatedAt: number;
}

const STORE_NAME = 'replica';
let scope: { key: string; userId: string } | null = null;
let memoryCache: LocalReplicaSnapshot | null = null;
let queue = Promise.resolve();

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open('praxis-cloud-scoped-v2', 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function remove(key: string) {
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = tx.onerror = () => { db.close(); resolve(); };
  });
}

/** Called only after the server has verified the current session. */
export async function setReplicaIdentity(origin: string, userId: string): Promise<void> {
  const apiOrigin = new URL(origin || '/', globalThis.location?.origin ?? 'http://localhost').origin;
  const key = JSON.stringify([apiOrigin, userId]);
  if (scope?.key === key) return;
  if (scope) await clearReplica();
  // The marker contains identity only; no chats, messages or credentials.
  const marker = `praxis-replica-owner:${apiOrigin}`;
  const previous = localStorage.getItem(marker);
  if (previous && previous !== key) await remove(previous);
  localStorage.setItem(marker, key);
  localStorage.removeItem('praxis-cloud-replica-v1');
  if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('praxis-cloud-idb');
  scope = { key, userId };
}

export async function clearReplica(): Promise<void> {
  const previous = scope;
  scope = null;
  memoryCache = null;
  await queue;
  if (previous) await remove(previous.key);
}

export function readReplicaSync(): LocalReplicaSnapshot | null {
  return scope ? memoryCache : null;
}

export async function loadReplica(): Promise<LocalReplicaSnapshot | null> {
  const owner = scope;
  if (!owner) return null;
  const db = await database();
  if (!db) return readReplicaSync();
  return new Promise((resolve) => {
    const req = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(owner.key);
    req.onsuccess = () => {
      const record = req.result as { userId: string; snapshot: LocalReplicaSnapshot } | undefined;
      const value = record?.snapshot;
      const valid = scope === owner && record?.userId === owner.userId && !!value &&
        (!value.bootstrap || value.bootstrap.user.id === owner.userId);
      if (valid) memoryCache = value;
      db.close();
      resolve(valid ? value : null);
    };
    req.onerror = () => { db.close(); resolve(null); };
  });
}

export function getReplicaIdentity(): string | undefined { return scope?.key; }

export async function saveReplica(snapshot: LocalReplicaSnapshot, expectedKey = scope?.key): Promise<void> {
  const owner = scope;
  if (!owner || owner.key !== expectedKey || (snapshot.bootstrap && snapshot.bootstrap.user.id !== owner.userId)) return;
  memoryCache = snapshot;
  queue = queue.then(async () => {
    if (scope !== owner) return;
    const db = await database();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ userId: owner.userId, snapshot }, owner.key);
      tx.oncomplete = tx.onerror = () => { db.close(); resolve(); };
    });
  });
  await queue;
}

/** After account deletion: drop every replica on this device (all origins and users) and the owner markers. */
export async function wipeReplicaStorage(): Promise<void> {
  await clearReplica();
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith('praxis-replica-owner:') || key === 'praxis-cloud-replica-v1')
      localStorage.removeItem(key);
  }
  if (typeof indexedDB === 'undefined') return;
  for (const name of ['praxis-cloud-scoped-v2', 'praxis-cloud-idb'])
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? Error('Could not clear local data'));
      // Another tab still has it open: the browser finishes the deletion when that tab closes it.
      req.onblocked = () => resolve();
    });
}
