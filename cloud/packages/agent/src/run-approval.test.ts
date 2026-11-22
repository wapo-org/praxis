import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {CapabilitiesSchema, type JsonObject, type Mode, type RunEventPayload} from '@praxis/protocol';
import {AgentRunner} from './runner.js';
import {approvalTestStore} from './approval-test-fixture.js';
import {textResult, type AgentTool, type ModelProvider, type RunInput} from './types.js';

const TIME = '2026-11-20T04:00:00.000Z';
const TOOLS = ['GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE'] as const;
const SECRET = 'secret-that-must-stay-private';
const ARGS = {to: 'test@example.test', channel: '#review', password: SECRET, data: 'x'.repeat(2000)};

function fixture(name: string, mode: Mode, args: JsonObject, options: {ports?: boolean; trusted?: boolean} = {}) {
  const approvals = approvalTestStore();
  const output = vi.fn(async () => textResult('sent'));
  const tool: AgentTool = {
    spec: {
      type: 'tool.spec', name, description: 'Send a message', source: {type: 'mcp', serverId: 'connector'},
      inputSchema: {type: 'object'}, traits: [],
    },
    execute: output,
  };
  const provider: ModelProvider = {
    capabilities: CapabilitiesSchema.parse({tools: true}),
    async *stream(request) {
      const sent = request.messages.some(message => message.parts.some(part => part.type === 'toolResult'));
      if (!sent) {
        yield {type: 'tool', index: 0, id: 'call-1', name};
        yield {type: 'arguments', index: 0, json: JSON.stringify(args)};
      }
      yield {type: 'completed', response: {
        parts: sent ? [{type: 'text', text: 'Done'}] : [{type: 'toolCall', callId: 'call-1', name, arguments: JSON.stringify(args)}],
        stop: 'endTurn', usage: {type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0},
      }};
    },
  };
  const events: RunEventPayload[] = [];
  const hooks = {onApprovalRead: () => {}, cancelled: false};
  const runner = new AgentRunner({provider, tools: [tool], ports: {
    ...(options.ports !== false && {
      ...approvals.ports,
      async approvalDecision(user, binding, id) {
        const decision = await approvals.ports.approvalDecision!(user, binding, id);
        hooks.onApprovalRead();
        return decision;
      },
    }),
    async save() {},
    async emit(_user, _run, event) { events.push(event); },
    async isCancelled() { return hooks.cancelled; },
  }});
  const input: RunInput = {
    userId: 'owner', policy: {trustedSources: options.trusted ? ['mcp:connector'] : [], alwaysAllow: []},
    run: {type: 'run', id: 'run', chatId: 'chat', status: 'queued', lastEventId: 0, createdAt: TIME, updatedAt: TIME},
    chat: {type: 'chat', id: 'chat', title: 'Test', pinned: false, mode, connectorIds: [], disabledConnectorIds: [], createdAt: TIME, updatedAt: TIME},
    messages: [{type: 'message', id: 'prompt', chatId: 'chat', role: 'user', parts: [{type: 'text', text: 'Send'}], createdAt: TIME, updatedAt: TIME}],
  };
  return Object.assign(hooks, {runner, input, approvals, output, events});
}

it.each(TOOLS)('parks %s with a redacted preview before executing', async name => {
  const f = fixture(name, 'build', ARGS, {trusted: true});
  const paused = await f.runner.run(f.input);
  expect(f.output).not.toHaveBeenCalled();
  const approval = paused.approval!;
  expect(approval.arguments).toMatch(/test@example.test/);
  expect(approval.arguments).toMatch(/#review/);
  expect(approval.arguments).toMatch(/\[redacted\]/);
  expect(String(approval.arguments).length).toBeLessThan(JSON.stringify(ARGS).length);
  expect(JSON.stringify(f.events)).not.toContain(SECRET);
  const decision = {type: 'approval.decision', approvalId: approval.id, decision: 'allowOnce'};
  await expect(f.runner.resume(paused, decision)).rejects.toThrow('No recorded decision');
  f.approvals.decisions.set(approval.id, 'allowOnce');
  const completed = await f.runner.resume(paused, decision);
  expect(f.output).toHaveBeenCalledExactlyOnceWith(ARGS, expect.anything());
  expect(completed.run.status).toBe('completed');
  await f.runner.resume(completed, decision);
  expect(f.output).toHaveBeenCalledTimes(1);
});

it('checks the stored row again immediately before dispatch', async () => {
  const f = fixture(TOOLS[0], 'build', ARGS);
  const paused = await f.runner.run(f.input);
  const id = paused.approval!.id;
  f.approvals.decisions.set(id, 'allowOnce');
  f.onApprovalRead = () => f.approvals.decisions.delete(id);
  const completed = await f.runner.resume(paused, {type: 'approval.decision', approvalId: id, decision: 'allowOnce'});
  expect(f.output).not.toHaveBeenCalled();
  expect(JSON.stringify(completed.messages)).toContain('No recorded approval');
});

it('never executes a side effect without a matching approved row', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...TOOLS), fc.constantFrom('build', 'auto', 'ask', 'plan'),
    fc.constantFrom('allowOnce', 'allowAlways', 'deny', 'missing'),
    fc.boolean(), fc.boolean(), fc.boolean(),
    async (name, mode, decision, changed, trusted, ports) => {
      const f = fixture(name, mode, ARGS, {trusted, ports});
      const cp = await f.runner.run(f.input);
      expect(f.output).not.toHaveBeenCalled();
      if (!cp.approval) return;
      const id = cp.approval.id;
      const row = f.approvals.rows.get(id)!;
      if (decision !== 'missing') f.approvals.decisions.set(id, decision);
      if (changed) {
        cp.calls[row.toolCallId]!.call.arguments = {channel: '#different'};
        cp.pending[0]!.arguments = {channel: '#different'};
      }
      const reply = {type: 'approval.decision', approvalId: id, decision: decision === 'missing' ? 'allowOnce' : decision};
      if (decision === 'missing' || changed) {
        await expect(f.runner.resume(cp, reply)).rejects.toThrow('No recorded decision');
      } else {
        const completed = await f.runner.resume(cp, reply);
        if (decision === 'deny') expect(JSON.stringify(completed.messages)).toContain('The user declined this tool call.');
      }
      expect(f.output).toHaveBeenCalledTimes(!changed && (decision === 'allowOnce' || decision === 'allowAlways') ? 1 : 0);
    },
  ));
});

it('never dispatches an approved call once the run is cancelled', async () => {
  const f = fixture(TOOLS[0], 'build', ARGS);
  const paused = await f.runner.run(f.input);
  const decision = {type: 'approval.decision', approvalId: paused.approval!.id, decision: 'allowOnce'};
  f.approvals.decisions.set(paused.approval!.id, 'allowOnce');
  const cancelled = await f.runner.cancel(paused);
  expect(cancelled.run.status).toBe('cancelled');
  expect(cancelled.approval).toBeUndefined();
  await expect(f.runner.resume(cancelled, decision)).rejects.toThrow('Run is finished');
  f.cancelled = true;
  const raced = await f.runner.resume(paused, decision);
  expect(raced.run.status).toBe('cancelled');
  expect(f.output).not.toHaveBeenCalled();
  expect(f.events.filter(event => event.type === 'tool.running')).toHaveLength(0);
});

it('rejects a conflicting replay after the recorded decision resumed the run', async () => {
  const f = fixture(TOOLS[1], 'build', ARGS);
  const paused = await f.runner.run(f.input);
  const id = paused.approval!.id;
  f.approvals.decisions.set(id, 'deny');
  const completed = await f.runner.resume(paused, {type: 'approval.decision', approvalId: id, decision: 'deny'});
  await expect(f.runner.resume(completed, {type: 'approval.decision', approvalId: id, decision: 'allowOnce'}))
    .rejects.toThrow('Conflicting response');
  await expect(f.runner.resume(paused, {type: 'approval.decision', approvalId: id, decision: 'allowOnce'}))
    .rejects.toThrow('No recorded decision');
  expect(f.output).not.toHaveBeenCalled();
});
