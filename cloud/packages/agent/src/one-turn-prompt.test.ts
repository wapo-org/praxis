import {createHash} from 'node:crypto';
import {SUBAGENT_LIMITS} from '@praxis/protocol';
import {expect, it} from 'vitest';
import {assembleTurnRequest, ONE_TURN_SYSTEM, COLLABORATION_INSTRUCTIONS} from './one-turn-prompt.js';
import {snapshot, testTool} from './one-turn-fixture.js';
import {buildProviderRequest} from './wire.js';

it('frozen prompt and tool-schema bytes are independent of catalog and object insertion order', () => {
  const request = snapshot().request;
  request.tools.push({...testTool.spec, name: 'another'});
  const reversed = structuredClone(request);
  reversed.tools.reverse();
  reversed.tools.forEach(tool => {
    tool.inputSchema = {required: ['query'], properties: {query: {type: 'string'}}, additionalProperties: false, type: 'object'};
  });
  const bytes = JSON.stringify(buildProviderRequest(assembleTurnRequest(request)));
  expect(JSON.stringify(buildProviderRequest(assembleTurnRequest(reversed)))).toBe(bytes);
  expect(JSON.stringify(buildProviderRequest(assembleTurnRequest(request)))).toBe(bytes);
  expect(Buffer.byteLength(ONE_TURN_SYSTEM)).toBe(200);
});

it('rejects ambiguous duplicate tool registrations', () => {
  const request = snapshot().request;
  request.tools.push(testTool.spec);
  expect(() => assembleTurnRequest(request)).toThrow('Duplicate tool');
});

it('collaboration instructions and shared tool bytes are deterministic and idempotent', async () => {
  const {harnessFixture} = await import('./subagents/tools-fixture.js');
  const tools = harnessFixture().harness.tools;
  const request = {...snapshot().request, tools: tools.map(tool => tool.spec)};
  const first = assembleTurnRequest(request);
  const reversed = assembleTurnRequest({...request, tools: [...request.tools].reverse()});
  expect(JSON.stringify(reversed)).toBe(JSON.stringify(first));
  expect(assembleTurnRequest(first)).toEqual(first);
  expect(first.system).toBe(`${ONE_TURN_SYSTEM}\n\n${COLLABORATION_INSTRUCTIONS}`);
  expect(createHash('sha256').update(COLLABORATION_INSTRUCTIONS).digest('hex')).toBe('05cebc8897d0941549281dd333934fbf08c02afa8a8621d258bf52debb51bccd');
  expect(COLLABORATION_INSTRUCTIONS).toContain(`0..${SUBAGENT_LIMITS.VISIBILITY_DEPTH_MAX}`);
  expect(Buffer.byteLength(COLLABORATION_INSTRUCTIONS)).toBeLessThan(800);
  expect(assembleTurnRequest(snapshot().request).system).toBe(ONE_TURN_SYSTEM);
});
