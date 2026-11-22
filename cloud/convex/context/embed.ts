import {internal} from '../_generated/api.js';
import {ENCRYPTION_KEY_ENV, ENCRYPTION_KEYRING_ENV} from '../agent/constants.js';
import {internalAction, internalMutation} from '../functions.js';
import {v, ConvexError} from 'convex/values';
import {SealedSecret} from '@praxis/types';
import {embedTexts} from '@praxis/agent';
import {
  CONTEXT_EMBED_ATTEMPTS_MAX,
  CONTEXT_EMBEDDING_DIMENSIONS,
  CONTEXT_EMBEDDING_MODEL,
  CONTEXT_REEMBED_BATCH_MAX,
  CONTEXT_SHARED_OWNER,
  contextScopeKind,
} from './constants.js';

const encryptionKeys = () => process.env[ENCRYPTION_KEYRING_ENV] ?? process.env[ENCRYPTION_KEY_ENV];

export const embedPending = internalAction({
  args: {userId: v.string()},
  handler: async (ctx, {userId}) => {
    const sealed = await ctx.runQuery(internal.context.items.modelKey, {userId});
    if (!sealed) return;
    let key: SealedSecret;
    try {
      key = await openSecret(sealed, userId, encryptionKeys());
    } catch {
      return;
    }
    const items = await ctx.runQuery(internal.context.items.pending, {userId});
    const batch = items.slice(0, CONTEXT_REEMBED_BATCH_MAX);
    if (!batch.length) return;
    let vectors: number[][];
    try {
      vectors = await embedTexts(key, CONTEXT_EMBEDDING_MODEL, CONTEXT_EMBEDDING_DIMENSIONS, batch.map(row => row.summary));
    } catch (error) {
      const retryable = !(error instanceof Error && 'kind' in error && (error.kind === 'keyInvalid' || error.kind === 'creditExhausted'));
      await ctx.runMutation(internal.context.embed.recordFailure, {
        userId,
        rows: batch.map(row => ({itemId: row._id, contentHash: row.contentHash})),
        retryable,
      });
      return;
    }
    await ctx.runMutation(internal.context.embed.writeBatch, {
      userId,
      rows: batch.map((row, index) => ({itemId: row._id, kind: row.kind, contentHash: row.contentHash, vector: vectors[index]!})),
    });
    if (items.length >= CONTEXT_REEMBED_BATCH_MAX) {
      await ctx.scheduler.runAfter(0, internal.context.embed.embedPending, {userId});
    }
  },
});

export const writeBatch = internalMutation({
  args: {userId: v.string(), rows: v.array(v.object({itemId: v.id('contextItems'), kind: v.string(), contentHash: v.string(), vector: v.array(v.float64())}))},
  handler: async (ctx, {userId, rows}) => {
    for (const input of rows) {
      if (input.vector.length !== CONTEXT_EMBEDDING_DIMENSIONS) throw new ConvexError('CONTEXT_VECTOR_DIMENSIONS');
      const item = await ctx.db.get(input.itemId);
      if (!item || (item.userId !== userId && item.userId !== CONTEXT_SHARED_OWNER)) continue;
      if (item.contentHash !== input.contentHash || item.status !== 'pending') continue;
      // Keep shared item vectors under the shared owner so readiness matches availability across accounts and purges.
      const vectorOwner = item.userId;
      const scopeKind = contextScopeKind(vectorOwner, item.kind);
      const existing = await ctx.db.query('contextVectors').withIndex('by_item', q => q.eq('itemId', item._id)).collect();
      for (const old of existing) if (old.userId === vectorOwner) await ctx.db.delete(old._id);
      await ctx.db.insert('contextVectors', {
        userId: vectorOwner, itemId: item._id, scopeKind, kind: item.kind,
        model: CONTEXT_EMBEDDING_MODEL, dimensions: CONTEXT_EMBEDDING_DIMENSIONS,
        contentHash: input.contentHash, vector: input.vector,
      });
      await ctx.db.patch(item._id, {status: 'ready', model: CONTEXT_EMBEDDING_MODEL, dimensions: CONTEXT_EMBEDDING_DIMENSIONS, attempts: 0});
    }
  },
});

export const recordFailure = internalMutation({
  args: {
    userId: v.string(),
    rows: v.array(v.object({itemId: v.id('contextItems'), contentHash: v.string()})),
    retryable: v.boolean(),
  },
  handler: async (ctx, {userId, rows, retryable}) => {
    let retryDelay = 0;
    for (const {itemId: id, contentHash} of rows) {
      const item = await ctx.db.get(id);
      if (
        !item ||
        (item.userId !== userId && item.userId !== CONTEXT_SHARED_OWNER) ||
        item.status !== 'pending' ||
        item.contentHash !== contentHash
      ) {
        continue;
      }
      const attempts = item.attempts + 1;
      const status = retryable && attempts >= CONTEXT_EMBED_ATTEMPTS_MAX ? 'failed' : 'pending';
      await ctx.db.patch(id, {attempts, status});
      if (status === 'pending' && retryable) retryDelay = Math.max(retryDelay, Math.min(2 ** attempts, 60) * 60_000);
    }
    if (retryDelay > 0) await ctx.scheduler.runAfter(retryDelay, internal.context.embed.embedPending, {userId});
  },
});

async function openSecret(value: string, userId: string, configured: string | undefined): Promise<SealedSecret> {
  const secrets = (configured ?? '').split(',').map(part => part.trim()).filter(Boolean).map(part => decodeBase64(part));
  if (!secrets.length || secrets.some(secret => secret.length !== 32)) throw new ConvexError('CONTEXT_KEY_UNAVAILABLE');
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 'v2') throw new ConvexError('CONTEXT_KEY_UNAVAILABLE');
  const [, kid, iv, tag, ciphertext] = parts;
  const match = secrets.find(secret => hex(new Uint8Array(secret)).slice(0, 12) === kid);
  if (!match) throw new ConvexError('CONTEXT_KEY_UNAVAILABLE');
  const aesKey = await crypto.subtle.importKey('raw', toBuffer(match), 'AES-GCM', false, ['decrypt']);
  const aad = toBuffer(new TextEncoder().encode(`${userId}\0modelKey`));
  const data = toBuffer(concat(decodeBase64(ciphertext!), decodeBase64(tag!)));
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: toBuffer(decodeBase64(iv!)), additionalData: aad, tagLength: 128}, aesKey, data);
  return SealedSecret.of(new TextDecoder().decode(plain));
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const value = new Uint8Array(first.length + second.length);
  value.set(first);
  value.set(second, first.length);
  return value;
}

function toBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
