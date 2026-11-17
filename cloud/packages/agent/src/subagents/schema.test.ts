import {expect, it} from 'vitest';
import {ArtifactPathSchema, SpawnAgentSchema, SUBAGENT_LIMITS, SubagentNodeSchema, WaitAgentsResultSchema} from '@praxis/protocol';
import {toolError} from '../boundary/errors.js';
import {createRequest, handoff, treeFixture} from './test-fixtures.js';

it('requires lifecycle-specific handoffs and errors at the schema boundary', () => {
  const node = treeFixture().nodes[0]!;
  const error = toolError('upstream', 'Retry the failed task.');
  for (const status of ['spawning', 'running', 'waiting', 'completed', 'failed', 'cancelling', 'cancelled']) {
    for (const payload of [null, handoff()]) {
      for (const failure of [null, error]) {
        const valid = status === 'completed' ? payload !== null && failure === null
          : status === 'failed' ? payload === null && failure !== null
          : status === 'cancelling' || status === 'cancelled' ? payload === null
          : payload === null && failure === null;
        expect(SubagentNodeSchema.safeParse({...node, status, handoff: payload, error: failure}).success).toBe(valid);
        const parsed = WaitAgentsResultSchema.safeParse({status: 'ready', tainted: false, agents: [{
          subagent_id: node.id, tainted: false, status, handoff: payload, error: failure,
        }]});
        expect(parsed.success).toBe(valid);
        const entry = parsed.success ? parsed.data.agents[0] : undefined;
        if (entry?.status === 'completed') expect(entry.handoff.status).toBe('completed');
        if (entry?.status === 'failed') expect(entry.error.code).toBe('upstream');
      }
    }
  }
});
it('enforces named protocol limits at their exact boundaries', () => {
  for (const [key, limit] of [['name', SUBAGENT_LIMITS.NAME_MAX_CHARACTERS], ['model', SUBAGENT_LIMITS.MODEL_MAX_CHARACTERS]] as const) {
    expect(SpawnAgentSchema.safeParse({...createRequest, [key]: 'x'.repeat(limit)}).success).toBe(true);
    expect(SpawnAgentSchema.safeParse({...createRequest, [key]: 'x'.repeat(limit + 1)}).success).toBe(false);
  }
  const tools = Array.from({length: SUBAGENT_LIMITS.TOOLS_MAX}, (_, i) => `tool${i}`);
  expect(SpawnAgentSchema.safeParse({...createRequest, tools}).success).toBe(true);
  expect(SpawnAgentSchema.safeParse({...createRequest, tools: [...tools, 'extra']}).success).toBe(false);
  expect(ArtifactPathSchema.safeParse('x'.repeat(SUBAGENT_LIMITS.ARTIFACT_PATH_MAX_CHARACTERS)).success).toBe(true);
  expect(ArtifactPathSchema.safeParse('x'.repeat(SUBAGENT_LIMITS.ARTIFACT_PATH_MAX_CHARACTERS + 1)).success).toBe(false);
});
