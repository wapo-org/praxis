import {createHmac} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {SealedSecret, TENANT_ID_PREFIX, deriveTenantId, parseTenantId, type TenantId} from './index.js';

const SECRET = 'tenant-secret-0123456789-0123456789-abcdef';
const OTHER_SECRET = 'another-secret-0123456789-0123456789-abcd';

describe('deriveTenantId', () => {
  it('is HMAC-SHA256 of the user id under the secret, hex encoded and prefixed', async () => {
    const expected = createHmac('sha256', SECRET).update('user_1').digest('hex');
    expect(await deriveTenantId('user_1', SealedSecret.of(SECRET))).toBe(`${TENANT_ID_PREFIX}${expected}`);
  });

  it('is stable for one user and differs per user and per secret', async () => {
    const secret = SealedSecret.of(SECRET);
    const first = await deriveTenantId('user_1', secret);
    expect(await deriveTenantId('user_1', secret)).toBe(first);
    expect(await deriveTenantId('user_2', secret)).not.toBe(first);
    expect(await deriveTenantId('user_1', SealedSecret.of(OTHER_SECRET))).not.toBe(first);
    expect(first).not.toContain('user_1');
  });

  it('fails closed on an empty user id or a short secret', async () => {
    await expect(deriveTenantId('', SealedSecret.of(SECRET))).rejects.toThrow('user id');
    await expect(deriveTenantId('user_1', SealedSecret.of('short'))).rejects.toThrow('at least 32 bytes');
  });
});

describe('TenantId', () => {
  it('parses a derived id and rejects a raw user id', async () => {
    const derived = await deriveTenantId('user_1', SealedSecret.of(SECRET));
    expect(parseTenantId(derived)).toBe(derived);
    expect(() => parseTenantId('user_1')).toThrow('Not a tenant id');
    expect(() => parseTenantId(`${TENANT_ID_PREFIX}ABC`)).toThrow('Not a tenant id');
  });

  it('does not accept a plain string at compile time', () => {
    const external = (tenant: TenantId) => tenant.length;
    // @ts-expect-error a raw user id is not a TenantId
    expect(external('user_1')).toBe(6);
  });
});
