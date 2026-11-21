import {Agent} from '@convex-dev/agent';
import type {TurnGenerate} from '@praxis/agent/harness';
import {components} from '../_generated/api.js';
import type {ActionCtx} from '../functions.js';

/** One call through the Convex Agent component with the user's model and no thread, so the component stores nothing. */
export function componentGenerate(ctx: ActionCtx, userId: string): TurnGenerate {
  return async ({messages, model, ...args}) => {
    const agent = new Agent(components.agent, {name: 'praxis', languageModel: model});
    return agent.generateText(ctx, {userId}, args, {
      storageOptions: {saveMessages: 'none'},
      contextOptions: {recentMessages: 0},
      contextHandler: async () => messages,
    });
  };
}
