import {
  DEFAULT_MODEL_ID, ReasoningEffortSchema, type RunTaint, type TurnFailure, type TurnResult,
} from '@praxis/protocol';
import {
  TURN_SYSTEM, openRouterTurnModel, runTurn, type AgentTool, type ToolClassifier, type TurnOutput,
} from '@praxis/agent/harness';
import type {SealedSecret} from '@praxis/types';
import {internal} from '../_generated/api.js';
import type {ActionCtx} from '../functions.js';
import type {TurnScope} from '../workflows/turnState.js';
import {componentGenerate} from './component.js';
import {convexLedger} from './ledger.js';
import {unsealSecret} from './secrets.js';
import {MODEL_KEY_RESOURCE, TURN_DEADLINE_MS} from './constants.js';
import type {TurnHydration} from './hydrate.js';

/** Tools that run inside Convex; the apps/api implementations move here with PRA-39, PRA-48 and PRA-60. */
const TURN_TOOLS: readonly AgentTool[] = [];
/** Unknown calls get no classification, so the boundary refuses them. */
const NO_CLASSIFICATION: ToolClassifier = {classify: () => undefined};

const MISSING_KEY: TurnFailure = {
  code: 'model_key_missing',
  message: 'Connect your OpenRouter key to use models',
  remediation: 'Connect OpenRouter in Settings, then send the message again.',
};

/** No receipt service exists yet (PRA-56): a fresh key per attempt makes every approval-gated call fail closed. */
async function refusingApprovals() {
  const key = await crypto.subtle.generateKey({name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
  return {key, nowMs: () => Date.now(), replay: {consume: async () => false}};
}

function effortOf(hydration: TurnHydration) {
  const parsed = ReasoningEffortSchema.safeParse(hydration.effort);
  return parsed.success ? parsed.data : undefined;
}

async function modelKey(hydration: TurnHydration, userId: string): Promise<SealedSecret | undefined> {
  return hydration.sealedKey ? unsealSecret(hydration.sealedKey, userId, MODEL_KEY_RESOURCE) : undefined;
}

async function failTurn(ctx: ActionCtx, scope: TurnScope, failure: TurnFailure): Promise<TurnResult> {
  return ctx.runMutation(internal.turns.fail, {...scope, failureJson: JSON.stringify(failure)});
}

async function commitOutput(ctx: ActionCtx, scope: TurnScope, output: TurnOutput): Promise<TurnResult> {
  const taint: RunTaint | undefined = output.taint;
  const commit = {...scope, messages: output.messages, usage: output.usage, end: output.end, ...(taint ? {taint} : {})};
  const result = await ctx.runMutation(internal.turns.commitInternal, {commitJson: JSON.stringify(commit)});
  if (result.outcome === 'committed') return result.flags;
  const after = await ctx.runQuery(internal.turns.preflight, scope);
  if (after.state === 'settled') return after.flags;
  throw new Error('Turn commit conflicted but no flags are saved');
}

/** A turn the run no longer holds reads the saved flags; one still open (deadline hit) throws for the bounded retry. */
async function settledFlags(ctx: ActionCtx, scope: TurnScope): Promise<TurnResult> {
  const after = await ctx.runQuery(internal.turns.preflight, scope);
  if (after.state === 'settled') return after.flags;
  throw new Error('Turn attempt ended before its output');
}

/** One workflow turn inside this action: hydrate, one model call plus its tools on the component, fenced commit. */
export async function runConvexTurn(ctx: ActionCtx, scope: TurnScope, runTainted: boolean): Promise<TurnResult> {
  const hydration: TurnHydration = await ctx.runQuery(internal.agent.hydrate.hydrate, scope);
  const apiKey = await modelKey(hydration, scope.userId);
  if (!apiKey) return failTurn(ctx, scope, MISSING_KEY);
  const {model, providerOptions} = openRouterTurnModel(apiKey, hydration.modelId ?? DEFAULT_MODEL_ID, effortOf(hydration));
  const tools = TURN_TOOLS.filter(tool => hydration.tools.some(spec => spec.name === tool.spec.name));
  const run = await runTurn({
    input: {
      userId: scope.userId, chatId: scope.chatId, runId: scope.runId, mode: hydration.mode, tainted: runTainted,
      system: hydration.system ?? TURN_SYSTEM, tools: tools.map(tool => tool.spec), history: hydration.history,
      toolsEnabled: tools.length > 0,
    },
    model, ...(providerOptions ? {providerOptions} : {}),
    generate: componentGenerate(ctx, scope.userId),
    tools, registry: NO_CLASSIFICATION,
    ledger: convexLedger(ctx, scope),
    boundary: await refusingApprovals(),
    context: {
      signal: AbortSignal.timeout(TURN_DEADLINE_MS),
      elicit: async () => ({type: 'elicitation.response', elicitationId: 'unsupported', action: 'decline'}),
      emit: async () => undefined,
    },
  });
  switch (run.state) {
    case 'output': return commitOutput(ctx, scope, run.output);
    case 'failed': return failTurn(ctx, scope, run.failure);
    case 'inactive': return settledFlags(ctx, scope);
  }
}
