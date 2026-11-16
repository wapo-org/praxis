import { z } from 'zod';
import {ReasoningShapeSchema,StreamAnnotationSchema} from '@praxis/protocol';
import {
  ToolErrorSchema, ApprovalSchema, CapabilitiesSchema, ChatSchema, ConversationSetupSchema, ElicitationSchema,
  IdSchema, JsonObjectSchema, JsonValueSchema, MessagePartSchema, MessageSchema, RunSchema,
  UsageSchema, type Capabilities, type JsonObject, type JsonValue, type Mode, type RunEventPayload, type ToolSpec,
} from '@praxis/protocol';

export const ProviderRequestSchema = z.object({
  model: IdSchema, system: z.string(), messages: z.array(MessageSchema),
  tools: z.array(z.lazy(() => ConversationSetupSchema.shape.tools.element)),
  capabilities: CapabilitiesSchema, maxTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  titleReasoning:z.enum(['none','minimal','low']).optional(),effort: z.string().optional(), supportedEfforts: z.array(z.string()).optional(),
  webSearch: z.boolean().default(false),
});
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export const ProviderResponseSchema = z.object({
  parts: z.array(MessagePartSchema),
  stop: z.enum(['endTurn','toolUse','maxTokens','pauseTurn','refusal','contextWindowExceeded']),
  usage: UsageSchema.default({type:'usage',inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}),
  raw: MessageSchema.shape.raw,
});
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;
export const ProviderEventSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('text'),index:z.number().int().nonnegative(),text:z.string(),annotations:z.array(StreamAnnotationSchema).optional()}),
  z.object({type:z.literal('reasoning'),index:z.number().int().nonnegative(),text:z.string(),shape:ReasoningShapeSchema.optional(),redacted:z.boolean().optional()}),
  z.object({type:z.literal('tool'),index:z.number().int().nonnegative(),id:IdSchema,name:z.string(),server:z.boolean().optional()}),
  z.object({type:z.literal('arguments'),index:z.number().int().nonnegative(),json:z.string()}),
  z.object({type:z.literal('blockEnd'),index:z.number().int().nonnegative(),shape:ReasoningShapeSchema.optional(),redacted:z.boolean().optional()}),
  z.object({type:z.literal('completed'),response:ProviderResponseSchema}),
]);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;
export interface ModelProvider {
  readonly capabilities: Capabilities;
  complete?(request:ProviderRequest,signal:AbortSignal):Promise<ProviderResponse>;
  stream(request:ProviderRequest,signal:AbortSignal):AsyncIterable<ProviderEvent>;
}
const ToolResultContent = {content: z.array(JsonObjectSchema), outputRef: IdSchema.optional()};
export const ToolResultSchema = z.discriminatedUnion('isError', [
  z.object({...ToolResultContent, isError: z.literal(false).default(false), error: z.never().optional()}),
  z.object({...ToolResultContent, isError: z.literal(true), error: ToolErrorSchema.optional()}),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;
/** Results beyond this spill and truncate for read_tool_output. */
export const MAX_RESULT_CHARACTERS=32000;
export function textResult(text:string,isError=false):ToolResult {
  const content = [{type: 'text', text}];
  return isError ? {content, isError: true} : {content, isError: false};
}
export interface ToolContext {
  userId:string; chatId:string; runId:string; mode:Mode; signal:AbortSignal;
  /** Stable idempotency key for side-effecting tools. */
  callId:string;
  callTool(name:string,args:JsonValue):Promise<ToolResult>;
  /** mode:'url' opens external URL (e.g. sign-in) without response content. */
  elicit(request:{message:string;schema:JsonObject;mode?:'form'|'url';url?:string;connectorId?:string;connectorName?:string}):Promise<z.infer<typeof import('@praxis/protocol').ElicitationResponseSchema>>;
  emit(event:RunEventPayload):Promise<void>;
}
export interface AgentTool {
  spec:ToolSpec;
  /** Hidden tools are reachable through callTool only, never directly from a model. */
  hidden?:boolean;
  unavailableReason?:string;
  /** Trusted adapter classification; the displayed frozen catalog stays unchanged. */
  classify?(args:JsonValue):{traits:ToolSpec['traits'];policyKey?:string};
  execute(args:JsonValue,context:ToolContext):Promise<ToolResult>;
}
export const PolicySchema=z.object({trustedSources:z.array(z.string()).default([]),alwaysAllow:z.array(z.string()).default([])});
export type Policy = z.infer<typeof PolicySchema>;
export const PendingCallSchema=z.object({
  id:IdSchema,name:z.string(),arguments:JsonValueSchema,parentCallId:IdSchema.optional(),
  decision:z.enum(['allowOnce','allowAlways','deny']).optional(),
});
export const CheckpointSchema = z.object({
  version:z.literal(1),userId:IdSchema,run:RunSchema,chat:ChatSchema,
  setup:ConversationSetupSchema,messages:z.array(MessageSchema),modelId:IdSchema,
  effort:z.string().optional(),supportedEfforts:z.array(z.string()).optional(),webSearch:z.boolean().default(false),
  capabilities:CapabilitiesSchema,policy:PolicySchema,
  hiddenTools:ConversationSetupSchema.shape.tools.default([]),
  lastToolCallId:IdSchema.optional(),
  phase:z.enum(['model','tools','terminal']),iteration:z.number().int().nonnegative(),
  pending:z.array(PendingCallSchema),
  /** started is saved before execution so replay detects interrupted calls. */
  calls:z.record(z.string(),z.object({call:PendingCallSchema,result:ToolResultSchema.optional(),key:z.string().optional(),started:z.boolean().optional()})),
  /** Durable outbox awaiting messages.committed delivery. */
  outbox:z.array(MessageSchema).default([]),
  approval:ApprovalSchema.optional(),elicitation:ElicitationSchema.optional(),
  resolutions:z.record(z.string(),JsonValueSchema),
  maxIterations:z.number().int().positive().default(40),maxTokens:z.number().int().positive().default(8192),
  modelMaxTokens:z.number().int().positive().optional(),maxRetries:z.number().int().nonnegative().default(3),
  pauses:z.number().int().nonnegative().default(0),maxPauses:z.number().int().nonnegative().default(5),
  compaction:z.object({covered:z.number().int().positive(),fingerprint:z.string(),summary:z.string()}).optional(),
  usage:UsageSchema,
});
export type AgentCheckpoint=z.infer<typeof CheckpointSchema>;
export type PendingCall=z.infer<typeof PendingCallSchema>;
export const RunInputSchema = z.object({
  userId:IdSchema,run:RunSchema,chat:ChatSchema,messages:z.array(MessageSchema),
  setup:ConversationSetupSchema.optional(),modelId:IdSchema.optional(),effort:z.string().optional(),
  supportedEfforts:z.array(z.string()).optional(),webSearch:z.boolean().optional(),
  policy:PolicySchema.optional(),maxIterations:z.number().int().positive().optional(),
  maxTokens:z.number().int().positive().optional(),modelMaxTokens:z.number().int().positive().optional(),
  maxRetries:z.number().int().nonnegative().optional(),
});
export type RunInput=z.infer<typeof RunInputSchema>;
export interface AgentPorts {
  /** Must persist a detached owner-scoped snapshot; scheduler serializes runs. */
  save(userId:string,checkpoint:AgentCheckpoint):Promise<void>;
  /** Return assigned durable sequence to update run.lastEventId. */
  emit(userId:string,runId:string,event:RunEventPayload):Promise<number|void>;
  isCancelled(userId:string,runId:string):Promise<boolean>;
  now?():string; id?():string;
  /** Durable delay/handoff can be injected; default delay is abortable. */
  sleep?(ms:number,signal:AbortSignal):Promise<void>;
  spill?(userId:string,runId:string,callId:string,text:string):Promise<string>;
  summarize?(request:ProviderRequest,signal:AbortSignal):Promise<string>;
}
export interface AgentRunnerOptions {
  provider:ModelProvider;tools?:AgentTool[];ports:AgentPorts;
  maxResultCharacters?:number;toolTimeoutMs?:number;streamTimeoutMs?:number;
  /** Current server-authored connector advertisements; replaces the frozen connector section. */
  toolNotes?:string[];
  contextWindow?:number;compactAt?:number;
  shouldYield?:()=>boolean;
}
