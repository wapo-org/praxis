import { z } from 'zod';
import {
  ApprovalSchema, CapabilitiesSchema, ChatSchema, ConversationSetupSchema, ElicitationSchema,
  IdSchema, JsonObjectSchema, JsonValueSchema, MessagePartSchema, MessageSchema, RunSchema,
  UsageSchema, type Capabilities, type JsonObject, type JsonValue, type Message,
  type Mode, type ProviderFlavor, type RunEventPayload, type ToolSpec,
} from '@praxis/protocol';

export const ProviderRequestSchema = z.object({
  model: IdSchema, system: z.string(), messages: z.array(MessageSchema),
  tools: z.array(z.lazy(() => ConversationSetupSchema.shape.tools.element)),
  capabilities: CapabilitiesSchema, maxTokens: z.number().int().positive(),
  effort: z.string().optional(), supportedEfforts: z.array(z.string()).optional(),
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
  z.object({type:z.literal('text'),index:z.number().int().nonnegative(),text:z.string()}),
  z.object({type:z.literal('reasoning'),index:z.number().int().nonnegative(),text:z.string()}),
  z.object({type:z.literal('tool'),index:z.number().int().nonnegative(),id:IdSchema,name:z.string()}),
  z.object({type:z.literal('arguments'),index:z.number().int().nonnegative(),json:z.string()}),
  z.object({type:z.literal('blockEnd'),index:z.number().int().nonnegative()}),
  z.object({type:z.literal('completed'),response:ProviderResponseSchema}),
]);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;
export interface ModelProvider {
  readonly flavor: ProviderFlavor;
  readonly capabilities: Capabilities;
  stream(request:ProviderRequest,signal:AbortSignal):AsyncIterable<ProviderEvent>;
}
export const ToolResultSchema = z.object({
  content:z.array(JsonObjectSchema), isError:z.boolean().default(false), outputRef:IdSchema.optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;
/** Tool results longer than this are truncated and spilled (read back with read_tool_output). */
export const MAX_RESULT_CHARACTERS=32000;
export function textResult(text:string,isError=false):ToolResult {
  return {content:[{type:'text',text}],isError};
}
export interface ToolContext {
  userId:string; chatId:string; runId:string; mode:Mode; signal:AbortSignal;
  /** A stable execution id. Side-effecting tools must use it as their idempotency key. */
  callId:string;
  callTool(name:string,args:JsonValue):Promise<ToolResult>;
  /** `mode:'url'` asks the user to open `url` (e.g. a connector sign-in); the response carries no content. */
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
  phase:z.enum(['model','tools','terminal']),iteration:z.number().int().nonnegative(),
  pending:z.array(PendingCallSchema),
  /** `started` is persisted before a tool executes; a replay that finds it without a result knows the call was interrupted. */
  calls:z.record(z.string(),z.object({call:PendingCallSchema,result:ToolResultSchema.optional(),key:z.string().optional(),started:z.boolean().optional()})),
  /** Transcript messages saved with the checkpoint but not yet delivered as `messages.committed` (durable outbox). */
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
  /** Must persist a detached snapshot; includes userId for every write. Scheduler must serialize a run. */
  save(userId:string,checkpoint:AgentCheckpoint):Promise<void>;
  /** API owns durable event IDs/SSE. Return the assigned sequence to update run.lastEventId. */
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
  contextWindow?:number;compactAt?:number;
  shouldYield?:()=>boolean;
}
