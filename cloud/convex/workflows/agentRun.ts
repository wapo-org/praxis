import {WorkflowManager} from '@convex-dev/workflow';
import {v} from 'convex/values';
import {components, internal} from '../_generated/api.js';
import {runScope, terminalStatus} from './validators.js';
import {RUN_UNPARK_EVENT, WORKFLOW_ERRORS, WORKFLOW_PARALLELISM_MAX} from './constants.js';

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {maxParallelism: WORKFLOW_PARALLELISM_MAX},
});

export const agentRun = workflow.define({
  args: {...runScope, startTurnIndex: v.number()},
  returns: terminalStatus,
  handler: async (step, args): Promise<'completed' | 'cancelled' | 'failed'> => {
    const {startTurnIndex, ...scope} = args;
    let expectedTurnIndex = startTurnIndex;
    let resultCommitted = false;
    while (true) {
      const status = await step.runQuery(internal.runs.status, scope);
      if (status === null || status === 'cancelling' || status === 'cancelled') return 'cancelled';
      if (status === 'queued' || status === 'paused') {
        await step.awaitEvent({name: RUN_UNPARK_EVENT, validator: v.null()});
        continue;
      }
      if (status !== 'running') return status;
      if (resultCommitted) {
        const {applied} = await step.runMutation(internal.runs.transition, {
          ...scope, from: 'running', to: 'completed', turnIndex: expectedTurnIndex,
        });
        if (applied) return 'completed';
        continue;
      }
      const flags = await step.runAction(internal.turns.run, {...scope, expectedTurnIndex});
      if (flags.turnIndex !== expectedTurnIndex || flags.subagents.length > 0) {
        throw new Error(WORKFLOW_ERRORS.flags);
      }
      if (flags.status === 'busy') continue;
      if (flags.done) {
        switch (flags.status) {
          case 'stopped': return 'cancelled';
          case 'completed': resultCommitted = true; break;
          case 'failed': return 'failed';
        }
      }
      expectedTurnIndex += 1;
    }
  },
});
