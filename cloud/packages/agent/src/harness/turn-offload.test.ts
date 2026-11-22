import {describe, expect, it} from 'vitest';
import {READ_TOOL_OUTPUT_TOOL_NAME, jsonBytes} from '@praxis/protocol';
import {MAX_RESULT_CHARACTERS, textResult, type ToolContext} from '../types.js';
import {MAX_READ_CHARACTERS, outputUnavailableText, toolOutputReaderTool} from '../tool-output.js';
import {turnFixture} from './turn-fixture.js';
import {runTurn} from './turn.js';

const TWO_MB = 'a'.repeat(1_048_576) + 'b'.repeat(1_048_576);

describe('tool results over MAX_RESULT_CHARACTERS (PRA-26)', () => {
  it('offload before the ledger saves the call, so the ledger and the message keep only the head and outputRef', async () => {
    const f = await turnFixture();
    const spilled: Array<{callId: string; text: string}> = [];
    f.tools = [{...f.tools[0]!, execute: async () => textResult(TWO_MB)}];
    f.spill = async (callId, text) => {
      spilled.push({callId, text});
      return 'out-1';
    };
    const run = await runTurn(f);
    expect(spilled).toEqual([{callId: 'call', text: TWO_MB}]);
    const saved = JSON.stringify(f.ledger.calls.call);
    expect(saved).toContain('"outputRef":"out-1"');
    expect(saved.length).toBeLessThan(MAX_RESULT_CHARACTERS + 2_000);
    if (run.state !== 'output') throw new Error(`Turn ended ${run.state}`);
    const result = run.output.messages.flatMap(message => message.parts).find(part => part.type === 'toolResult');
    expect(result?.outputRef).toBe('out-1');
    expect(JSON.stringify(result?.content)).toContain(`[Output truncated; ${READ_TOOL_OUTPUT_TOOL_NAME} out-1]`);
    for (const message of run.output.messages) expect(jsonBytes(message)).toBeLessThan(50_000);
  });

  it('a result at the limit stays inline, and without a spill port an oversized one is only truncated', async () => {
    const f = await turnFixture();
    f.tools = [{...f.tools[0]!, execute: async () => textResult('x'.repeat(MAX_RESULT_CHARACTERS))}];
    f.spill = async () => {
      throw new Error('not offloaded');
    };
    const inline = await runTurn(f);
    expect(inline.state).toBe('output');
    const g = await turnFixture();
    g.tools = [{...g.tools[0]!, execute: async () => textResult(TWO_MB)}];
    const run = await runTurn(g);
    if (run.state !== 'output') throw new Error(`Turn ended ${run.state}`);
    const result = run.output.messages.flatMap(message => message.parts).find(part => part.type === 'toolResult');
    expect(result?.outputRef).toBeUndefined();
    expect(JSON.stringify(result?.content)).toContain('[Output truncated]');
  });
});

describe('read_tool_output reader', () => {
  const context = {userId: 'user', chatId: 'chat'} as ToolContext;

  it('pages with a character header and clamps the page size', async () => {
    const tool = toolOutputReaderTool(async (_context, _id, offset, limit) => ({page: TWO_MB.slice(offset, offset + limit), characters: TWO_MB.length}));
    const page = await tool.execute({id: 'out-1', offset: 1_048_570, limit: 99_999}, context);
    const text = String(page.content[0]?.text);
    expect(text.startsWith(`[characters 1048570–${1_048_570 + MAX_READ_CHARACTERS} of ${TWO_MB.length}]\naaaaaab`)).toBe(true);
  });

  it('answers a purged output with plain text instead of an error that would fail the turn', async () => {
    const tool = toolOutputReaderTool(async () => undefined);
    expect(await tool.execute({id: 'gone', offset: 0}, context))
      .toEqual({content: [{type: 'text', text: outputUnavailableText('gone')}], isError: false});
    expect(outputUnavailableText('gone')).toContain('no longer available');
  });
});
