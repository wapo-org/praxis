/** Vercel waitUntil via global symbol without @vercel/functions's vulnerable zod chain. */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

export function waitUntil(work: Promise<unknown>): void {
  const context = (globalThis as {[REQUEST_CONTEXT]?: {get?: () => {waitUntil?: (p: Promise<unknown>) => void} | undefined}})[REQUEST_CONTEXT]?.get?.();
  context?.waitUntil?.(work);
}
