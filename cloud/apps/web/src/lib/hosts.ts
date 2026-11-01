/**
 * The consent key for a provider base URL: `URL.host` (hostname plus a non-default port), exactly what the API's
 * provider consent check uses. `hostname` would drop the port, so `http://localhost:11434` could never be allowed.
 */
export function providerConsentHost(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid provider URL');
  return url.host.toLowerCase();
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * `dev:local` mints upload URLs on the API's own origin. When the web reaches the API through the Vite proxy
 * (relative `/v1`), that absolute URL is cross-origin and would go out without auth; route it through the API base
 * instead. Only loopback `/v1/uploads/content/` URLs qualify, so hosted uploads (Convex) are never rewritten.
 */
export function localUploadPath(uploadUrl: string): string | null {
  try {
    const url = new URL(uploadUrl);
    return LOOPBACK.has(url.hostname) && url.pathname.startsWith('/v1/uploads/content/') ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}
