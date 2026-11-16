import { ATTACHMENT_LIMITS } from '@praxis/protocol';

export type AttachmentKind = 'image' | 'pdf' | 'archive' | 'sheet' | 'code' | 'text' | 'audio' | 'video' | 'file';

const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
const ARCHIVES = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
const SHEETS = new Set(['csv', 'tsv', 'xls', 'xlsx', 'numbers', 'ods']);
const CODE = new Set(['js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'swift', 'java', 'kt', 'c', 'h', 'cpp', 'css', 'html', 'json', 'yaml', 'yml', 'xml', 'sh', 'sql']);

export function attachmentKind(name: string, mediaType: string): AttachmentKind {
  const e = ext(name);
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType === 'application/pdf' || e === 'pdf') return 'pdf';
  if (ARCHIVES.has(e) || /zip|tar|compressed|archive|x-7z|rar/.test(mediaType)) return 'archive';
  if (SHEETS.has(e) || /csv|spreadsheet|excel/.test(mediaType)) return 'sheet';
  if (CODE.has(e) || /json|javascript|typescript|x-python|xml|yaml/.test(mediaType)) return 'code';
  if (mediaType.startsWith('text/') || ['txt', 'md', 'rtf'].includes(e)) return 'text';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  return 'file';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? String(Math.round(mb * 10) / 10) : Math.round(mb)} MB`;
}

const isInlineText = (kind: AttachmentKind, mediaType: string) => kind === 'text' || kind === 'code' || kind === 'sheet' || mediaType.startsWith('text/');

export function attachmentLimit(file: { name: string; mediaType: string; size: number }): { level: 'block' | 'warn'; message: string } | null {
  const { uploadBytes, inlineDocumentBytes, inlineTextBytes, codeReadBytes } = ATTACHMENT_LIMITS;
  if (file.size > uploadBytes) return { level: 'block', message: `Too large to attach. The limit is ${formatBytes(uploadBytes)}.` };
  const kind = attachmentKind(file.name, file.mediaType);
  if (kind === 'image') return null;
  if (kind === 'pdf' && file.size <= inlineDocumentBytes) return null;
  if (isInlineText(kind, file.mediaType) && file.size <= inlineTextBytes) return null;
  if (file.size > codeReadBytes) return { level: 'warn', message: `Too large for Praxis to open. It reads files up to ${formatBytes(codeReadBytes)}.` };
  return null;
}
