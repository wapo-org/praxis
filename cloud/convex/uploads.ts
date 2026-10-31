import {v} from 'convex/values';
import {makeFunctionReference, type GenericActionCtx, type GenericDataModel} from 'convex/server';
import {internalMutation} from './functions.js';
import {MAX_BYTES} from './files.js';

/** Consumes the capability before receiving bytes: concurrent POSTs cannot upload under one ticket. */
export const begin = internalMutation({
  args: {ticket: v.string(), mediaType: v.string()},
  handler: async (ctx, a) => {
    const row = await ctx.db.query('files').withIndex('ticket', q => q.eq('ticket', a.ticket)).unique();
    if (!row || row.status !== 'pending' || row.expiresAt <= Date.now() || a.mediaType !== row.mediaType) return null;
    await ctx.db.patch(row._id, {status: 'uploading'});
    return {id: row._id, size: row.size};
  },
});

/** Internal only: clients cannot bind arbitrary storage ids, even with their own ticket. */
export const finish = internalMutation({
  args: {id: v.id('files'), storageId: v.id('_storage')},
  handler: async (ctx, a) => {
    const row = await ctx.db.get(a.id);
    if (!row || row.status !== 'uploading' || row.expiresAt <= Date.now()) return false;
    const meta = await ctx.db.system.get(a.storageId);
    if (!meta || meta.size !== row.size || !meta.contentType || meta.contentType.split(';')[0]?.trim() !== row.mediaType) return false;
    await ctx.db.patch(a.id, {storageId: a.storageId, status: 'uploaded'});
    return true;
  },
});

export async function upload(ctx: GenericActionCtx<GenericDataModel>, request: Request): Promise<Response> {
  const ticket = new URL(request.url).pathname.slice('/uploads/'.length);
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim();
  if (!mediaType || !/^[a-f0-9-]{36}$/.test(ticket)) return new Response('Invalid upload', {status: 400});
  const pending = await ctx.runMutation(makeFunctionReference<'mutation', {ticket: string; mediaType: string}, {id: import('convex/values').GenericId<'files'>; size: number} | null>('uploads:begin'), {ticket, mediaType});
  if (!pending) return new Response('Upload ticket unavailable', {status: 404});
  // Bound buffering even without Content-Length; no bytes are passed as a Convex function argument.
  const reader = request.body?.getReader();
  if (!reader) return new Response('Missing upload', {status: 400});
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > pending.size || size > MAX_BYTES) { await reader.cancel(); return new Response('Upload size mismatch', {status: 400}); }
      chunks.push(Uint8Array.from(value));
    }
  } finally { reader.releaseLock(); }
  if (size !== pending.size) return new Response('Upload size mismatch', {status: 400});
  const storageId = await ctx.storage.store(new Blob(chunks, {type: mediaType}));
  const bound = await ctx.runMutation(makeFunctionReference<'mutation', {id: typeof pending.id; storageId: typeof storageId}, boolean>('uploads:finish'), {id: pending.id, storageId});
  if (!bound) { await ctx.storage.delete(storageId); return new Response('Upload expired', {status: 400}); }
  return Response.json({storageId});
}
