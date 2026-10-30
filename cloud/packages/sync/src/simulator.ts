import {HashTree, contentHash} from './tree.js';
import {respondMerkle, type SyncEntity, type SyncRequest, type SyncResponse} from './sync.js';

/**
 * Reference sync server over a revision log, mirroring apps/api: cursor pulls read the log after a
 * revision; Merkle answers from an incrementally maintained tree. Used by tests and the benchmark.
 */
export class SyncSimulator {
  revision = 0;
  rows = new Map<string, SyncEntity & {revision: number}>();
  tree: HashTree;
  constructor(depth = 3) {
    this.tree = new HashTree({depth});
  }
  async put(key: string, value: unknown, updatedAt = new Date(0).toISOString()) {
    const hash = await contentHash(value);
    this.rows.set(key, {type: 'sync.entity', key, hash, updatedAt, deleted: false, value, revision: ++this.revision});
    this.tree.set(key, hash);
  }
  delete(key: string) {
    const row = this.rows.get(key);
    if (!row) return;
    this.rows.set(key, {...row, deleted: true, value: null, hash: 'tombstone', revision: ++this.revision});
    this.tree.delete(key);
  }
  async handle(request: SyncRequest): Promise<SyncResponse> {
    const strip = ({revision: _r, ...e}: SyncEntity & {revision: number}): SyncEntity => e;
    if (request.strategy === 'merkle') {
      return respondMerkle(this.tree, request, String(this.revision), async keys => keys.map(k => strip(this.rows.get(k)!)));
    }
    const after = Number(request.cursor ?? 0);
    // A real store reads an index by revision; the simulator sorts, which the benchmark excludes from timing claims.
    const changed = [...this.rows.values()].filter(r => r.revision > after).sort((a, b) => a.revision - b.revision);
    const page = changed.slice(0, request.limit);
    const cursor = page.at(-1)?.revision ?? after;
    return {type: 'sync.response', strategy: 'cursor', root: '', cursor: String(Math.max(cursor, page.length ? cursor : this.revision)), entities: page.map(strip), nextCursor: changed.length > page.length ? String(cursor) : null, nodes: []};
  }
}
