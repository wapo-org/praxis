import type {SealedSecret} from './sealed-secret.js';

declare const tenantIdBrand: unique symbol;

/** The only owner identifier external services may see; a raw `userId` is not assignable to it. */
export type TenantId = string & {readonly [tenantIdBrand]: 'TenantId'};

export const TENANT_ID_PREFIX = 'tn_';
/** HMAC-SHA256 output is 32 bytes, so 64 hex characters. */
export const TENANT_ID_HEX_LENGTH = 64;
/** A shorter HMAC key is weaker than the digest it produces. */
export const TENANT_SECRET_MIN_BYTES = 32;

const TENANT_ID_PATTERN = new RegExp(`^${TENANT_ID_PREFIX}[0-9a-f]{${TENANT_ID_HEX_LENGTH}}$`);

/** Parses a stored tenant id; anything else (a raw user id above all) throws. */
export function parseTenantId(value: string): TenantId {
  if (!TENANT_ID_PATTERN.test(value)) throw new Error('Not a tenant id');
  return value as TenantId;
}

/** Stable per user and secret; without the secret it cannot be linked back to the user id. */
export async function deriveTenantId(userId: string, secret: SealedSecret): Promise<TenantId> {
  if (!userId) throw new Error('deriveTenantId needs a user id');
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret.reveal());
  if (keyBytes.byteLength < TENANT_SECRET_MIN_BYTES) {
    throw new Error(`The tenant secret must be at least ${TENANT_SECRET_MIN_BYTES} bytes`);
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(userId)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${TENANT_ID_PREFIX}${hex}` as TenantId;
}
