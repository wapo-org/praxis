import {ConvexError} from 'convex/values';
import {DOCUMENT_BYTES_MAX, DOCUMENT_TOO_LARGE, jsonBytes} from '@praxis/protocol';

/** The one size check every row writer runs before a Convex write: reject with a typed error, never truncate silently. */
export function assertDocumentFits(kind: string, value: unknown): void {
  const bytes = jsonBytes(value);
  if (bytes > DOCUMENT_BYTES_MAX) {
    throw new ConvexError({code: DOCUMENT_TOO_LARGE, kind, bytes, limit: DOCUMENT_BYTES_MAX});
  }
}
