import {describe, expect, it} from 'vitest';
import type {Connector} from '@praxis/protocol';
import {createLocalAdapters} from '../../local-memory.js';
import type {FeatureContext} from '../../contracts.js';
import {consentHost, requireConsent} from './shared.js';

const ctx = (): FeatureContext => ({...createLocalAdapters(), userId: 'u', local: true, fetch, egress: fetch});
const connector = (url: string) => ({type: 'connector', id: 'c', name: 'C', url, transport: 'streamableHttp', enabled: true, trusted: false, disabledTools: [], updatedAt: new Date().toISOString()}) as unknown as Connector;
const allow = (c: FeatureContext, host: string, allowed = true) => c.store.put('u', 'consent', host, {type: 'consent', host, allowed});

describe('WP-W3: MCP consent is keyed by host plus port, like provider consent', () => {
  it('uses URL.host', () => {
    expect(consentHost('http://127.0.0.1:8788/mcp')).toBe('127.0.0.1:8788');
    expect(consentHost('https://MCP.Example.com:443/mcp')).toBe('mcp.example.com');
  });
  it('accepts a host:port record and requires one for an unknown port', async () => {
    const c = ctx();
    await expect(requireConsent(c, connector('http://127.0.0.1:8788/mcp'))).rejects.toMatchObject({code: 'consent_required', message: expect.stringContaining('127.0.0.1:8788')});
    await allow(c, '127.0.0.1:8788');
    await expect(requireConsent(c, connector('http://127.0.0.1:8788/mcp'))).resolves.toBeUndefined();
    await expect(requireConsent(c, connector('http://127.0.0.1:9999/mcp'))).rejects.toMatchObject({code: 'consent_required'});
  });
  it('still honours hostname-only records saved before the change, unless a host:port record says no', async () => {
    const c = ctx();
    await allow(c, 'mcp.example.com');
    await expect(requireConsent(c, connector('https://mcp.example.com:8443/mcp'))).resolves.toBeUndefined();
    await allow(c, 'mcp.example.com:8443', false);
    await expect(requireConsent(c, connector('https://mcp.example.com:8443/mcp'))).rejects.toMatchObject({code: 'consent_required'});
  });
});
