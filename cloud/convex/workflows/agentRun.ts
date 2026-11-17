import {WorkflowManager} from '@convex-dev/workflow';
import {v} from 'convex/values';
import {TurnResultSchema} from '@praxis/protocol';
import {components, internal} from '../_generated/api.js';
import {runScope, terminalStatus} from './validators.js';
import {WORKFLOW_ERRORS, WORKFLOW_PARALLELISM_MAX} from './constants.js';

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {maxParallelism: WORKFLOW_PARALLELISM_MAX},
});

export const agentRun = workflow.define({
  args: {...runScope, startTurnIndex: v.number()},
  returns: terminalStatus,
  handler: async (step, args): Promise<'completed' | 'cancelled' | 'failed'> => {
    const {startTurnIndex, ...scope} = args;
    let expectedTurnIndex = startTurnIndex;
    while (true) {
      const status = await step.runQuery(internal.runs.status, scope);
      if (status === null || status === 'cancelling' || status === 'cancelled') return 'cancelled';
      if (status !== 'running') return status;
      const flags = TurnResultSchema.parse(await step.runAction(internal.turns.run, {...scope, expectedTurnIndex}));
      if (flags.turnIndex !== expectedTurnIndex || flags.subagents.length > 0 || flags.status === 'busy') {
        throw new Error(WORKFLOW_ERRORS.flags);
      }
      if (flags.done) return flags.status === 'stopped' ? 'cancelled' : 'completed';
      expectedTurnIndex += 1;
    }
  },
});
