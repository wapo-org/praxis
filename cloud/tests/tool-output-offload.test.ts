import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DOCUMENT_TOO_LARGE, TOOL_OUTPUT_CHUNK_CHARACTERS_MAX, jsonBytes, type Message, type TurnCommit} from '@praxis/protocol';
import {compactResult, outputUnavailableText, textResult, type ToolContext} from '@praxis/agent';
import {internal} from '../convex/_generated/api.js';
import type {ActionCtx} from '../convex/functions.js';
import {convexOutputReaderTool, convexSpill} from '../convex/agent/outputs.js';
import {OUTPUT_ORPHAN_AGE_MS} from '../convex/outputConstants.js';
import {SERVER_TOKEN, startedRun} from './workflow-fixture.js';
import {assistantMessage} from './workflow-commit.js';

const TWO_MB = Array.from({length: 2_097_152 / 16}, (_, index) => index.toString(16).padStart(16, '0')).join('');
type Started = Awaited<ReturnType<typeof startedRun>>;
const MINUTE_MS = 60_000;

/** The action half of a turn over convex-test: the real spill and reader ports, without the model. */
function actionCtx(t: Started['t']): ActionCtx {
  return {runMutation: (ref, args) => t.mutation(ref, args), runQuery: (ref, args) => t.query(ref, args)} as ActionCtx;
}

function readerContext(started: Started, chatId = started.scope.chatId): ToolContext {
  return {userId: started.userId, chatId, runId: started.runId} as ToolContext;
}

async function spilledTurn(started: Started) {
  const scope = {...started.scope, expectedTurnIndex: 0};
  const compact = await compactResult(textResult(TWO_MB), text => convexSpill(actionCtx(started.t), scope)('call-1', text));
  const parts: Message['parts'] = [{type: 'toolResult', callId: 'call-1', name: 'big', ...compact}];
  return {scope, compact, message: assistantMessage(scope, parts)};
}

function commit(scope: Omit<TurnCommit, 'messages' | 'end'>, messages: Message[]) {
  const value: TurnCommit = {...scope, messages, end: {status: 'ready'}};
  return {commitJson: JSON.stringify(value)};
}

async function readAll(started: Started, ref: string): Promise<string> {
  const tool = convexOutputReaderTool(actionCtx(started.t));
  let text = '';
  for (;;) {
    const page = await tool.execute({id: ref, offset: text.length, limit: 40_000}, readerContext(started));
    const body = String(page.content[0]?.text);
    const header = /^\[characters (\d+)–(\d+) of (\d+)\]\n/.exec(body);
    if (!header) throw new Error(body);
    text += body.slice(header[0].length);
    if (Number(header[2]) >= Number(header[3])) return text;
  }
}

describe('offloaded tool output (PRA-26)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('a 2 MB tool output commits, its message row stays under 50 KB, and it reads back in pages', async () => {
    const started = await startedRun();
    const {scope, compact, message} = await spilledTurn(started);
    expect(compact.outputRef).toEqual(expect.any(String));
    const ref = compact.outputRef!;
    expect(await started.t.mutation(internal.turns.commitInternal, commit(scope, [message])))
      .toMatchObject({outcome: 'committed'});
    const rows = await started.t.run(async ctx => ({
      messages: await ctx.db.query('messages').collect(),
      manifest: await ctx.db.query('toolOutputs').collect(),
      chunks: await ctx.db.query('outputs').collect(),
    }));
    expect(rows.messages).toHaveLength(1);
    expect(jsonBytes(rows.messages[0])).toBeLessThan(50_000);
    expect(rows.manifest).toMatchObject([{id: ref, committed: true, characters: TWO_MB.length, callId: 'call-1'}]);
    expect(rows.chunks).toHaveLength(Math.ceil(TWO_MB.length / TOOL_OUTPUT_CHUNK_CHARACTERS_MAX));
    expect(await readAll(started, ref)).toBe(TWO_MB);
  });

  it('another chat, or an output the sweep removed, reads as no longer available instead of failing the turn', async () => {
    const started = await startedRun();
    const {compact} = await spilledTurn(started);
    const ref = compact.outputRef!;
    const tool = convexOutputReaderTool(actionCtx(started.t));
    const unavailable = {content: [{type: 'text', text: outputUnavailableText(ref)}], isError: false};
    expect(await tool.execute({id: ref, offset: 0}, readerContext(started, 'other-chat'))).toEqual(unavailable);
    vi.setSystemTime(Date.now() + OUTPUT_ORPHAN_AGE_MS + MINUTE_MS);
    expect(await started.t.mutation(internal.outputs.sweep, {})).toBeGreaterThan(0);
    expect(await tool.execute({id: ref, offset: 0}, readerContext(started))).toEqual(unavailable);
  });

  it('the sweep removes only outputs no commit referenced, and only once they are a day old', async () => {
    const started = await startedRun();
    const kept = await spilledTurn(started);
    await started.t.mutation(internal.turns.commitInternal, commit(kept.scope, [kept.message]));
    const orphan = await compactResult(textResult(TWO_MB), text => convexSpill(actionCtx(started.t), {...kept.scope, expectedTurnIndex: 1})('call-2', text));
    const count = () => started.t.run(async ctx => ({
      manifests: (await ctx.db.query('toolOutputs').collect()).map(row => row.id),
      chunks: (await ctx.db.query('outputs').collect()).length,
    }));
    const chunksEach = Math.ceil(TWO_MB.length / TOOL_OUTPUT_CHUNK_CHARACTERS_MAX);
    expect(await started.t.mutation(internal.outputs.sweep, {})).toBe(0);
    expect((await count()).manifests).toHaveLength(2);
    vi.setSystemTime(Date.now() + OUTPUT_ORPHAN_AGE_MS + MINUTE_MS);
    expect(await started.t.mutation(internal.outputs.sweep, {})).toBe(chunksEach);
    expect(await count()).toEqual({manifests: [kept.compact.outputRef], chunks: chunksEach});
    expect(orphan.outputRef).not.toBe(kept.compact.outputRef);
  });

  it('the central size guard rejects a message row over the document budget with a typed error', async () => {
    const started = await startedRun();
    const scope = {...started.scope, expectedTurnIndex: 0};
    const huge = assistantMessage(scope, [{type: 'text', text: 'x'.repeat(950_000)}]);
    await expect(started.t.mutation(internal.turns.commitInternal, commit(scope, [huge])))
      .rejects.toThrow(DOCUMENT_TOO_LARGE);
  });
});
