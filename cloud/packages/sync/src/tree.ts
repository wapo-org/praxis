/**
 * Portable hash-tree (Merkle) index over a replica's entities. Every rule here is spelled out so Swift can
 * reproduce it byte for byte:
 * - Content hash: SHA-256 hex of canonical JSON (sorted keys, no whitespace, UTF-8). See `canonicalJSON`.
 * - Bucket: FNV-1a 32-bit over the key's UTF-8 bytes, as 8 lowercase hex digits; a node's prefix is the
 *   first `level` digits (fan-out 16). Leaves are at `depth` (default 3 → 4096 leaves).
 * - Leaf hash: SHA-256 hex of the bucket's lines `<key>\n<hash>\n`, keys sorted by UTF-16 code units
 *   (ASCII keys in practice). Inner hash: SHA-256 hex of `<childPrefix>:<childHash>\n` for every
 *   non-empty child in hex order. An empty node's hash is the empty string.
 */

export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(v => canonicalJSON(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(',')}}`;
}

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export const contentHash = (value: unknown) => sha256Hex(canonicalJSON(value));

export function bucketOf(key: string): string {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(key)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const HEX = '0123456789abcdef';

export interface TreeNode {prefix: string; hash: string; count: number}

export class HashTree {
  readonly depth: number;
  private leaves = new Map<string, Map<string, string>>(); // leaf prefix → key → hash
  private cache = new Map<string, TreeNode>();
  private dirty = new Set<string>();

  constructor(options: {depth?: number} = {}) {
    this.depth = options.depth ?? 3;
    if (!Number.isInteger(this.depth) || this.depth < 1 || this.depth > 8) throw new Error('depth must be 1..8');
  }

  get size(): number {
    let n = 0;
    for (const leaf of this.leaves.values()) n += leaf.size;
    return n;
  }

  leafOf(key: string): string {
    return bucketOf(key).slice(0, this.depth);
  }

  set(key: string, hash: string): void {
    const prefix = this.leafOf(key);
    let leaf = this.leaves.get(prefix);
    if (!leaf) this.leaves.set(prefix, (leaf = new Map()));
    if (leaf.get(key) === hash) return;
    leaf.set(key, hash);
    this.touch(prefix);
  }

  delete(key: string): void {
    const prefix = this.leafOf(key);
    const leaf = this.leaves.get(prefix);
    if (!leaf?.delete(key)) return;
    if (!leaf.size) this.leaves.delete(prefix);
    this.touch(prefix);
  }

  hashOf(key: string): string | undefined {
    return this.leaves.get(this.leafOf(key))?.get(key);
  }

  /** Keys and hashes in one leaf bucket, sorted. */
  entries(leafPrefix: string): [string, string][] {
    return [...(this.leaves.get(leafPrefix) ?? new Map<string, string>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Every key under a prefix (any level). */
  keysUnder(prefix: string): string[] {
    const keys: string[] = [];
    for (const [leaf, map] of this.leaves) if (leaf.startsWith(prefix)) keys.push(...map.keys());
    return keys;
  }

  async root(): Promise<string> {
    return (await this.node('')).hash;
  }

  async node(prefix: string): Promise<TreeNode> {
    if (prefix.length > this.depth) throw new Error('prefix deeper than tree');
    const cached = this.cache.get(prefix);
    if (cached && !this.dirty.has(prefix)) return cached;
    let node: TreeNode;
    if (prefix.length === this.depth) {
      const entries = this.entries(prefix);
      node = {prefix, count: entries.length, hash: entries.length ? await sha256Hex(entries.map(([k, h]) => `${k}\n${h}\n`).join('')) : ''};
    } else {
      const children = await this.children(prefix);
      const lines = children.filter(c => c.count).map(c => `${c.prefix}:${c.hash}\n`).join('');
      node = {prefix, count: children.reduce((n, c) => n + c.count, 0), hash: lines ? await sha256Hex(lines) : ''};
    }
    this.cache.set(prefix, node);
    this.dirty.delete(prefix);
    return node;
  }

  /** All 16 children, including empty ones (hash '' and count 0), so a client sees subtrees that vanished. */
  async children(prefix: string): Promise<TreeNode[]> {
    if (prefix.length >= this.depth) throw new Error('leaves have no children');
    return Promise.all([...HEX].map(d => this.node(prefix + d)));
  }

  private touch(leafPrefix: string): void {
    for (let i = 0; i <= leafPrefix.length; i++) this.dirty.add(leafPrefix.slice(0, i));
  }
}
