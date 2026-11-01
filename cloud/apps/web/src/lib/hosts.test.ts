// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localUploadPath, providerConsentHost } from './hosts';
import { PraxisApiClient } from './api';

describe('REV-W2: provider consent uses the same host key as the API', () => {
  it('keeps the port, so local providers like Ollama can be allowed', () => {
    expect(providerConsentHost('http://localhost:11434/v1')).toBe('localhost:11434');
    expect(providerConsentHost('https://API.Example.com/v1')).toBe('api.example.com');
    expect(providerConsentHost('https://llm.example.com:443/v1')).toBe('llm.example.com');
    expect(() => providerConsentHost('ftp://x.example')).toThrow('Invalid provider URL');
  });
});

describe('REV-W2: uploads under dev:local through the Vite proxy carry auth', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('only rewrites loopback local-upload URLs', () => {
    expect(localUploadPath('http://127.0.0.1:8823/v1/uploads/content/tok?x=1')).toBe('/v1/uploads/content/tok?x=1');
    expect(localUploadPath('http://localhost:8787/v1/uploads/content/tok')).toBe('/v1/uploads/content/tok');
    expect(localUploadPath('https://happy-otter-123.convex.cloud/api/storage/upload?token=t')).toBeNull();
    expect(localUploadPath('https://evil.example/v1/uploads/content/tok')).toBeNull();
  });
  it('sends the PUT through the API base (proxy) with the bearer token', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/v1/uploads') return Response.json({ type: 'upload.url', uploadUrl: 'http://127.0.0.1:8823/v1/uploads/content/tok', method: 'PUT', expiresAt: new Date().toISOString() });
      if (url === '/v1/uploads/content/tok') return Response.json({ type: 'upload.receipt', storageId: 's1' });
      return Response.json({ type: 'attachment', id: 'a1', name: 'n.txt', mediaType: 'text/plain', size: 1, url: 'http://127.0.0.1/x', hiddenFromCode: false, createdAt: new Date().toISOString() });
    }));
    const client = new PraxisApiClient({ baseUrl: '', bearerToken: 'dev-local' });
    await client.uploadAttachment(new File(['x'], 'n.txt', { type: 'text/plain' }));
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(put.url).toBe('/v1/uploads/content/tok');
    expect((put.init!.headers as Record<string, string>).Authorization).toBe('Bearer dev-local');
    expect(put.init!.credentials).toBe('include');
  });
});
