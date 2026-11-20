import { z } from 'zod';
import {SubagentIdSchema, SUBAGENT_LIMITS} from './subagents.js';
import {RunTaintSchema, TaintSourceSchema} from './taint.js';
export const PROTOCOL_VERSION = 1;
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
export const IdSchema = z.string().min(1).max(200);
export const TimestampSchema = z.iso.datetime({ offset: false }); // ISO-8601 UTC, e.g. 2026-10-29T14:00:00.000Z
export const ModeSchema = z.enum(['ask', 'plan', 'build', 'auto']);
export type Mode = z.infer<typeof ModeSchema>;
export const ReasoningShapeSchema = z.enum(['titles', 'summary', 'raw', 'redacted', 'none']);
export type ReasoningShape = z.infer<typeof ReasoningShapeSchema>;
export const StreamAnnotationSchema = z.object({
  type: z.enum(['citation', 'refusal', 'image']),
  url: z.string().optional(),
  title: z.string().optional(),
  citedText: z.string().optional(),
  startIndex: z.number().int().nonnegative().optional(),
  endIndex: z.number().int().nonnegative().optional(),
  mediaType: z.string().optional(),
  data: z.string().optional(),
  text: z.string().optional(),
});
export type StreamAnnotation = z.infer<typeof StreamAnnotationSchema>;
export const CapabilitiesSchema = z.object({
  type: z.literal('capabilities').default('capabilities'),
  tools: z.boolean().default(true), parallelToolCalls: z.boolean().default(false),
  vision: z.boolean().default(false), documents: z.boolean().default(false),
  imagesInToolResults: z.boolean().default(false), reasoningEffort: z.boolean().default(false),
  streamUsage: z.boolean().default(false), explicitPromptCaching: z.boolean().default(false),
  serverWebSearch: z.boolean().default(false), midConversationSystem: z.boolean().default(false),
  serverCompaction: z.boolean().default(false), toolSearch: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
/** The user's own OpenRouter key, as clients see it. The key itself is sealed server-side and never returned. */
export const ModelKeySchema = z.object({
  type: z.literal('modelKey'), maskedKey: z.string(), label: z.string().optional(), connectedAt: TimestampSchema,
  /** Set when OpenRouter last rejected the key (401); cleared by a successful check or reconnect. */
  lastError: z.string().optional(),
  /** Credit limit and remaining credit in USD; null means OpenRouter reports no limit on this key. */
  limit: z.number().nullable().optional(), limitRemaining: z.number().nullable().optional(),
});
export type ModelKey = z.infer<typeof ModelKeySchema>;
const connectType = z.literal('modelKey.connect').default('modelKey.connect');
/** OpenRouter's one-time PKCE code; the web exchange and the iOS app handoff (PRA-81) accept exactly this. */
export const OpenRouterAuthCodeSchema = z.string().min(1).max(2000);
/** Hosted https page OpenRouter redirects iOS sign-ins to; it forwards the code to the app scheme. */
export const OPENROUTER_APP_CALLBACK_PATH = '/settings/openrouter/app-callback';
/** Registered in PraxisChat's Info.plist; the iOS ASWebAuthenticationSession listens for this scheme. */
export const OPENROUTER_APP_REDIRECT = 'praxis-app://openrouter/callback';
/** What the handoff sends the app (`?error=`) instead of a code. */
export const OpenRouterAppHandoffErrorSchema = z.enum(['missing_code', 'invalid_code']);
export type OpenRouterAppHandoffError = z.infer<typeof OpenRouterAppHandoffErrorSchema>;
export const ModelKeyConnectInputSchema = z.discriminatedUnion('method', [
  z.object({type: connectType, method: z.literal('paste'), apiKey: z.string().min(1).max(500)}),
  z.object({type: connectType, method: z.literal('pkce'), code: OpenRouterAuthCodeSchema, codeVerifier: z.string().min(43).max(128)}),
]);
export type ModelKeyConnectInput = z.infer<typeof ModelKeyConnectInputSchema>;
/** One entry of the shared OpenRouter catalogue. Prices are OpenRouter's USD-per-token strings. */
export const CatalogModelSchema = z.object({
  type: z.literal('catalogModel').default('catalogModel'), reasoningMandatory:z.boolean().optional(), id: IdSchema, name: z.string(),
  contextLength: z.number().int().positive(), maxOutput: z.number().int().positive().optional(),
  pricing: z.object({prompt: z.string(), completion: z.string()}),
  /** `files`: the model takes PDF/file input natively (absent on older cached entries = false). */
  capabilities: z.object({tools: z.boolean(), reasoning: z.boolean(), images: z.boolean(), files: z.boolean().default(false)}),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
/** A catalogue entry as `GET /v1/models` lists it: plus this user's pin/favourite and the curated flag. */
export const ModelListItemSchema = CatalogModelSchema.extend({pinned: z.boolean(), favorite: z.boolean(), recommended: z.boolean()});
export type ModelListItem = z.infer<typeof ModelListItemSchema>;
export const ModelPreferenceSchema = z.object({type:z.literal('model.preference'), modelId:IdSchema, pinned:z.boolean().optional(),favorite:z.boolean().optional()});
export const ModelPreferenceRecordSchema = z.object({type:z.literal('modelPreference'), modelId:IdSchema, pinned:z.boolean(), favorite:z.boolean()});
export type ModelPreferenceRecord = z.infer<typeof ModelPreferenceRecordSchema>;
export const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-5.5';
/** Curated short list ordered above the catalogue; missing IDs are skipped. */
export const RECOMMENDED_MODELS = ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-haiku-5.5', 'openai/gpt-5.6-sol', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash'] as const;
/** Effort levels offered for models whose catalogue entry supports reasoning. */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export const RunErrorCodeSchema = z.enum(['model_key_missing', 'model_key_invalid', 'model_credit_exhausted']);
export type RunErrorCode = z.infer<typeof RunErrorCodeSchema>;
export const ToolSourceSchema = z.object({type:z.enum(['builtin','skill','javascript','mcp','server']),serverId:IdSchema.optional(),serverName:z.string().optional()});
export const ToolPresentationSchema = z.object({type:z.literal('tool.presentation').default('tool.presentation'),category:z.enum(['integration','command','webSearch','webFetch','readFile','edit','skill','other']),runningTitle:z.string(),finishedTitle:z.string()});
export const ToolSpecSchema = z.object({originalName:z.string().optional(),type:z.literal('tool.spec'),name:z.string(),description:z.string(),inputSchema:JsonObjectSchema,source:ToolSourceSchema,traits:z.array(z.enum(['readOnly','destructive','idempotent','openWorld','sandboxed']))});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;
export const READ_TOOL_OUTPUT_TOOL_NAME = 'read_tool_output';
export const ATTACHMENT_LIMITS = {uploadBytes: 25_000_000, inlineDocumentBytes: 10 << 20, inlineTextBytes: 200_000, codeReadBytes: 1_000_000} as const;
export const AttachmentSchema = z.object({type:z.literal('attachment'),id:IdSchema,name:z.string(),mediaType:z.string(),size:z.number().int().nonnegative(),url:z.string().optional(),hiddenFromCode:z.boolean().default(false)});
export type Attachment = z.infer<typeof AttachmentSchema>;
export const MessagePartSchema = z.object({
  type:z.enum(['text','note','image','document','reasoning','toolCall','toolResult']),
  text:z.string().optional(), attachmentId:IdSchema.optional(), mediaType:z.string().optional(),
  url:z.string().optional(), data:z.string().optional(), signature:z.string().optional(),
  callId:IdSchema.optional(),name:z.string().optional(),arguments:z.string().optional(),
  content:z.array(JsonObjectSchema).optional(),isError:z.boolean().optional(),outputRef:IdSchema.optional(),
  afterToolCallId:IdSchema.optional(),blockId:IdSchema.optional(),shape:ReasoningShapeSchema.optional(),redacted:z.boolean().optional(),
  startedAt:TimestampSchema.optional(),finishedAt:TimestampSchema.optional(),durationMs:z.number().nonnegative().optional(),
  annotations:z.array(StreamAnnotationSchema).optional(),
  /** Structural untrusted-content mark set when a tool result is stored; history taint reads only this. */
  taintSource:TaintSourceSchema.optional(),
});
export type MessagePart = z.infer<typeof MessagePartSchema>;
export const MessageSchema = z.object({
  type:z.literal('message'),id:IdSchema,chatId:IdSchema,runId:IdSchema.optional(),clientTurnId:IdSchema.optional(),promptStartedAt:TimestampSchema.optional(),
  role:z.enum(['user','assistant']),parts:z.array(MessagePartSchema),
  raw:z.object({type:z.literal('provider.payload'),data:JsonValueSchema}).optional(),
  createdAt:TimestampSchema,updatedAt:TimestampSchema,sequence:z.number().int().positive().optional(),
});
export type Message = z.infer<typeof MessageSchema>;
export const ConversationSetupSchema = z.object({type:z.literal('conversation.setup'),system:z.string(),tools:z.array(ToolSpecSchema),hiddenTools:z.array(ToolSpecSchema).optional(),skillCatalog:z.string(),connectorIds:z.array(IdSchema),createdAt:TimestampSchema});
export type ConversationSetup = z.infer<typeof ConversationSetupSchema>;
export const ChatSchema = z.object({
  type:z.literal('chat'),webToolsEnabled:z.boolean().optional(),titleRevision:z.string().optional(),id:IdSchema,pinned:z.boolean().default(false),title:z.string(),mode:ModeSchema,modelId:z.string().optional(),effort:z.string().optional(),
  connectorIds:z.array(IdSchema).default([]),disabledConnectorIds:z.array(IdSchema).default([]),
  setup:ConversationSetupSchema.optional(),createdAt:TimestampSchema,updatedAt:TimestampSchema,deletedAt:TimestampSchema.optional(),activeRunId:IdSchema.optional(),
});
export type Chat = z.infer<typeof ChatSchema>;
export const ChatInputSchema = z.object({type:z.literal('chat.input'),webToolsEnabled:z.boolean().optional(),id:IdSchema.optional(),pinned:z.boolean().optional(),title:z.string().max(300).default('New chat'),mode:ModeSchema.default('build'),modelId:z.string().optional(),effort:z.string().optional(),connectorIds:z.array(IdSchema).default([]),disabledConnectorIds:z.array(IdSchema).default([])});
export const ChatPatchSchema = ChatInputSchema.partial().extend({type:z.literal('chat.patch'),title:ChatInputSchema.shape.title.removeDefault().optional(),mode:ChatInputSchema.shape.mode.removeDefault().optional(),connectorIds:ChatInputSchema.shape.connectorIds.removeDefault().optional(),disabledConnectorIds:ChatInputSchema.shape.disabledConnectorIds.removeDefault().optional()});
export const WorkflowRunStatusSchema = z.enum(['queued', 'running', 'paused', 'cancelling', 'completed', 'cancelled', 'failed']);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export const RunStatusSchema = z.enum([
  ...WorkflowRunStatusSchema.options, 'awaitingApproval', 'awaitingElicitation', 'continuing',
]);
export const RUN_START_CONFLICT_CODE = 'idempotency_conflict';
export const RunOutcomeSchema = z.enum(['completed','truncated','maxIterations','refused','cancelled','failed']);
export const RunSchema = z.object({type:z.literal('run'),id:IdSchema,chatId:IdSchema,status:RunStatusSchema,outcome:RunOutcomeSchema.optional(),error:z.string().optional(),errorCode:RunErrorCodeSchema.optional(),note:z.string().optional(),createdAt:TimestampSchema,updatedAt:TimestampSchema,lastEventId:z.number().int().nonnegative(),clientTurnId:IdSchema.optional(),parentRunId:IdSchema.optional(),promptStartedAt:TimestampSchema.optional(),taint:RunTaintSchema.optional()});
export type Run = z.infer<typeof RunSchema>;
export const StreamSimOptionsSchema = z.object({
  sample: z.enum(['short', 'torture']).default('torture'),
  stallDuration: z.enum(['3s', '10s']).default('3s'),
  chunkSize: z.enum(['char', 'token', 'word', 'sentence', '2kb', 'whole']).default('token'),
  speed: z.enum(['2tps', '40tps', '1500tps', 'burstStall', 'jitter', 'instant']).default('40tps'),
  splitMode: z.enum(['none', 'markdown', 'encoding', 'torture']).default('none'),
  reasoningShape: ReasoningShapeSchema.default('summary'),
  edgeCase: z.enum(['none', 'emptyDeltas', 'duplicateFinal', 'reasoningAfterText', 'midStreamError', 'interleavedTools']).default('none'),
});
export type StreamSimOptions = z.infer<typeof StreamSimOptionsSchema>;
export const StartRunSchema = z.object({regenerateMessageId:IdSchema.optional(),suggestedTitle:z.string().max(42).optional(),
  type:z.literal('run.start'),chatId:IdSchema,text:z.string().max(200000).default(''),
  modelId:z.string().optional(),mode:ModeSchema.optional(),effort:z.string().optional(),
  attachmentIds:z.array(IdSchema).default([]),idempotencyKey:IdSchema.optional(),clientTurnId:IdSchema.optional(),
  script:z.enum([
    'text','tools','approval','nestedApproval','taintedApproval','elicitation','elicitationURL','error','long','compaction','vision',
    'reasoningTitles','reasoningSummary','reasoningRaw','reasoningRedacted','reasoningNone','reasoningInterleaved','helloReplay','realShape','streamSim','codeFeatures','bursty',
  ]).optional(),
  streamSim:StreamSimOptionsSchema.optional(),
});
export type StartRun = z.infer<typeof StartRunSchema>;
export const ApprovalSchema = z.object({type:z.literal('approval'),id:IdSchema,callId:IdSchema,toolName:z.string(),source:ToolSourceSchema,arguments:JsonValueSchema,reason:z.string(),title:z.string(),parentCallId:IdSchema.optional(),taintSource:TaintSourceSchema.optional()});
export type Approval = z.infer<typeof ApprovalSchema>;
export const ApprovalChoiceSchema = z.enum(['allowOnce','allowAlways','deny']);
export const ApprovalDecisionSchema = z.object({type:z.literal('approval.decision'),approvalId:IdSchema,decision:ApprovalChoiceSchema});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export const ElicitationSchema = z.object({type:z.literal('elicitation'),id:IdSchema,message:z.string(),schema:JsonObjectSchema,callId:IdSchema.optional(),parentCallId:IdSchema.optional(),connectorId:IdSchema.optional(),connectorName:z.string().optional(),mode:z.enum(['form','url']).optional(),url:z.string().url().optional()});
export const ElicitationResponseSchema = z.object({type:z.literal('elicitation.response'),elicitationId:IdSchema,action:z.enum(['accept','decline','cancel']),content:JsonObjectSchema.optional()});
export const UsageSchema = z.object({type:z.literal('usage').default('usage'),inputTokens:z.number().nonnegative(),outputTokens:z.number().nonnegative(),cacheReadTokens:z.number().nonnegative().default(0),cacheWriteTokens:z.number().nonnegative().default(0),cost:z.number().nonnegative().optional()});
export type Usage = z.infer<typeof UsageSchema>;
export const ToolDisplaySchema = z.object({title:z.string(),detail:z.string().optional(),connectorId:z.string().optional(),connectorName:z.string().optional(),icon:z.string().optional()});
export const ToolActivitySchema = z.object({display:ToolDisplaySchema.optional(),type:z.literal('tool.activity'),id:IdSchema,name:z.string(),source:ToolSourceSchema,presentation:ToolPresentationSchema,arguments:JsonValueSchema.optional(),parentCallId:IdSchema.optional()});
export const ToolCompletionSchema = z.object({type:z.literal('tool.completion'),status:z.enum(['succeeded','failed','denied','cancelled']),summary:z.string(),preview:z.string(),content:z.array(JsonObjectSchema).optional(),outputRef:IdSchema.optional()});
export const RunEventPayloadSchema = z.discriminatedUnion('type',[
 z.object({type:z.literal('run.started')}),
 z.object({type:z.literal('iteration.started'),iteration:z.number().int()}),
 z.object({type:z.literal('text.delta'),blockId:IdSchema,text:z.string(),annotations:z.array(StreamAnnotationSchema).optional()}),
 z.object({type:z.literal('text.finished'),blockId:IdSchema,annotations:z.array(StreamAnnotationSchema).optional()}),
 z.object({type:z.literal('reasoning.delta'),blockId:IdSchema,text:z.string(),shape:ReasoningShapeSchema.optional(),redacted:z.boolean().optional(),startedAt:TimestampSchema.optional()}),
 z.object({type:z.literal('reasoning.finished'),blockId:IdSchema,shape:ReasoningShapeSchema.optional(),redacted:z.boolean().optional(),startedAt:TimestampSchema.optional(),finishedAt:TimestampSchema.optional(),durationMs:z.number().nonnegative().optional()}),
 z.object({type:z.literal('tool.started'),activity:ToolActivitySchema}),
 z.object({type:z.literal('tool.arguments.delta'),callId:IdSchema,json:z.string()}),
 z.object({type:z.literal('tool.ready'),activity:ToolActivitySchema}),
 z.object({type:z.literal('approval.requested'),approval:ApprovalSchema}),
 z.object({type:z.literal('approval.resolved'),approvalId:IdSchema,callId:IdSchema,decision:z.enum(['allowOnce','allowAlways','deny'])}),
 z.object({type:z.literal('tool.running'),callId:IdSchema}),
 z.object({type:z.literal('tool.progress'),callId:IdSchema,kind:z.enum(['output','trace','status']),text:z.string().optional(),lines:z.array(z.string()).optional(),traceKind:z.enum(['skill','api','image','network','note']).optional()}),
 z.object({type:z.literal('tool.finished'),callId:IdSchema,completion:ToolCompletionSchema}),
 z.object({type:z.literal('elicitation.requested'),elicitation:ElicitationSchema}),
 z.object({type:z.literal('elicitation.resolved'),elicitationId:IdSchema,action:z.enum(['accept','decline','cancel'])}),
 z.object({type:z.literal('attempt.discarded'),blockIds:z.array(IdSchema),toolCallIds:z.array(IdSchema)}),
 z.object({type:z.literal('retrying'),attempt:z.number().int(),delayMs:z.number(),reason:z.string()}),
 z.object({type:z.literal('usage'),usage:UsageSchema}),
 z.object({type:z.literal('compaction'),id:IdSchema,phase:z.enum(['started','finished','failed']),summary:z.string().optional(),throughMessageId:IdSchema.optional(),inputTokens:z.number().optional(),outputTokens:z.number().optional(),reason:z.string().optional()}),
 z.object({type:z.literal('context.measured'),inputTokens:z.number(),messageCount:z.number().int(),modelId:z.string()}),
 z.object({type:z.literal('messages.committed'),messages:z.array(MessageSchema)}),
 z.object({type:z.literal('policy.updated'),alwaysAllowKey:z.string()}),
 z.object({type:z.literal('vision.activity'),id:IdSchema,phase:z.enum(['started','finished','failed']),attachmentId:IdSchema,modelId:z.string().optional(),question:z.string().optional(),answer:z.string().optional()}),
 z.object({type:z.literal('run.parked'),reason:z.enum(['approval','elicitation','continuation'])}),
 z.object({type:z.literal('run.finished'),outcome:RunOutcomeSchema,message:z.string().optional(),code:RunErrorCodeSchema.optional()}),
]);
export type RunEventPayload = z.infer<typeof RunEventPayloadSchema>;
export const RunEventSchema = z.object({type:z.literal('run.event'),id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),runId:IdSchema,chatId:IdSchema,createdAt:TimestampSchema,event:RunEventPayloadSchema});
export type RunEvent = z.infer<typeof RunEventSchema>;
export const ConnectorStatusSchema = z.enum(['connected','unreachable','needs_auth','needs_reauth','error']);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;
/** Last handshake status; UI renders status rather than authStatus alone. */
export const ConnectorSchema = z.object({type:z.literal('connector'),status:ConnectorStatusSchema.optional(),lastCheckedAt:TimestampSchema.optional(),statusCode:z.string().optional(),error:z.string().optional(),toolCount:z.number().int().optional(),promptsCount:z.number().int().optional(),hasNewTools:z.boolean().optional(),headerNames:z.array(z.string()).optional(),id:IdSchema,name:z.string(),url:z.string().url(),transport:z.enum(['streamableHttp','sse']),enabled:z.boolean(),trusted:z.boolean(),disabledTools:z.array(z.string()),authStatus:z.enum(['none','required','connected']),updatedAt:TimestampSchema});
export type Connector = z.infer<typeof ConnectorSchema>;
export const ConnectorInputSchema = z.object({type:z.literal('connector.input'),name:z.string().min(1).max(100),url:z.string().url(),transport:z.enum(['streamableHttp','sse']).default('streamableHttp'),enabled:z.boolean().default(true),trusted:z.boolean().default(false),disabledTools:z.array(z.string()).default([]),extraHeaders:z.record(z.string(),z.string()).optional(),token:z.string().optional()});
export const ConnectorPatchSchema = ConnectorInputSchema.partial().extend({type:z.literal('connector.patch')});
export const ConsentSchema = z.object({type:z.literal('consent'),host:z.string().min(1),allowed:z.boolean(),updatedAt:TimestampSchema.optional()});
export const SkillSchema = z.object({type:z.literal('skill'),id:IdSchema,name:z.string(),description:z.string(),document:z.string(),enabled:z.boolean(),updatedAt:TimestampSchema,registryId:IdSchema.optional(),registryEntryId:IdSchema.optional(),registryDigest:z.string().optional()});
export type Skill = z.infer<typeof SkillSchema>;
export const SkillInputSchema = z.object({type:z.literal('skill.input'),name:z.string().min(1).max(100),description:z.string().max(2000),document:z.string().max(500000),enabled:z.boolean().default(true)});
export const RegistrySchema = z.object({type:z.literal('skill.registry'),id:IdSchema,name:z.string(),url:z.string().url(),enabled:z.boolean()});
export const RegistryInputSchema = z.object({type:z.literal('skill.registry.input'),name:z.string().min(1),url:z.string().url(),enabled:z.boolean().default(true)});
export const UploadRequestSchema = z.object({type:z.literal('upload.request'),clientAttachmentId:IdSchema.optional(),name:z.string().min(1),mediaType:z.string().min(1),size:z.number().int().positive().max(ATTACHMENT_LIMITS.uploadBytes),chatId:IdSchema.optional()});
export const UploadCompleteSchema = z.object({type:z.literal('upload.complete'),clientAttachmentId:IdSchema.optional(),hiddenFromCode:z.boolean().default(false),storageId:IdSchema,name:z.string(),mediaType:z.string(),size:z.number().int().nonnegative(),chatId:IdSchema.optional()});
export const TranscriptionSchema = z.object({type:z.literal('transcription'),text:z.string(),language:z.string().optional(),segments:z.array(z.object({type:z.literal('transcription.segment'),start:z.number(),end:z.number(),text:z.string()}))});
export const UserSchema = z.object({type:z.literal('user'),id:IdSchema,name:z.string(),email:z.string().optional()});
export type User = z.infer<typeof UserSchema>;
export const SessionSchema = z.object({type:z.literal('session'),user:UserSchema,expiresAt:TimestampSchema,bearerToken:z.string().optional()});
export const AuthInputSchema = z.object({type:z.literal('auth.input'),email:z.string().email(),password:z.string().min(12).max(256),name:z.string().max(100).optional()});
export const PreferencesSchema = z.object({type:z.literal('preferences'),vision:z.object({type:z.literal('vision.preferences').default('vision.preferences'),modelId:z.string().optional(),enabled:z.boolean().default(true)}),voice:z.object({type:z.literal('voice.preferences').default('voice.preferences'),model:z.string().default('whisper-large-v3-turbo'),language:z.string().optional(),configured:z.boolean().default(false)}),updatedAt:TimestampSchema});
export const PreferencesInputSchema = z.object({type:z.literal('preferences.input'),vision:z.object({modelId:z.string().optional(),enabled:z.boolean().optional()}).optional(),voice:z.object({model:z.string().optional(),language:z.string().optional(),apiKey:z.string().optional()}).optional()});
export const BootstrapSchema = z.object({type:z.literal('bootstrap'),protocolVersion:z.number().int(),user:UserSchema,chats:z.array(ChatSchema),modelKey:ModelKeySchema.optional(),modelPreferences:z.array(ModelPreferenceRecordSchema).default([]),connectors:z.array(ConnectorSchema),skills:z.array(SkillSchema),consents:z.array(ConsentSchema).optional(),registries:z.array(RegistrySchema).optional(),preferences:PreferencesSchema.optional(),activeRuns:z.array(RunSchema),syncCursor:z.string(),syncRoot:z.string(),serverTime:TimestampSchema,eventCursor:z.number().int().nonnegative().optional()});
export type Bootstrap = z.infer<typeof BootstrapSchema>;
export type UserEvent = z.infer<typeof UserEventSchema>;
export const UserEventSchema = z.object({type:z.literal('user.event'),id:z.number().int().positive(),createdAt:TimestampSchema,entity:z.enum(['chat','message','run','modelKey','modelPreference','connector','skill','consent','attachment']),entityId:IdSchema,operation:z.enum(['upsert','delete']),value:JsonValueSchema.optional(),syncCursor:z.string()});
export const PageQuerySchema = z.object({cursor:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).default(50),q:z.string().max(500).optional()});
export function PageSchema<T extends z.ZodType>(item:T){return z.object({type:z.literal('page'),items:z.array(item),nextCursor:z.string().nullable()});}
export const SyncRequestSchema = z.object({type:z.literal('sync.request'),strategy:z.enum(['cursor','merkle']).default('cursor'),cursor:z.string().optional(),root:z.string().optional(),prefixes:z.array(z.string()).optional(),limit:z.number().int().min(1).max(1000).default(500)});
export const SyncEntitySchema = z.object({type:z.literal('sync.entity'),key:z.string(),hash:z.string(),updatedAt:TimestampSchema,deleted:z.boolean(),value:JsonValueSchema.nullable()});
export type SyncEntity = z.infer<typeof SyncEntitySchema>;
export const SyncResponseSchema = z.object({type:z.literal('sync.response'),strategy:z.enum(['cursor','merkle']),root:z.string(),cursor:z.string(),entities:z.array(SyncEntitySchema),nextCursor:z.string().nullable(),nodes:z.array(z.object({type:z.literal('sync.node'),prefix:z.string(),hash:z.string(),count:z.number().int()}))});
export const ErrorSchema = z.object({type:z.literal('error'),code:z.string(),message:z.string(),requestId:z.string().optional(),details:JsonValueSchema.optional()});
export const OkSchema = z.object({type:z.literal('ok')});
export const ENDPOINTS = {
 bootstrap:'/v1/bootstrap',chats:'/v1/chats',runs:'/v1/runs',events:'/v1/events',modelKey:'/v1/model-key',models:'/v1/models',connectors:'/v1/connectors',skills:'/v1/skills',registries:'/v1/skill-registries',uploads:'/v1/uploads',transcribe:'/v1/transcribe',sync:'/v1/sync',
} as const;

// Additive client-review fields, v1. Snapshot is authoritative even after stream retention.
export const RunBlockSchema = z.object({
  type:z.enum(['text','reasoning']),id:IdSchema,text:z.string(),finished:z.boolean(),
  shape:ReasoningShapeSchema.optional(),redacted:z.boolean().optional(),
  startedAt:TimestampSchema.optional(),finishedAt:TimestampSchema.optional(),durationMs:z.number().nonnegative().optional(),
  afterToolCallId:IdSchema.optional(),annotations:z.array(StreamAnnotationSchema).optional(),
});
export type RunBlock = z.infer<typeof RunBlockSchema>;
export const RunToolStateSchema = z.object({type:z.literal('tool.state'),activity:ToolActivitySchema,argumentsJson:z.string(),running:z.boolean(),completion:ToolCompletionSchema.optional(),progress:z.array(JsonObjectSchema)});
export const RunSnapshotSchema = z.object({type:z.literal('run.snapshot'),run:RunSchema,lastEventId:z.number().int().nonnegative(),blocks:z.array(RunBlockSchema),tools:z.array(RunToolStateSchema),pendingApprovals:z.array(ApprovalSchema),pendingElicitations:z.array(ElicitationSchema),usage:UsageSchema.optional(),messages:z.array(MessageSchema)});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export const OAuthAuthorizationSchema = z.object({type:z.literal('oauth.authorization'),url:z.string().url(),state:z.string()});
export const UploadUrlSchema = z.object({type:z.literal('upload.url'),uploadUrl:z.string().url(),method:z.enum(['POST','PUT']).optional(),expiresAt:TimestampSchema});
export const UploadReceiptSchema = z.object({type:z.literal('upload.receipt'),storageId:IdSchema});
export const SkillUpdateSchema=z.object({type:z.literal('skill.update'),skillId:IdSchema,registryId:IdSchema,entryId:IdSchema,digest:z.string(),updateAvailable:z.literal(true)});
export const SkillImportSchema=z.object({type:z.literal('skill.import'),attachmentId:IdSchema});
export const RegistryEntrySchema = z.object({type:z.literal('skill.registry.entry'),id:IdSchema,name:z.string(),description:z.string(),url:z.string().url().optional()});
export const MCPResourceSchema = z.object({type:z.literal('mcp.resource'),uri:z.string(),name:z.string(),description:z.string().optional(),mimeType:z.string().optional()});
export const MCPPromptSchema = z.object({type:z.literal('mcp.prompt'),name:z.string(),description:z.string().optional(),arguments:z.array(JsonObjectSchema).optional()});
export const MCPResourceResultSchema = z.object({type:z.literal('mcp.resource.result'),contents:z.array(JsonObjectSchema)});
export const MCPPromptResultSchema = z.object({type:z.literal('mcp.prompt.result'),description:z.string().optional(),messages:z.array(JsonObjectSchema)});

export const ChatTruncateSchema = z.object({type:z.literal('chat.truncate'),clientTurnId:IdSchema});
export const ChatTruncateResultSchema = z.object({type:z.literal('chat.truncated'),chat:ChatSchema,removedRunIds:z.array(IdSchema),removedMessageIds:z.array(IdSchema)});
export const AttachmentPatchSchema = z.object({type:z.literal('attachment.patch'),hiddenFromCode:z.boolean()});
export const TranscribeRequestSchema = z.object({type:z.literal('transcribe.request'),audioBase64:z.string().min(1).max(35000000),mediaType:z.string(),fileName:z.string().optional(),model:z.string().optional(),language:z.string().optional(),prompt:z.string().max(10000).optional()});

export const HEALTH_PATH = '/health';
export const HealthSchema = z.object({type: z.literal('health'), ok: z.boolean(), mode: z.enum(['local', 'production'])});
export type Health = z.infer<typeof HealthSchema>;
export const ACCOUNT_DELETE_PATH = '/v1/account';
export const ACCOUNT_DELETE_FRESHNESS_MS = 5 * 60 * 1000;
export const INTERNAL_CONTINUATION_PATH = '/internal/continue';
export const ACCOUNT_DELETE_RECOVERY_SIGNATURE_HEADER = 'praxis-account-recovery-signature';
export const AccountDeleteRecoverySchema = z.object({
  type: z.literal('account.delete.resume'),
  userId: z.string().min(1).max(500),
}).strict();
export const AccountDeleteSchema=z.object({type:z.literal('account.delete').optional(),password:z.string().min(1).max(1024).optional()});
export const AccountDeletedSchema=z.object({type:z.literal('account.deleted')});
export * from './tool-boundary.js';
export * from './taint.js';

export * from './auth.js';
export * from './auth-config.js';
export const TURN_PATH = '/api/turn';
export const TURN_SIGNATURE_HEADER = 'x-praxis-signature';
export const TURN_TIMESTAMP_HEADER = 'x-praxis-timestamp';
export const TURN_BODY_MAX_BYTES = 1_000_000;
export const TURN_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const TURN_RESULT_MAX_BYTES = 1_000;
export const TURN_INDEX_MAX = Number.MAX_SAFE_INTEGER;
export const TurnRequestSchema = z.object({
  userId: IdSchema, chatId: IdSchema, runId: IdSchema,
  expectedTurnIndex: z.number().int().nonnegative().max(TURN_INDEX_MAX),
  decision: z.discriminatedUnion('type', [
    ApprovalDecisionSchema.strict(), ElicitationResponseSchema.strict(),
  ]).optional(),
}).strict();
export type TurnRequest = z.infer<typeof TurnRequestSchema>;
// Only addressed child IDs cross the worker boundary; verified handoffs stay in durable subagent state.
const TurnResultFields = {
  turnIndex: z.number().int().nonnegative().max(TURN_INDEX_MAX),
  subagents: z.array(SubagentIdSchema).max(SUBAGENT_LIMITS.CHILDREN_MAX).refine(ids => new Set(ids).size === ids.length),
};
/** UTF-8 bytes a string occupies inside serialized JSON, escapes included, without its quotes. */
export function jsonStringBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).byteLength - 2;
}
/** With every other field at its maximum (480 B), both caps keep a failed result under TURN_RESULT_MAX_BYTES. */
export const TURN_FAILURE_MESSAGE_MAX_BYTES = 320;
export const TURN_FAILURE_REMEDIATION_MAX_BYTES = 160;
/** A model failure only the user can fix (reconnect, top up): the turn ends instead of holding its claim. */
export const TurnFailureSchema = z.object({
  code: RunErrorCodeSchema,
  message: z.string().refine(text => jsonStringBytes(text) <= TURN_FAILURE_MESSAGE_MAX_BYTES),
  remediation: z.string().min(1).refine(text => jsonStringBytes(text) <= TURN_FAILURE_REMEDIATION_MAX_BYTES),
}).strict();
export type TurnFailure = z.infer<typeof TurnFailureSchema>;
export const TurnResultSchema = z.discriminatedUnion('status', [
  z.object({...TurnResultFields, done: z.literal(false), status: z.enum(['ready', 'busy'])}).strict(),
  z.object({...TurnResultFields, done: z.literal(true), status: z.enum(['stopped', 'completed'])}).strict(),
  z.object({...TurnResultFields, done: z.literal(true), status: z.literal('failed'), failure: TurnFailureSchema}).strict(),
]).refine(result => new TextEncoder().encode(JSON.stringify(result)).byteLength < TURN_RESULT_MAX_BYTES);
export type TurnResult = z.infer<typeof TurnResultSchema>;
export * from './subagents.js';
export * from './web-tools.js';
