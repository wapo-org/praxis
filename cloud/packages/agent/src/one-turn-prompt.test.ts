import {expect, it} from 'vitest';
import {assembleTurnRequest, ONE_TURN_SYSTEM} from './one-turn-prompt.js';
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
