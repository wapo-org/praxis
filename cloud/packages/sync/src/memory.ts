import {HashTree} from './tree.js';
import type {Replica, SyncEntity} from './sync.js';

/** In-memory replica: reference implementation for IndexedDB/SwiftData replicas, used by tests and the benchmark. */
export class MemoryReplica implements Replica {
  tree: HashTree;
  cursor = '0';
  rows = new Map<string, SyncEntity>();
  constructor(depth = 3) {
    this.tree = new HashTree({depth});
  }
  async apply(upserts: SyncEntity[], deletes: string[], cursor: string): Promise<void> {
    for (const key of deletes) {
      this.rows.delete(key);
      this.tree.delete(key);
    }
    for (const e of upserts) {
      if (e.deleted) {
        this.rows.delete(e.key);
        this.tree.delete(e.key);
        continue;
      }
      this.rows.set(e.key, e);
      this.tree.set(e.key, e.hash);
    }
    this.cursor = cursor;
  }
}
