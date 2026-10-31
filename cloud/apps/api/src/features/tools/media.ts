import sharp from 'sharp';
import type {MessagePart} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import type {ToolsStorage} from './ports.js';

/** Same limits as the app's AttachmentMedia: images above these are re-encoded (deterministically) before sending. */
export const MAX_IMAGE_BYTES = 3_500_000;
export const MAX_IMAGE_SIDE = 2_000;

async function normalizedImage(bytes: Uint8Array, mediaType: string): Promise<{bytes: Uint8Array; mediaType: string}> {
  const meta = await sharp(bytes, {limitInputPixels: 100_000_000}).metadata();
  const tooBig = bytes.byteLength > MAX_IMAGE_BYTES || (meta.width ?? 0) > MAX_IMAGE_SIDE || (meta.height ?? 0) > MAX_IMAGE_SIDE;
  if (!tooBig && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType)) return {bytes, mediaType};
  const out = await sharp(bytes, {limitInputPixels: 100_000_000}).rotate().resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, {fit: 'inside', withoutEnlargement: true}).jpeg({quality: 85}).toBuffer();
  return {bytes: new Uint8Array(out), mediaType: 'image/jpeg'};
}

/**
 * Swaps an attachment reference for its bytes when a provider request is built (the transcript keeps only the
 * reference). Owner-scoped; a missing attachment becomes a short text part instead of failing the turn.
 */
export async function rehydrateAttachment(ctx: FeatureContext, storage: ToolsStorage | undefined, part: MessagePart): Promise<MessagePart> {
  if ((part.type !== 'image' && part.type !== 'document') || !part.attachmentId || part.data || part.url) return part;
  const row = await ctx.store.get(ctx.userId, 'attachment', part.attachmentId);
  if (!row || row.deleted || !storage) return {type: 'text', text: `[Attachment ${part.attachmentId} is no longer available]`};
  const file = await storage.read(ctx.userId, String(row.value.storageId));
  const {bytes, mediaType} = part.type === 'image' ? await normalizedImage(file.bytes, file.mediaType) : file;
  return {...part, mediaType, data: Buffer.from(bytes).toString('base64')};
}
