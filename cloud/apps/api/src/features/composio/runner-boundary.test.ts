import {describe, expect, it} from 'vitest';
import {AgentRunner, BOUNDARY_TEXT, fingerprint, textResult, type AgentCheckpoint, type AgentTool, type ModelProvider, type RunInput} from '@praxis/agent';
import {CapabilitiesSchema, COMPOSIO_META_TOOL_NAMES as NAMES, type Chat, type Mode} from '@praxis/protocol';
import {createLocalAdapters} from '../../local-memory.js';
import {decideApproval, readApprovalDecision, recordPendingApproval} from '../../approvals.js';
import {EXECUTE_FIXTURES, fakeComposio, type FakeComposio} from './fixture.js';
import {composioTools} from './tools.js';

const TIME = '2026-11-20T00:00:00.000Z';
const usage = {type: 'usage' as const, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0};
type Step = {name: string; args: object};
const read = {tools: [{tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {max_results: 5}}]};
const send = {tools: [
  {tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {max_results: 1}},
  {tool_slug: 'GMAIL_SEND_EMAIL', arguments: {to: 'a@example.com', body: 'hi'}},
]};

function chat(mode: Mode): Chat {
  return {type: 'chat', id: 'c', title: 'T', pinned: false, mode, connectorIds: [], disabledConnectorIds: [], createdAt: TIME, updatedAt: TIME};
}

function fixture(script: Step[], fake: FakeComposio = fakeComposio(), mode: Mode = 'build', extra: AgentTool[] = []) {
  const requests: string[][] = [];
  const provider: ModelProvider = {capabilities: CapabilitiesSchema.parse({}), async *stream(request) {
    requests.push(request.tools.map(tool => tool.name));
    const step = script[request.messages.flatMap(m => m.parts).filter(p => p.type === 'toolResult').length];
    const parts = step
      ? [{type: 'toolCall' as const, callId: `call-${requests.length}`, name: step.name, arguments: JSON.stringify(step.args)}]
      : [{type: 'text' as const, text: 'Done'}];
    yield {type: 'completed', response: {parts, stop: 'endTurn', usage}};
  }};
  const {store} = createLocalAdapters();
  const runner = new AgentRunner({provider, tools: [...composioTools(fake.ports, 'u', chat(mode)), ...extra], ports: {
    save: async () => {}, emit: async () => {}, isCancelled: async () => false,
    pendingApproval: (userId, pending) => recordPendingApproval(store, userId, pending),
    approvalDecision: (userId, binding, id) => readApprovalDecision(store, userId, binding, id),
  }});
  const input: RunInput = {userId: 'u', policy: {trustedSources: [], alwaysAllow: []},
    run: {type: 'run', id: 'r', chatId: 'c', status: 'queued', lastEventId: 0, createdAt: TIME, updatedAt: TIME}, chat: chat(mode),
    messages: [{type: 'message', id: 'm', chatId: 'c', role: 'user', parts: [{type: 'text', text: 'Check mail'}], createdAt: TIME, updatedAt: TIME}]};
  const approve = async (parked: AgentCheckpoint) => {
    await decideApproval(store, 'u', 'r', {type: 'approval.decision', approvalId: parked.approval!.id, decision: 'allowOnce'}, true);
    return runner.resume(parked, {type: 'approval.decision', approvalId: parked.approval!.id, decision: 'allowOnce'});
  };
  return {runner, input, fake, requests, approve, store};
}
const results = (cp: AgentCheckpoint) => cp.messages.flatMap(m => m.parts).filter(p => p.type === 'toolResult');
const COMPOSIO_TAINT = 'COMPOSIO MULTI EXECUTE TOOL';
/** A confined workspace write that Build mode runs on its standing grant while the run is clean. */
function workspaceWrite(writes: string[]): AgentTool {
  return {
    spec: {type: 'tool.spec', name: 'save_note', description: 'Save a note', source: {type: 'builtin'}, traits: [],
      inputSchema: {type: 'object'}},
    boundary: {capabilities: ['write'], decision: 'allow', untrustedSource: false},
    execute: async () => {
      writes.push('saved');
      return textResult('saved');
    },
  };
}
const first = (cp: AgentCheckpoint) => results(cp)[0]?.content?.[0];

describe('Composio Tool Router in the AgentRunner', () => {
  it('exposes only the meta-tools, before and after a search returns app tool schemas', async () => {
    const f = fixture([{name: NAMES.search, args: {queries: [{use_case: 'read my email'}]}}, {name: NAMES.multiExecute, args: read}]);
    const done = await f.runner.run(f.input);
    expect(done.run.status).toBe('completed');
    const meta = [NAMES.search, NAMES.schemas, NAMES.multiExecute];
    expect(f.requests).toHaveLength(3);
    for (const tools of f.requests) expect(new Set(tools)).toEqual(new Set(meta));
    expect(JSON.stringify(first(done))).toContain('GMAIL_FETCH_EMAILS');
  });

  it('runs a read-only action without an approval request and taints the run', async () => {
    const f = fixture([{name: NAMES.multiExecute, args: read}]);
    const done = await f.runner.run(f.input);
    expect(done.run.status).toBe('completed');
    expect(done.approval).toBeUndefined();
    expect(done.run.taint).toEqual({tainted: true, source: COMPOSIO_TAINT, callId: 'call-1'});
    expect(results(done)[0]).toMatchObject({callId: 'call-1', taintSource: COMPOSIO_TAINT});
    expect(f.fake.executed()).toEqual([{tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {max_results: 5}}]);
    expect(first(done)).toMatchObject({type: 'untrusted-data', source: 'composio'});
    expect(f.fake.usage).toEqual([expect.objectContaining({runId: 'r', executions: 1})]);
  });

  it('parks a side-effect batch for exact-call approval, then executes exactly the checked snapshot', async () => {
    const f = fixture([{name: NAMES.multiExecute, args: send}]);
    const parked = await f.runner.run(f.input);
    expect(parked.run.status).toBe('awaitingApproval');
    expect(parked.approval).toMatchObject({toolName: NAMES.multiExecute, reason: BOUNDARY_TEXT.egress});
    expect(f.fake.executed()).toEqual([]);
    const record = await f.store.get('u', 'approval', parked.approval!.id);
    expect(record?.value.argsHash).toBe(await fingerprint(send));
    const done = await f.approve(parked);
    expect(done.run.status).toBe('completed');
    expect(f.fake.executed()).toEqual(send.tools);
  });

  it('taints the run like any untrusted read, so a standing grant no longer skips approval', async () => {
    const writes: string[] = [];
    const f = fixture([{name: NAMES.multiExecute, args: read}, {name: 'save_note', args: {}}], fakeComposio(), 'build',
      [workspaceWrite(writes)]);
    const parked = await f.runner.run(f.input);
    expect(parked.run.status).toBe('awaitingApproval');
    expect(parked.approval).toMatchObject({toolName: 'save_note', reason: BOUNDARY_TEXT.tainted, taintSource: COMPOSIO_TAINT});
    expect(writes).toEqual([]);
  });

  it.each([
    ['empty', {tools: []}],
    ['nested meta-tool', {tools: [{tool_slug: NAMES.multiExecute, arguments: send}]}],
    ['too many actions', {tools: Array.from({length: 101}, () => read.tools[0])}],
  ])('denies a malformed batch without dispatching: %s', async (_name, args) => {
    const f = fixture([{name: NAMES.multiExecute, args}]);
    const done = await f.runner.run(f.input);
    expect(done.approval).toBeUndefined();
    expect(results(done)[0]?.isError).toBe(true);
    expect(f.fake.executed()).toEqual([]);
  });

  it('refuses side effects in Ask mode', async () => {
    const f = fixture([{name: NAMES.multiExecute, args: send}], fakeComposio(), 'ask');
    const done = await f.runner.run(f.input);
    expect(JSON.stringify(results(done))).toContain(BOUNDARY_TEXT.denied);
    expect(f.fake.executed()).toEqual([]);
  });

  it('asks for an inline connect instead of dispatching to an unconnected app', async () => {
    const f = fixture([{name: NAMES.multiExecute, args: {tools: [{tool_slug: 'SLACK_SEND_MESSAGE', arguments: {}}]}}]);
    const done = await f.runner.run(f.input);
    expect(done.approval).toBeUndefined();
    expect(first(done)).toEqual({type: 'composio.connect-required',
      toolkits: [{toolkit: 'slack', connectorId: 'composio:slack'}]});
    expect(f.fake.executed()).toEqual([]);
  });

  it('returns an empty search with a connect hint when no app is connected', async () => {
    const f = fixture([{name: NAMES.search, args: {queries: [{use_case: 'post to slack'}]}}], fakeComposio({accounts: []}));
    const done = await f.runner.run(f.input);
    expect(first(done)).toMatchObject({type: 'untrusted-data', results: [], hint: expect.stringContaining('connect')});
    expect(f.fake.calls).toEqual([]);
  });
});

describe('Composio results', () => {
  const run = async (outcome: keyof typeof EXECUTE_FIXTURES) => {
    const f = fixture([{name: NAMES.multiExecute, args: read}], fakeComposio({execute: {GMAIL_FETCH_EMAILS: EXECUTE_FIXTURES[outcome]}}));
    return {f, done: await f.runner.run(f.input)};
  };

  it('maps an explicit Firewall block to upstream-firewall', async () => {
    const {done} = await run('blocked');
    expect(first(done)).toMatchObject({results: [{ok: false, error: {code: 'upstream-firewall'}}]});
  });

  it('withholds a result the Firewall did not check', async () => {
    const {done} = await run('unchecked');
    const text = JSON.stringify(results(done));
    expect(text).not.toContain('withheld"');
    expect(first(done)).toMatchObject({results: [{ok: false, error: {code: 'upstream'}}]});
  });

  it('keeps passed results structurally untrusted', async () => {
    const {done} = await run('completed');
    expect(first(done)).toMatchObject({type: 'untrusted-data', results: [{ok: true}]});
    expect(done.run.taint).toMatchObject({tainted: true, source: COMPOSIO_TAINT});
  });

  it('spills oversized results and keeps the untrusted envelope', async () => {
    const big = {...EXECUTE_FIXTURES.completed, data: {blob: 'x'.repeat(40_000)}};
    const f = fixture([{name: NAMES.multiExecute, args: read}], fakeComposio({execute: {GMAIL_FETCH_EMAILS: big}}));
    const done = await f.runner.run(f.input);
    expect(first(done)).toMatchObject({type: 'untrusted-data', truncated: true, outputRef: 'spill-1'});
    expect(f.fake.spilled[0]?.length).toBeGreaterThan(40_000);
  });

  it('reports a rate limit as retryable for a read', async () => {
    const f = fixture([{name: NAMES.multiExecute, args: read}], fakeComposio({execute: {GMAIL_FETCH_EMAILS: 429}}));
    const done = await f.runner.run(f.input);
    expect(first(done)).toMatchObject({results: [{ok: false, error: {remediation: expect.stringContaining('retry this action once')}}]});
  });
});
