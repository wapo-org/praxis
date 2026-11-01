import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {createLocalAdapters} from '../local-memory.js';
import {createExecutionDriver} from '../execution.js';
import {ApiService} from '../service.js';
import {createApp} from '../app.js';
import {withGateway} from '../modules.js';
import type {FeatureTool} from '../contracts.js';
import {delta, fakeOpenAI, toolCall} from './harness.js';

describe('REV-R1 P2: the gateway catalog is frozen with the conversation', () => {
  it('connector tools added after a gateway chat started are neither searchable nor callable there', async () => {
    let count = 31;
    const calls: string[] = [];
    const tools = (): FeatureTool[] => Array.from({length: count}, (_, i) => ({
      name: `tool_${i}`, description: `Tool ${i}`, inputSchema: {type: 'object'}, source: {type: 'mcp' as const, serverId: 'big', serverName: 'Big'}, traits: ['readOnly' as const],
      execute: async () => { calls.push(`tool_${i}`); return `result ${i}`; },
    }));
    const fake = fakeOpenAI([
      [delta({content: 'hi'}), delta({}, 'stop')],
      toolCall('mcp_call_tool', {tool: 'tool_35', arguments: {}}), [delta({content: 'done'}), delta({}, 'stop')],
      toolCall('mcp_search_tools', {query: 'tool_35'}), [delta({content: 'done'}), delta({}, 'stop')],
    ]);
    const service = new ApiService(createLocalAdapters(), true);
    service.driver = createExecutionDriver({service, fetcher: fake.fetcher, features: {tools: async (_ctx, {chat}) => withGateway(chat, tools())}});
    const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64'), fetcher: fake.fetcher});
    const req = async (path: string, body?: unknown) => app.request(path, {method: body ? 'POST' : 'GET', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    await service.adapters.store.put('local-user', 'connector', 'big', {type: 'connector', id: 'big', name: 'Big', url: 'https://big.example/mcp', transport: 'streamableHttp', enabled: true, trusted: true, disabledTools: [], authStatus: 'none', updatedAt: new Date().toISOString()});
    const provider = await (await req('/v1/providers', {type: 'provider.input', name: 'F', flavor: 'openAIChat', baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-test-123456', capabilities: {tools: true}})).json();
    await req('/v1/consents', {type: 'consent', host: 'llm.example.test', allowed: true});
    const chat = await (await req('/v1/chats', {type: 'chat.input', providerId: provider.id, modelId: 'm'})).json();
    const run = async () => { await req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'go'}); await service.drain(); };

    await run();
    const stored = await (await req(`/v1/chats/${chat.id}`)).json();
    expect(stored.setup.hiddenTools.map((t: {name: string}) => t.name)).toHaveLength(31);
    count = 40;
    await run();
    expect(calls).toEqual([]);
    expect(JSON.stringify(fake.requests[2].messages)).toContain('MCP tool not found');
    await run();
    expect(JSON.stringify(fake.requests[4].messages)).not.toContain('Tool 35');
  });
});
