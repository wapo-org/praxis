import { MessageSchema, type Message } from '@praxis/protocol';
/** Untrusted server/markdown URLs may only navigate via these schemes. */
export function safeLink(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(
      value.trim(),
      typeof window === 'undefined' ? 'https://praxis.invalid/' : window.location.origin,
    );
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export function safeMessage(value: unknown): Message {
  const message = MessageSchema.parse(value);
  return {
    ...message,
    parts: message.parts.map((part) => (part.url ? { ...part, url: safeLink(part.url) } : part)),
  };
}
