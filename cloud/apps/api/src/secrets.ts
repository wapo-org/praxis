import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {ApiError} from './service.js';

/**
 * AES-256-GCM secrets bound to (owner, resource) as authenticated data.
 *
 * `key` is a keyring string: comma-separated base64 32-byte keys, current first (`PRAXIS_ENCRYPTION_KEYS`;
 * a single key, the old `PRAXIS_ENCRYPTION_KEY`, is a ring of one). New values are `v2.<kid>.<iv>.<tag>.<data>`
 * where kid is the first 12 hex chars of SHA-256(key), so decrypt picks the right key without trying all of them.
 * Legacy `v1.<iv>.<tag>.<data>` values (no kid) are tried against every key in the ring.
 */
export interface Keyring {current: {kid: string; key: Buffer}; all: {kid: string; key: Buffer}[]}

export const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 12);

export function parseKeyring(ring: string | undefined): Keyring {
  const keys = (ring ?? '').split(',').map(k => k.trim()).filter(Boolean).map(k => Buffer.from(k, 'base64'));
  if (!keys.length || keys.some(k => k.length !== 32)) throw new ApiError(503, 'encryption_unconfigured', 'Secret storage is not configured');
  const all = keys.map(key => ({kid: keyId(key), key}));
  return {current: all[0]!, all};
}

const aad = (userId: string, resource: string) => Buffer.from(`${userId}\0${resource}`);

export function seal(value: string, userId: string, resource: string, key: string | undefined): string {
  const {current} = parseKeyring(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  cipher.setAAD(aad(userId, resource));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v2', current.kid, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function open(key: Buffer, iv: string, tag: string, data: string, userId: string, resource: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(aad(userId, resource));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export function unseal(value: string, userId: string, resource: string, key: string): string {
  const ring = parseKeyring(key);
  const parts = value.split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, iv, tag, data] = parts as [string, string, string, string, string];
    const match = ring.all.find(k => k.kid === kid);
    if (!match) throw new Error('Encryption key for this value is not configured');
    return open(match.key, iv, tag, data, userId, resource);
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    const [, iv, tag, data] = parts as [string, string, string, string];
    for (const k of ring.all) {
      try {
        return open(k.key, iv, tag, data, userId, resource);
      } catch {
        // try the next key
      }
    }
    throw new Error('No configured encryption key opens this value');
  }
  throw new Error('Invalid encrypted value');
}

/** True when the value is already sealed with the ring's current key. */
export function sealedWithCurrent(value: string, key: string): boolean {
  const parts = value.split('.');
  return parts[0] === 'v2' && parts[1] === parseKeyring(key).current.kid;
}
