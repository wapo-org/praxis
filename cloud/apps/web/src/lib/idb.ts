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

const DB_NAME = 'praxis-cloud-idb';
const DB_VERSION = 1;
const STORE_NAME = 'replica';
const KEY = 'current';
const FALLBACK_LS_KEY = 'praxis-cloud-replica-v1';

let memoryCache: LocalReplicaSnapshot | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Synchronous fast-path read from memory or localStorage mirror for <16ms instant first paint,
 * paired with IndexedDB durability for large message histories.
 */
export function readReplicaSync(): LocalReplicaSnapshot | null {
  if (memoryCache) return memoryCache;
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(FALLBACK_LS_KEY);
      if (raw) {
        memoryCache = JSON.parse(raw) as LocalReplicaSnapshot;
        return memoryCache;
      }
    } catch {}
  }
  return null;
}

export async function loadReplica(): Promise<LocalReplicaSnapshot | null> {
  const syncCopy = readReplicaSync();
  const db = await openDb();
  if (!db) return syncCopy;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(KEY);
      req.onsuccess = () => {
        const res = (req.result as LocalReplicaSnapshot | undefined) ?? syncCopy;
        if (res) memoryCache = res;
        resolve(res ?? null);
      };
      req.onerror = () => resolve(syncCopy);
    } catch {
      resolve(syncCopy);
    }
  });
}

export async function saveReplica(snapshot: LocalReplicaSnapshot): Promise<void> {
  memoryCache = snapshot;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(FALLBACK_LS_KEY, JSON.stringify(snapshot));
    } catch {}
  }
  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(snapshot, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
