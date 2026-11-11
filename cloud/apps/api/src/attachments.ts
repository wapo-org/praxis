import {ATTACHMENT_LIMITS, type MessagePart} from '@praxis/protocol';

/**
 * Port of the app's AttachmentMedia.build / AttachmentMedia.text and ConversationTitle.
 * The transcript keeps attachment references; bytes are swapped in when a provider request is built.
 */
export const MAX_INLINE_TEXT_BYTES = ATTACHMENT_LIMITS.inlineTextBytes;
export const MAX_DOCUMENT_BYTES = ATTACHMENT_LIMITS.inlineDocumentBytes;

export interface AttachmentRow {id: string; name: string; mediaType: string; size: number; hiddenFromCode?: boolean}

const isImage = (type: string) => type.startsWith('image/');
export const isText = (type: string) => type.startsWith('text/') || ['application/json', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/csv'].includes(type);

/**
 * Images → image parts; PDFs ≤ 10 MB and text ≤ 200 KB → document parts; everything else → one `note` part per
 * file that names it for `fs`. The note carries the attachment ID, so the transcript shows the file as an
 * attachment and the model reads the note; the user's own text part stays exactly what they typed.
 */
export function attachmentParts(rows: AttachmentRow[], text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const fileOnly: AttachmentRow[] = [];
  for (const row of rows) {
    if (isImage(row.mediaType)) parts.push({type: 'image', attachmentId: row.id, mediaType: row.mediaType});
    else if ((row.mediaType === 'application/pdf' && row.size <= MAX_DOCUMENT_BYTES) || (isText(row.mediaType) && row.size <= MAX_INLINE_TEXT_BYTES))
      parts.push({type: 'document', attachmentId: row.id, mediaType: row.mediaType});
    else fileOnly.push(row);
  }
  for (const row of fileOnly) parts.push({type: 'note', attachmentId: row.id, mediaType: row.mediaType, text: fileOnlyNote(row)});
  if (text) parts.push({type: 'text', text});
  return parts;
}

/** The model-facing line for a file it can only reach through `fs` (or not at all, when hidden from code). */
export function fileOnlyNote(row: AttachmentRow): string {
  return row.hiddenFromCode
    ? `[Attached file hidden from code by the user: “${row.name}”.]`
    : `[Attached file: “${row.name}”. Read them with \`fs\` in run_javascript.]`;
}

export const TITLE_PLACEHOLDER = 'New chat';
const MAX_TITLE = 42;

/** "Photo", a lone file's name, "3 photos", "2 files", "4 attachments". (No screenshot/camera kinds in the cloud.) */
export function attachmentTitle(rows: AttachmentRow[]): string | undefined {
  const first = rows[0];
  if (!first) return undefined;
  if (rows.length === 1) return isImage(first.mediaType) ? 'Photo' : first.name.trim().slice(0, MAX_TITLE) || 'File';
  if (rows.every(r => isImage(r.mediaType))) return `${rows.length} photos`;
  if (rows.every(r => !isImage(r.mediaType))) return `${rows.length} files`;
  return `${rows.length} attachments`;
}

export function makeTitle(text: string, rows: AttachmentRow[]): string | undefined {
  const filler=new Set('a an the please can could would you i me my help with to for of and how do does want need'.split(' '));
  const words=(text.match(/[\p{L}\p{N}]+/gu)??[]).filter(w=>!filler.has(w.toLowerCase())).slice(0,5);
  const collapsed=words.map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
  return collapsed ? collapsed.slice(0, MAX_TITLE) : attachmentTitle(rows);
}

/** Whether this message should (re)name the chat: untitled, or titled after attachments alone and now there are words. */
export function wantsTitle(current: string, text: string, firstTurn: {text: string; attachments: AttachmentRow[]} | undefined): boolean {
  const trimmed = current.trim();
  if (!trimmed || trimmed === TITLE_PLACEHOLDER) return true;
  if (!text.trim() || !firstTurn || firstTurn.text.trim()) return false;
  return trimmed === attachmentTitle(firstTurn.attachments);
}
