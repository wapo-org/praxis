import {ExecutionFenced,ToolResultSchema,isRunControl,textResult,type AgentTool,type ToolResult} from '@praxis/agent';
import {JsonValueSchema,RunEventPayloadSchema,type JsonValue} from '@praxis/protocol';
import type {FeatureContext,FeatureTool} from './contracts.js';
import {executionSecrets} from './saved-secrets.js';
import {ApiError} from './service.js';

/** Bridges an API feature tool (MCP, builtin) onto the loop's tool port; the runner keeps policy. */
export function adaptTool(tool: FeatureTool, featureCtx?: FeatureContext): AgentTool {
  return {
    spec: {type: 'tool.spec', ...(tool.originalName ? {originalName:tool.originalName} : {}), name: tool.name, description: tool.description, inputSchema: tool.inputSchema, source: tool.source, traits: tool.traits},
    ...(tool.classify ? {classify: (args: JsonValue) => tool.classify!(args)} : {}),
    ...(tool.hidden ? {hidden: true} : {}),
    async execute(args, context): Promise<ToolResult> {
      try {
        const secrets=featureCtx?await executionSecrets(featureCtx,context.chatId):undefined;
        await secrets?.touch(args);
        let executionArgs=args;
        if(secrets&&args&&typeof args==='object'&&!Array.isArray(args)){
          executionArgs={...args};
          for(const key of ['env','headers'])if(args[key])executionArgs[key]=secrets.resolve(args[key]!);
        }
        const value = await tool.execute(executionArgs, {
          chatId: context.chatId,
          runId: context.runId,
          mode: context.mode,
          callId: context.callId,
          signal: context.signal,
          elicit: request => context.elicit(request),
          callTool: async (name, nested) => JsonValueSchema.parse(await context.callTool(name, secrets?secrets.redact(nested):nested)),
          emit: async event => context.emit(RunEventPayloadSchema.parse(secrets?secrets.redact(event):event)),
        });
        return toToolResult(secrets?secrets.redact(value):value);
      } catch (error) {
        if (isRunControl(error) || error instanceof ExecutionFenced || context.signal.aborted) throw error;
        const message = error instanceof ApiError || error instanceof Error ? error.message : 'Tool failed';
        const secrets=featureCtx?await executionSecrets(featureCtx,context.chatId):undefined;
        return textResult(String(secrets?secrets.redact(message):message), true);
      }
    },
  } as AgentTool;
}

export function toToolResult(value: JsonValue): ToolResult {
  const parsed = ToolResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (typeof value === 'string') return textResult(value);
  return textResult(JSON.stringify(value));
}
