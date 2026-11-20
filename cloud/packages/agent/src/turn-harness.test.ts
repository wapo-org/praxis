import {describe, expect, it} from 'vitest';
import {CapabilitiesSchema, type Message} from '@praxis/protocol';
import {buildTurnSnapshot, createTurnAgent, toolBoundaryClassifier} from './turn-harness.js';
import {fakeChatModel, fakeRegistry, fakeTools} from './fake-chat-model.js';
import {MessageMappingError} from './model-messages.js';
import {textResult, type AgentTool} from './types.js';
import {prompt, SCENARIO_TIME} from './turn-scenarios-fixture.js';

const model = {id: 'm', capabilities: CapabilitiesSchema.parse({tools: true}), maxTokens: 64};
const input = (history: Message[]) => ({
  userId: 'user', chatId: 'chat', mode: 'build' as const, tainted: false, system: 'S', tools: [], history, model,
});

describe('turn entry point', () => {
  it('a tool’s own boundary classification wins over the registry, which still covers the rest', () => {
    const web: AgentTool = {
      spec: {type: 'tool.spec', name: 'web_search', description: 'Search', inputSchema: {type: 'object'}, source: {type: 'builtin'}, traits: []},
      boundary: {capabilities: ['read', 'external-egress'], decision: 'allow', untrustedSource: true},
      async execute() {
        return textResult('results');
      },
    };
    const registry = toolBoundaryClassifier([web, ...fakeTools()], fakeRegistry);
    expect(registry.classify({tool: 'web_search', args: {}})).toEqual(web.boundary);
    expect(registry.classify({tool: 'write', args: {}})).toMatchObject({decision: 'approve'});
    expect(registry.classify({tool: 'unknown', args: {}})).toBeUndefined();
  });

  it('rejects a registry with duplicate tool names before any request', () => {
    const tools = fakeTools();
    expect(() => createTurnAgent({provider: fakeChatModel([]), tools: [...tools, tools[0]!], registry: fakeRegistry}))
      .toThrow('Duplicate tool names');
  });

  it('builds the snapshot through the mapper: invalid history fails closed, dangling calls are answered', () => {
    const bad: Message = {...prompt('p', 'x'), parts: [{type: 'reasoning', text: 'not a user part'}]};
    expect(() => buildTurnSnapshot(input([bad]))).toThrow(MessageMappingError);
    const dangling: Message = {type: 'message', id: 'a', chatId: 'chat', role: 'assistant', createdAt: SCENARIO_TIME,
      updatedAt: SCENARIO_TIME, parts: [{type: 'toolCall', callId: 'c', name: 'echo', arguments: '{}'}]};
    const snapshot = buildTurnSnapshot(input([prompt('p', 'x'), dangling]));
    expect(snapshot.request.messages[1]!.parts.map(p => p.type)).toEqual(['toolCall', 'toolResult']);
    expect(buildTurnSnapshot(input([prompt('p', 'x'), dangling]))).toEqual(snapshot);
  });
});
