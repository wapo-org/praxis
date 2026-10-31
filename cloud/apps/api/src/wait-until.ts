/**
 * Vercel's `waitUntil`, without the @vercel/functions package (its OIDC dependency chain pins a vulnerable zod).
 * Same mechanism: the platform exposes the request context on a well-known global symbol; locally there is none,
 * and the work simply keeps running in the process.
 */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

export function waitUntil(work: Promise<unknown>): void {
  const context = (globalThis as {[REQUEST_CONTEXT]?: {get?: () => {waitUntil?: (p: Promise<unknown>) => void} | undefined}})[REQUEST_CONTEXT]?.get?.();
  context?.waitUntil?.(work);
}
