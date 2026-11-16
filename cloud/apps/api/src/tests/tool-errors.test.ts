import {it, expect} from 'vitest';
import {z} from 'zod';
import {ToolBoundaryError, toolError, type ToolContext} from '@praxis/agent';
import type {FeatureTool} from '../contracts.js';
import {adaptTool} from '../execution-tools.js';
import {ApiError} from '../service.js';
const context: ToolContext = {
  userId: 'u', chatId: 'c', runId: 'r', callId: 'call', mode: 'auto', signal: new AbortController().signal,
  callTool: async () => ({content: [], isError: false}), emit: async () => {},
  elicit: async () => ({type: 'elicitation.response', elicitationId: 'e', action: 'cancel'}),
};
const feature = (error: unknown): FeatureTool => ({
  name: 'test', description: 'Test', source: {type: 'builtin'}, traits: [], inputSchema: {},
  execute: async () => {throw error;},
});
it.each([
  [new ApiError(400, 'invalid_path', 'Invalid path'), 'path-traversal'],
  [new ApiError(429, 'budget_exceeded', 'Budget exceeded'), 'budget'],
  [new ApiError(403, 'firewall_blocked', 'Blocked upstream'), 'upstream-firewall'],
  [new Error('Unavailable'), 'upstream'],
  [new ToolBoundaryError(toolError('taint-blocked', 'Tainted')), 'taint-blocked'],
  [z.string().safeParse(1).error, 'schema'],
])('returns structured remediation for %s', async (error, code) => {
  const result = await adaptTool(feature(error)).execute({}, context);
  expect(result.isError).toBe(true);
  expect(result.error).toMatchObject({code, remediation: expect.any(String)});
  expect(JSON.parse(String(result.content[0]?.text))).toEqual(result.error);
});
it('preserves successful tool results', async () => {
  const tool = feature(null);
  tool.execute = async () => 'done';
  expect(await adaptTool(tool).execute({}, context)).toEqual({content: [{type: 'text', text: 'done'}], isError: false});
});
it('propagates cancellation without converting it to a tool failure', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(adaptTool(feature(new Error('cancelled'))).execute({}, {...context, signal: controller.signal})).rejects.toThrow('cancelled');
});
