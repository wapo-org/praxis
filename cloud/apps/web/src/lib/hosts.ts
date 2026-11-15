/** Use URL.host (preserving non-default ports) to match API consent keys. */
export function providerConsentHost(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid provider URL');
  return url.host.toLowerCase();
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Rewrite loopback /v1/uploads/content/ URLs through API base so Vite proxy requests keep auth. */
export function localUploadPath(uploadUrl: string): string | null {
  try {
    const url = new URL(uploadUrl);
    return LOOPBACK.has(url.hostname) && url.pathname.startsWith('/v1/uploads/content/') ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}
