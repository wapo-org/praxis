import type {MessagePart} from '@praxis/protocol';

/**
 * Port of the app's AttachmentMedia.build / AttachmentMedia.text and ConversationTitle.
 * The transcript keeps attachment references; bytes are swapped in when a provider request is built.
 */
export const MAX_INLINE_TEXT_BYTES = 200_000;
export const MAX_DOCUMENT_BYTES = 10 << 20;

export interface AttachmentRow {id: string; name: string; mediaType: string; size: number; hiddenFromCode?: boolean}

const isImage = (type: string) => type.startsWith('image/');
const isText = (type: string) => type.startsWith('text/') || ['application/json', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/csv'].includes(type);

/** Images → image parts; PDFs ≤ 10 MB and text ≤ 200 KB → document parts; everything else is named in a text line for `fs`. */
export function attachmentParts(rows: AttachmentRow[], text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const fileOnly: AttachmentRow[] = [];
  for (const row of rows) {
    if (isImage(row.mediaType)) parts.push({type: 'image', attachmentId: row.id, mediaType: row.mediaType});
    else if ((row.mediaType === 'application/pdf' && row.size <= MAX_DOCUMENT_BYTES) || (isText(row.mediaType) && row.size <= MAX_INLINE_TEXT_BYTES))
      parts.push({type: 'document', attachmentId: row.id, mediaType: row.mediaType});
    else fileOnly.push(row);
  }
  const body = withFileOnlyNote(text, fileOnly);
  if (body) parts.push({type: 'text', text: body});
  return parts;
}

function withFileOnlyNote(text: string, fileOnly: AttachmentRow[]): string {
  if (!fileOnly.length) return text;
  const names = (list: AttachmentRow[]) => list.map(f => `“${f.name}”`).join(', ');
  const readable = fileOnly.filter(f => !f.hiddenFromCode), hidden = fileOnly.filter(f => f.hiddenFromCode);
  const lines: string[] = [];
  if (readable.length) lines.push(`[Attached file${readable.length === 1 ? '' : 's'}: ${names(readable)}. Read them with \`fs\` in run_javascript.]`);
  if (hidden.length) lines.push(`[Attached file${hidden.length === 1 ? '' : 's'} hidden from code by the user: ${names(hidden)}.]`);
  const note = lines.join('\n');
  return text ? `${text}\n\n${note}` : note;
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
  const collapsed = text.split(/\s+/).filter(Boolean).join(' ');
  return collapsed ? collapsed.slice(0, MAX_TITLE) : attachmentTitle(rows);
}

/** Whether this message should (re)name the chat: untitled, or titled after attachments alone and now there are words. */
export function wantsTitle(current: string, text: string, firstTurn: {text: string; attachments: AttachmentRow[]} | undefined): boolean {
  const trimmed = current.trim();
  if (!trimmed || trimmed === TITLE_PLACEHOLDER) return true;
  if (!text.trim() || !firstTurn || firstTurn.text.trim()) return false;
  return trimmed === attachmentTitle(firstTurn.attachments);
}
