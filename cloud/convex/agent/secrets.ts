import {SealedSecret} from '@praxis/types';
import {AGENT_ERRORS, ENCRYPTION_KEY_BYTES, ENCRYPTION_KEYRING_ENV, ENCRYPTION_KEY_ENV} from './constants.js';

/** The 12-hex SHA-256 key id `apps/api/src/secrets.ts` writes into every sealed value. */
async function keyId(key: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

function base64Bytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function keyring(): Uint8Array<ArrayBuffer>[] {
  const ring = (process.env[ENCRYPTION_KEYRING_ENV] ?? process.env[ENCRYPTION_KEY_ENV] ?? '').split(',');
  const keys = ring.map(key => key.trim()).filter(Boolean).map(base64Bytes);
  if (!keys.length || keys.some(key => key.length !== ENCRYPTION_KEY_BYTES)) throw new Error(AGENT_ERRORS.encryption);
  return keys;
}

/** AES-256-GCM `v2.<kid>.<iv>.<tag>.<data>` bound to `${userId}\0${resource}`, the format `seal` writes in apps/api. */
export async function unsealSecret(value: string, userId: string, resource: string): Promise<SealedSecret> {
  const [version, kid, iv, tag, data, ...rest] = value.split('.');
  if (version !== 'v2' || !kid || !iv || !tag || data === undefined || rest.length) throw new Error(AGENT_ERRORS.sealed);
  let match: Uint8Array<ArrayBuffer> | undefined;
  for (const key of keyring()) if (await keyId(key) === kid) match = key;
  if (!match) throw new Error(AGENT_ERRORS.sealed);
  const cipher = await crypto.subtle.importKey('raw', match, {name: 'AES-GCM'}, false, ['decrypt']);
  const sealed = new Uint8Array([...base64Bytes(data), ...base64Bytes(tag)]);
  const plain = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: base64Bytes(iv), additionalData: new TextEncoder().encode(`${userId}\0${resource}`),
  }, cipher, sealed).catch(() => {
    throw new Error(AGENT_ERRORS.sealed);
  });
  return SealedSecret.of(new TextDecoder().decode(plain));
}
