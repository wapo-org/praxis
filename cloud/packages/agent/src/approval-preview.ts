import {APPROVAL_PREVIEW_CHARACTERS_MAX, type JsonObject, type JsonValue} from '@praxis/protocol';
import {redactKey} from './openrouter.js';

const SENSITIVE_FIELD = /password|passphrase|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie|^headers$|^env$|^auth$|(?:^|[_-])key(?:$|[_-])/i;
const INLINE_SECRET = /\b(password|passphrase|secret|token|api[_-]?key|private[_-]?key|authorization|auth|key)(\s*[:=]\s*|\s+(?:is\s+)?)(?:"[^"]*"|'[^']*'|\S+)/gi;
const URL_CREDENTIALS = /(:\/\/)[^\s/@]+@/g;
const PREVIEW_DEPTH_MAX = 4;
const PREVIEW_ENTRIES_MAX = 12;
const PREVIEW_FIELD_CHARACTERS_MAX = 400;
const REDACTED = '[redacted]';

function object(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function safeText(value: string): string {
  const redacted = redactKey(value).replace(URL_CREDENTIALS, '$1[redacted]@').replace(INLINE_SECRET, '$1$2[redacted]');
  return redacted.length > PREVIEW_FIELD_CHARACTERS_MAX ? redacted.slice(0, PREVIEW_FIELD_CHARACTERS_MAX - 1) + '…' : redacted;
}

function redact(value: JsonValue, schema: JsonObject | undefined, depth: number): JsonValue {
  if (schema?.format === 'password' || schema?.['x-sensitive'] === true || schema?.writeOnly === true) return REDACTED;
  if (typeof value === 'string') return safeText(value);
  if (!value || typeof value !== 'object') return value;
  if (depth >= PREVIEW_DEPTH_MAX) return '…';
  if (Array.isArray(value)) {
    const items = value.slice(0, PREVIEW_ENTRIES_MAX).map(item => redact(item, object(schema?.items), depth + 1));
    return value.length > items.length ? [...items, '…'] : items;
  }
  const properties = object(schema?.properties);
  const entries = Object.entries(value);
  const fields = entries.slice(0, PREVIEW_ENTRIES_MAX).map(([key, entry]) => [
    safeText(key),
    SENSITIVE_FIELD.test(key) ? REDACTED : redact(entry, object(properties?.[key]), depth + 1),
  ]);
  if (entries.length > fields.length) fields.push(['…', 'Additional fields omitted']);
  return Object.fromEntries(fields);
}

export function approvalPreview(args: JsonValue, schema: JsonObject): string {
  if (args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0) return '';
  const preview = JSON.stringify(redact(args, schema, 0), null, 2);
  if (preview.length <= APPROVAL_PREVIEW_CHARACTERS_MAX) return preview;
  return preview.slice(0, APPROVAL_PREVIEW_CHARACTERS_MAX - 1) + '…';
}
