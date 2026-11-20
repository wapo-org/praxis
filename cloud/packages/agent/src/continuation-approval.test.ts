import {expect, it} from 'vitest';
import type {Message} from '@praxis/protocol';
import {approvalTestStore} from './approval-test-fixture.js';
import {approvalPreview} from './approval-preview.js';
import {publicToolMessage} from './run-approval.js';
import {createScriptedRunner, scriptedTools} from './scripted.js';
import type {AgentPorts, RunInput} from './types.js';

const TIME = '2026-11-20T04:00:00.000Z';

function input(): RunInput {
  return {
    userId: 'owner',
    run: {type: 'run', id: 'run', chatId: 'chat', status: 'queued', lastEventId: 0, createdAt: TIME, updatedAt: TIME},
    chat: {type: 'chat', id: 'chat', title: 'Test', pinned: false, mode: 'build', connectorIds: [], disabledConnectorIds: [], createdAt: TIME, updatedAt: TIME},
    messages: [{type: 'message', id: 'prompt', chatId: 'chat', role: 'user', parts: [{type: 'text', text: 'Write'}], createdAt: TIME, updatedAt: TIME}],
  };
}

it('persists running before a resumed slice creates its approval record', async () => {
  const approvals = approvalTestStore();
  let storedStatus = '';
  let statusWhenApprovalWasPersisted = '';
  const ports: AgentPorts = {
    ...approvals.ports,
    async save(_userId, checkpoint) {
      storedStatus = checkpoint.run.status;
    },
    async pendingApproval(userId, record) {
      statusWhenApprovalWasPersisted = storedStatus;
      await approvals.ports.pendingApproval!(userId, record);
    },
    async emit() {},
    async isCancelled() { return false; },
    now: () => TIME,
  };
  const runner = createScriptedRunner(ports, 'approval');
  const yielded = await runner.run(input(), 1);
  expect(yielded.run.status).toBe('continuing');

  const paused = await runner.advance(yielded);

  expect(paused.run.status).toBe('awaitingApproval');
  expect(statusWhenApprovalWasPersisted).toBe('running');
});

it('redacts explicitly private tool arguments from committed messages', async () => {
  const tools = scriptedTools();
  const tool = tools.find(candidate => candidate.spec.name === 'local_echo')!;
  tool.privateArguments = true;
  const ports: AgentPorts = {save: async () => {}, emit: async () => {}, isCancelled: async () => false, now: () => TIME};
  const checkpoint = await createScriptedRunner(ports).create(input());
  const secret = 'connector-secret-value';
  const message: Message = {
    type: 'message', id: 'tool-call', chatId: 'chat', role: 'assistant',
    parts: [{type: 'toolCall', callId: 'call', name: tool.spec.name, arguments: JSON.stringify({token: secret})}],
    raw: {type: 'provider.payload', data: {secret}}, createdAt: TIME, updatedAt: TIME,
  };

  const publicMessage = publicToolMessage(checkpoint, message, new Map([[tool.spec.name, tool]]));

  expect(publicMessage.parts[0]?.type === 'toolCall' ? publicMessage.parts[0].arguments : 'missing').toBeUndefined();
  expect(publicMessage.raw).toBeUndefined();
  expect(JSON.stringify(publicMessage)).not.toContain(secret);
});

it('redacts private keys, auth fields and inline password values from approval previews', () => {
  const preview = approvalPreview({
    private_key: 'pem-secret',
    auth: 'auth-secret',
    key: 'bare-key-secret',
    code: 'password is inline-secret',
  }, {type: 'object'});

  expect(preview).not.toContain('pem-secret');
  expect(preview).not.toContain('auth-secret');
  expect(preview).not.toContain('bare-key-secret');
  expect(preview).toContain('password is [redacted]');
});


