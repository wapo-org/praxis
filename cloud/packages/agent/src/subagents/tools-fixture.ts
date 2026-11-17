import {SUBAGENT_TOOL_NAMES, type SubagentTree} from '@praxis/protocol';
import {treeFixture, workspacePort} from './test-fixtures.js';
import {waitAgents} from './wait.js';
import {createSubagentHarness, type SubagentHarnessPort, type SubagentTransaction} from './tools.js';
import type {ToolContext} from '../types.js';

export function harnessFixture() {
  let tree = treeFixture();
  tree.nodes[0]!.permissions.tools = [...SUBAGENT_TOOL_NAMES, 'read_file', 'edit_file', 'outbound', 'secret', 'destroy'];
  let actorId = 'root';
  let sequence = 0;
  const metadata: SubagentTransaction['tools'] = [
    ...[...SUBAGENT_TOOL_NAMES, 'read_file'].map(name => ({name,
      classification: {capabilities: ['read'] as const, decision: 'allow' as const, untrustedSource: false},
      usesSecrets: false, confinedToChildWorkspace: false})),
    {name: 'edit_file', classification: {capabilities: ['write'], decision: 'allow', untrustedSource: false},
      usesSecrets: false, confinedToChildWorkspace: true},
    {name: 'outbound', classification: {capabilities: ['external-egress'], decision: 'allow', untrustedSource: false},
      usesSecrets: false, confinedToChildWorkspace: false},
    {name: 'secret', classification: {capabilities: ['read'], decision: 'allow', untrustedSource: false},
      usesSecrets: true, confinedToChildWorkspace: false},
    {name: 'destroy', classification: {capabilities: ['write'], decision: 'allow', destructive: true, untrustedSource: false},
      usesSecrets: false, confinedToChildWorkspace: true},
  ];
  const models = [{id: 'test-model', tools: true, supportedEfforts: ['low', 'medium', 'high']},
    {id: 'small', tools: true, supportedEfforts: ['low']}, {id: 'text', tools: false, supportedEfforts: ['medium']}];
  const context: ToolContext = {
    userId: 'owner', chatId: 'chat', runId: 'run', mode: 'auto', callId: 'call', signal: new AbortController().signal,
    callTool: async () => {throw new Error('No nested dispatch');},
    emit: async () => {}, elicit: async () => ({type: 'elicitation.response', elicitationId: 'e', action: 'decline'}),
  };
  const port: SubagentHarnessPort = {
    async transact(ctx, apply) {
      const returned = apply({tree, actorId, childId: `child-${ctx.callId}`, messageId: `message-${ctx.callId}`, models, tools: metadata});
      tree = returned.tree;
      return returned;
    },
    async wait(ctx, request) {
      void ctx;
      const returned = await waitAgents(tree, actorId, request, {startedAtMs: 0, nowMs: 0}, workspacePort);
      tree = returned.tree;
      return returned.result;
    },
  };
  const harness = createSubagentHarness(port);
  return {harness, port, context, metadata, get tree() {return tree;}, set tree(value: SubagentTree) {tree = value;},
    actor(id: string) {actorId = id;},
    async call(name: string, args: unknown) {
      context.callId = String(++sequence);
      return harness.tools.find(tool => tool.spec.name === name)!.execute(JSON.parse(JSON.stringify(args)), context);
    }};
}
