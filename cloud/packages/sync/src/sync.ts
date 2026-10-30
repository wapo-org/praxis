import {HashTree, type TreeNode} from './tree.js';

/** Wire shapes mirror `@praxis/protocol` SyncRequest/SyncResponse (kept structural so Swift/web need no zod). */
export interface SyncEntity {type: 'sync.entity'; key: string; hash: string; updatedAt: string; deleted: boolean; value: unknown}
export interface SyncNode {type: 'sync.node'; prefix: string; hash: string; count: number}
export interface SyncRequest {type: 'sync.request'; strategy: 'cursor' | 'merkle'; cursor?: string; root?: string; prefixes?: string[]; limit: number}
export interface SyncResponse {type: 'sync.response'; strategy: 'cursor' | 'merkle'; root: string; cursor: string; entities: SyncEntity[]; nextCursor: string | null; nodes: SyncNode[]}
export type Transport = (request: SyncRequest) => Promise<SyncResponse>;

/** The client's local replica (IndexedDB on web, SwiftData on iOS). Applying a batch must be transactional. */
export interface Replica {
  tree: HashTree;
  cursor: string;
  apply(upserts: SyncEntity[], deletes: string[], cursor: string): Promise<void>;
}

export interface SyncStats {roundTrips: number; requestBytes: number; responseBytes: number; upserts: number; deletes: number}

function counted(transport: Transport, stats: SyncStats): Transport {
  return async request => {
    stats.roundTrips++;
    stats.requestBytes += JSON.stringify(request).length;
    const response = await transport(request);
    stats.responseBytes += JSON.stringify(response).length;
    return response;
  };
}
const emptyStats = (): SyncStats => ({roundTrips: 0, requestBytes: 0, responseBytes: 0, upserts: 0, deletes: 0});

/** Cursor strategy: page through the server's revision log from the replica's cursor. */
export async function syncCursor(transport: Transport, replica: Replica, limit = 500): Promise<SyncStats> {
  const stats = emptyStats();
  const send = counted(transport, stats);
  let cursor = replica.cursor;
  for (;;) {
    const response = await send({type: 'sync.request', strategy: 'cursor', cursor, limit});
    const upserts = response.entities.filter(e => !e.deleted);
    const deletes = response.entities.filter(e => e.deleted).map(e => e.key);
    if (upserts.length || deletes.length || response.cursor !== cursor) await replica.apply(upserts, deletes, response.cursor);
    stats.upserts += upserts.length;
    stats.deletes += deletes.length;
    cursor = response.cursor;
    if (!response.nextCursor) return stats;
  }
}

/**
 * Merkle strategy: compare roots, descend only into differing subtrees, then replace differing leaf buckets.
 * Rule: prefixes shorter than `depth` return their 16 child nodes; prefixes of length `depth` return the
 * leaf's live entities. Needs no cursor, so it also repairs a replica whose cursor is lost or expired.
 * Round trips when anything differs: 1 (root) + depth.
 */
export async function syncMerkle(transport: Transport, replica: Replica): Promise<SyncStats> {
  const stats = emptyStats();
  const send = counted(transport, stats);
  const {tree} = replica;
  let response = await send({type: 'sync.request', strategy: 'merkle', root: await tree.root(), limit: 1000});
  let cursor = response.cursor;
  let nodes = response.nodes;
  while (nodes.length) {
    const differing: string[] = [];
    for (const node of nodes) if ((await tree.node(node.prefix)).hash !== node.hash) differing.push(node.prefix);
    if (!differing.length) break;
    response = await send({type: 'sync.request', strategy: 'merkle', prefixes: differing, limit: 1000});
    cursor = response.cursor;
    if (differing[0]!.length === tree.depth) {
      const returned = new Set(response.entities.map(e => e.key));
      const deletes = differing.flatMap(p => tree.keysUnder(p)).filter(k => !returned.has(k));
      const upserts = response.entities.filter(e => tree.hashOf(e.key) !== e.hash);
      await replica.apply(upserts, deletes, cursor);
      stats.upserts += upserts.length;
      stats.deletes += deletes.length;
      return stats;
    }
    nodes = response.nodes;
  }
  if (cursor !== replica.cursor) await replica.apply([], [], cursor);
  return stats;
}

/** Server side of the Merkle strategy over a tree the server keeps current. */
export async function respondMerkle(
  tree: HashTree,
  request: Pick<SyncRequest, 'root' | 'prefixes'>,
  cursor: string,
  load: (keys: string[]) => Promise<SyncEntity[]>,
): Promise<SyncResponse> {
  const base = {type: 'sync.response' as const, strategy: 'merkle' as const, root: await tree.root(), cursor, nextCursor: null};
  const toWire = (n: TreeNode): SyncNode => ({type: 'sync.node', prefix: n.prefix, hash: n.hash, count: n.count});
  if (!request.prefixes) {
    if (request.root === base.root) return {...base, entities: [], nodes: []};
    return {...base, entities: [], nodes: (await tree.children('')).map(toWire)};
  }
  const prefixes = [...new Set(request.prefixes)];
  if (prefixes.length > 4096 || prefixes.some(p => !/^[0-9a-f]+$/.test(p) || p.length > tree.depth)) throw new RangeError('invalid prefixes');
  const leaves = prefixes.filter(p => p.length === tree.depth);
  const inner = prefixes.filter(p => p.length < tree.depth);
  const nodes = (await Promise.all(inner.map(p => tree.children(p)))).flat().map(toWire);
  const entities = leaves.length ? await load(leaves.flatMap(p => tree.entries(p).map(([k]) => k))) : [];
  return {...base, nodes, entities};
}
