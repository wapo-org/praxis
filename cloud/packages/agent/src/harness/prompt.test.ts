import {createHash} from 'node:crypto';
import {SUBAGENT_LIMITS} from '@praxis/protocol';
import {expect, it} from 'vitest';
import {COLLABORATION_INSTRUCTIONS, frozenPrompt, toolDefinitions, TURN_SYSTEM} from './prompt.js';
import {readTool} from './turn-fixture.js';

it('frozen prompt and tool-schema bytes are independent of catalog and object insertion order', () => {
  const tools = [readTool.spec, {...readTool.spec, name: 'another'}];
  const reversed = structuredClone(tools).reverse();
  reversed.forEach(tool => {
    tool.inputSchema = {required: ['query'], properties: {query: {type: 'string'}}, additionalProperties: false, type: 'object'};
  });
  const bytes = JSON.stringify(frozenPrompt(TURN_SYSTEM, tools));
  expect(JSON.stringify(frozenPrompt(TURN_SYSTEM, reversed))).toBe(bytes);
  expect(Object.keys(toolDefinitions(frozenPrompt(TURN_SYSTEM, reversed).tools))).toEqual(['another', 'read']);
  expect(Buffer.byteLength(TURN_SYSTEM)).toBe(200);
});

it('rejects ambiguous duplicate tool registrations', () => {
  expect(() => frozenPrompt(TURN_SYSTEM, [readTool.spec, readTool.spec])).toThrow('Duplicate tool');
});

it('collaboration instructions and shared tool bytes are deterministic and idempotent', async () => {
  const {harnessFixture} = await import('../subagents/tools-fixture.js');
  const specs = harnessFixture().harness.tools.map(tool => tool.spec);
  const first = frozenPrompt(TURN_SYSTEM, specs);
  expect(JSON.stringify(frozenPrompt(TURN_SYSTEM, [...specs].reverse()))).toBe(JSON.stringify(first));
  expect(frozenPrompt(first.system, first.tools)).toEqual(first);
  expect(first.system).toBe(`${TURN_SYSTEM}\n\n${COLLABORATION_INSTRUCTIONS}`);
  expect(createHash('sha256').update(COLLABORATION_INSTRUCTIONS).digest('hex')).toBe('05cebc8897d0941549281dd333934fbf08c02afa8a8621d258bf52debb51bccd');
  expect(COLLABORATION_INSTRUCTIONS).toContain(`0..${SUBAGENT_LIMITS.VISIBILITY_DEPTH_MAX}`);
  expect(Buffer.byteLength(COLLABORATION_INSTRUCTIONS)).toBeLessThan(800);
  expect(frozenPrompt(TURN_SYSTEM, [readTool.spec]).system).toBe(TURN_SYSTEM);
});
