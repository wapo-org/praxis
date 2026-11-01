import sharp from 'sharp';
import type {MessagePart} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import {isText, MAX_INLINE_TEXT_BYTES} from '../../attachments.js';
import {type ModelCapabilities} from '../../media-provider.js';
import type {ToolsStorage} from './ports.js';

/** Same limits as the app's AttachmentMedia: images above these are re-encoded (deterministically) before sending. */
export const MAX_IMAGE_BYTES = 3_500_000;
export const MAX_IMAGE_SIDE = 2_000;
/** Decoding past this is refused (≈160 MB of RGBA); sharp's default (268 MP) is too much for a shared instance. */
export const MAX_INPUT_PIXELS = 40_000_000;
/** Re-encoded images are cached per stored file so history isn't decoded again on every slice. */
export const IMAGE_CACHE_TTL_SECONDS = 7 * 24 * 3600;
const MAX_CACHED_BASE64 = 1_500_000;
const DECODE_CONCURRENCY = 1;

let decoding = 0;
const waiting: (() => void)[] = [];
/** Process-wide bound on concurrent decodes: runs of every user share this instance's memory. */
async function decodeSlot<T>(task: () => Promise<T>): Promise<T> {
  if (decoding >= DECODE_CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve));
  decoding++;
  try { return await task(); } finally { decoding--; waiting.shift()?.(); }
}

async function normalizedImage(bytes: Uint8Array, mediaType: string): Promise<{bytes: Uint8Array; mediaType: string; reencoded: boolean}> {
  const meta = await sharp(bytes, {limitInputPixels: MAX_INPUT_PIXELS}).metadata(); // header only
  const tooBig = bytes.byteLength > MAX_IMAGE_BYTES || (meta.width ?? 0) > MAX_IMAGE_SIDE || (meta.height ?? 0) > MAX_IMAGE_SIDE;
  if (!tooBig && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType)) return {bytes, mediaType, reencoded: false};
  const out = await decodeSlot(() => sharp(bytes, {limitInputPixels: MAX_INPUT_PIXELS}).rotate().resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, {fit: 'inside', withoutEnlargement: true}).jpeg({quality: 85}).toBuffer());
  return {bytes: new Uint8Array(out), mediaType: 'image/jpeg', reencoded: true};
}

class Unavailable extends Error {}
const note = (text: string): MessagePart => ({type: 'text', text});

async function imagePart(ctx: FeatureContext, storage: ToolsStorage, part: MessagePart, storageId: string): Promise<MessagePart> {
  const key = `media:v1:${ctx.userId}:${storageId}`;
  const cached = await ctx.kv.get<{mediaType: string; data: string}>(key).catch(() => null);
  if (cached?.data) return {...part, mediaType: cached.mediaType, data: cached.data};
  const file = await storage.read(ctx.userId, storageId);
  const {bytes, mediaType, reencoded} = await normalizedImage(file.bytes, file.mediaType);
  const data = Buffer.from(bytes).toString('base64');
  if (reencoded && data.length <= MAX_CACHED_BASE64) await ctx.kv.set(key, {mediaType, data}, IMAGE_CACHE_TTL_SECONDS).catch(() => undefined);
  return {...part, mediaType, data};
}

/** Text files reach every model as text (no provider takes base64 text documents), under the inline cap. */
async function textPart(ctx: FeatureContext, storage: ToolsStorage, name: string, storageId: string): Promise<MessagePart> {
  const file = await storage.read(ctx.userId, storageId);
  let text: string;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(file.bytes.subarray(0, MAX_INLINE_TEXT_BYTES)); }
  catch { throw new Unavailable(`“${name}” is not valid UTF-8 text`); }
  const truncated = file.bytes.byteLength > MAX_INLINE_TEXT_BYTES ? `\n[truncated at ${MAX_INLINE_TEXT_BYTES} bytes of ${file.bytes.byteLength}]` : '';
  return note(`[File: “${name}”]\n${text}${truncated}`);
}

/**
 * Swaps an attachment reference for what the model can take when a provider request is built (the transcript keeps
 * only the reference). Owner-scoped. Anything that can't be shown becomes a short text part (the caller logs it).
 */
export async function rehydrateAttachment(ctx: FeatureContext, storage: ToolsStorage | undefined, part: MessagePart, caps: ModelCapabilities): Promise<MessagePart> {
  if ((part.type !== 'image' && part.type !== 'document') || !part.attachmentId || part.data || part.url) return part;
  const text = part.type === 'document' && isText(part.mediaType ?? '');
  if (part.type === 'image' && !caps.vision) return part; // the wire says it's omitted (and offers look_at_image)
  const row = await ctx.store.get(ctx.userId, 'attachment', part.attachmentId);
  if (!row || row.deleted) throw new Unavailable('it was deleted');
  if (!storage) throw new Unavailable('attachment storage is not configured');
  const name = String(row.value.name ?? 'file'), storageId = String(row.value.storageId);
  if (text) return textPart(ctx, storage, name, storageId);
  if (part.type === 'document' && !caps.documents)
    return note(`[Attached PDF “${name}”: this model can't read documents.${row.value.hiddenFromCode === true ? '' : ' Read it with `fs` in run_javascript.'}]`);
  if (part.type === 'image') return imagePart(ctx, storage, part, storageId);
  const file = await storage.read(ctx.userId, storageId);
  return {...part, mediaType: file.mediaType, data: Buffer.from(file.bytes).toString('base64')};
}
