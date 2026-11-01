/** Tag the blob itself, not just its ticket: interrupted uploads can then be erased too. */
export async function blobOwnerTag(userId: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId)),
  );
  return `praxis-owner=${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
