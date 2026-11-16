import {describe, expect, it} from 'vitest';
import {createCipheriv, randomBytes} from 'node:crypto';
import {createLocalAdapters} from '../local-memory.js';
import {reencryptAll} from '../reencrypt.js';
import {keyId, seal, sealedWithCurrent, unseal} from '../secrets.js';
import {convexHarness} from '../adapters/testing/convex-harness.js';
import {storeFromRPC} from '../adapters/convex.js';

const A = randomBytes(32).toString('base64'), B = randomBytes(32).toString('base64'), C = randomBytes(32).toString('base64');

/** The pre-versioning format (`v1.<iv>.<tag>.<data>`), as written before key ids existed. */
function legacySeal(value: string, userId: string, resource: string, key: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(Buffer.from(`${userId}\0${resource}`));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

describe('versioned encryption keys', () => {
  it('tags ciphertext with the current key id and decrypts across the ring', () => {
    const sealed = seal('sk-secret', 'u', 'provider:p:key', A);
    expect(sealed.split('.').slice(0, 2)).toEqual(['v2', keyId(Buffer.from(A, 'base64'))]);
    expect(unseal(sealed, 'u', 'provider:p:key', `${B},${A}`)).toBe('sk-secret');
    expect(() => unseal(sealed, 'u', 'provider:p:key', B)).toThrow('not configured');
    expect(() => unseal(sealed, 'other', 'provider:p:key', A)).toThrow();
    expect(sealedWithCurrent(seal('x', 'u', 'r', `${B},${A}`), `${B},${A}`)).toBe(true);
  });
  it('still opens legacy v1 values with any key in the ring', () => {
    const legacy = legacySeal('old', 'u', 'voice', A);
    expect(unseal(legacy, 'u', 'voice', `${B},${A}`)).toBe('old');
    expect(() => unseal(legacy, 'u', 'voice', B)).toThrow();
  });
  it('rejects malformed keyrings', () => {
    expect(() => seal('x', 'u', 'r', `${A},short`)).toThrow();
    expect(() => seal('x', 'u', 'r', undefined)).toThrow();
  });
});

describe('re-encryption for rotation', () => {
  it('re-seals the model key, voice and MCP secrets with the new key; unopenable values are counted, not dropped', async () => {
    const {store} = createLocalAdapters();
    await store.put('u1', 'modelKey', 'current', {type: 'modelKey', maskedKey: '••••sk-1', sealed: seal('sk-or-1', 'u1', 'modelKey', A)});
    await store.put('u1', 'voiceSecret', 'current', {key: legacySeal('gsk', 'u1', 'voice', A)});
    await store.put('u2', 'mcpSecret', 'c1', {token: seal('"t"', 'u2', 'mcp:c1:token', A), tokens: seal('{}', 'u2', 'mcp:c1:tokens', C)});
    const ring = `${B},${A}`;
    const dry = await reencryptAll(store, ['u1', 'u2'], ring, true);
    expect(dry).toMatchObject({owners: 2, rewritten: 3, failed: 1});
    expect((await store.get('u1', 'voiceSecret', 'current'))!.value.key).toMatch(/^v1\./);

    const stats = await reencryptAll(store, ['u1', 'u2'], ring);
    expect(stats).toMatchObject({owners: 2, rows: 3, rewritten: 3, failed: 1});
    const key = (await store.get('u1', 'modelKey', 'current'))!.value;
    expect(unseal(String(key.sealed), 'u1', 'modelKey', B)).toBe('sk-or-1');
    expect(key.maskedKey).toBe('••••sk-1'); // only the sealed field is touched
    expect(unseal(String((await store.get('u1', 'voiceSecret', 'current'))!.value.key), 'u1', 'voice', B)).toBe('gsk');
    const mcp = (await store.get('u2', 'mcpSecret', 'c1'))!.value;
    expect(unseal(String(mcp.token), 'u2', 'mcp:c1:token', B)).toBe('"t"');
    expect(unseal(String(mcp.tokens), 'u2', 'mcp:c1:tokens', C)).toBe('{}');
    expect(await reencryptAll(store, ['u1', 'u2'], ring)).toMatchObject({rewritten: 0, failed: 1});
  });
  it('enumerates every owner from Convex for the rotation script', async () => {
    const store = storeFromRPC(convexHarness().rpc);
    await store.put('alice', 'chat', 'c', {x: 1});
    await store.put('bob', 'modelKey', 'current', {sealed: seal('k', 'bob', 'modelKey', A)});
    const owners: string[] = [];
    for await (const o of store.owners()) owners.push(o);
    expect(owners.sort()).toEqual(['alice', 'bob']);
  });
});

describe('REV-A2 rotation races', () => {
  it.each(['update', 'delete'])('preserves a concurrent credential %s and remains idempotent', async action => {
    const {store} = createLocalAdapters();
    await store.put('u', 'modelKey', 'current', {sealed: seal('old', 'u', 'modelKey', A)});
    const list = store.list.bind(store);
    let intercepted = false;
    store.list = async (...args) => {
      const snapshot = await list(...args);
      if (!intercepted && args[1] === 'modelKey') {
        intercepted = true;
        if (action === 'delete') await store.delete('u', 'modelKey', 'current');
        else await store.put('u', 'modelKey', 'current', {sealed: seal('new', 'u', 'modelKey', A)});
      }
      return snapshot;
    };
    const stats = await reencryptAll(store, ['u'], `${B},${A}`);
    expect(intercepted).toBe(true);
    expect(stats.failed).toBe(0);
    const row = (await store.get('u', 'modelKey', 'current'))!;
    if (action === 'delete') expect(row.deleted).toBe(true);
    else expect(unseal(String(row.value.sealed), 'u', 'modelKey', B)).toBe('new');
    expect(await reencryptAll(store, ['u'], `${B},${A}`)).toMatchObject({rewritten: 0, failed: 0});
  });
});
