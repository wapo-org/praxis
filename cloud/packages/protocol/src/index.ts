import { z } from 'zod';
export const PROTOCOL_VERSION = 1;
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
export const IdSchema = z.string().min(1).max(200);
export const TimestampSchema = z.iso.datetime({ offset: false }); // ISO-8601 UTC, e.g. 2026-10-29T14:00:00.000Z
export const ModeSchema = z.enum(['ask', 'plan', 'build', 'auto']);
export type Mode = z.infer<typeof ModeSchema>;
export const ProviderFlavorSchema = z.enum(['anthropicMessages', 'openAIChat', 'openAIResponses']);
export type ProviderFlavor = z.infer<typeof ProviderFlavorSchema>;
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
export const ProviderRequestOptionsSchema = z.object({type:z.literal('provider.request-options').default('provider.request-options'),systemRole:z.enum(['system','developer']).optional(),maxTokensField:z.enum(['max_tokens','max_completion_tokens','omit']).optional(),replayReasoning:z.boolean().optional()});
export const ProviderSchema = z.object({
  type: z.literal('provider'), id: IdSchema, name: z.string(), flavor: ProviderFlavorSchema,
  baseUrl: z.string().url(), maskedKey: z.string(), capabilities: CapabilitiesSchema,
  updatedAt: TimestampSchema,defaultModel:z.string().optional(),requestOptions:ProviderRequestOptionsSchema.optional(),headerNames:z.array(z.string()).optional(),
});
export type Provider = z.infer<typeof ProviderSchema>;
export const ProviderInputSchema = z.object({
  type: z.literal('provider.input'), name: z.string().min(1).max(100), flavor: ProviderFlavorSchema,
  requestOptions:ProviderRequestOptionsSchema.optional(),baseUrl: z.string().url(),defaultModel:z.string().optional(), apiKey: z.string().min(1).optional(),
  capabilities: CapabilitiesSchema.optional(), extraHeaders: z.record(z.string(),z.string()).optional(),
});
export const ModelSchema = z.object({
  type: z.literal('model'), id: IdSchema, providerId: IdSchema, displayName: z.string(),
  contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(),
  tagline:z.string().optional(),speed:z.number().int().min(1).max(5).optional(),intelligence:z.number().int().min(1).max(5).optional(),supportsImages:z.boolean().nullable().optional(),capabilities: CapabilitiesSchema, reasoningEfforts: z.array(z.string()), pinned: z.boolean(), favorite: z.boolean(),
});
export type Model = z.infer<typeof ModelSchema>;
export const ModelPreferenceSchema = z.object({type:z.literal('model.preference'), providerId:IdSchema, modelId:IdSchema, pinned:z.boolean().optional(),favorite:z.boolean().optional()});
export const ToolSourceSchema = z.object({type:z.enum(['builtin','skill','javascript','mcp','server']),serverId:IdSchema.optional(),serverName:z.string().optional()});
export const ToolPresentationSchema = z.object({type:z.literal('tool.presentation').default('tool.presentation'),category:z.enum(['integration','command','webSearch','webFetch','readFile','edit','skill','other']),runningTitle:z.string(),finishedTitle:z.string()});
export const ToolSpecSchema = z.object({type:z.literal('tool.spec'),name:z.string(),description:z.string(),inputSchema:JsonObjectSchema,source:ToolSourceSchema,traits:z.array(z.enum(['readOnly','destructive','idempotent','openWorld','sandboxed']))});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;
export const AttachmentSchema = z.object({type:z.literal('attachment'),id:IdSchema,name:z.string(),mediaType:z.string(),size:z.number().int().nonnegative(),url:z.string().optional(),hiddenFromCode:z.boolean().default(false)});
export type Attachment = z.infer<typeof AttachmentSchema>;
export const MessagePartSchema = z.object({
  type:z.enum(['text','note','image','document','reasoning','toolCall','toolResult']),
  text:z.string().optional(), attachmentId:IdSchema.optional(), mediaType:z.string().optional(),
  url:z.string().optional(), data:z.string().optional(), signature:z.string().optional(),
  callId:IdSchema.optional(),name:z.string().optional(),arguments:z.string().optional(),
  content:z.array(JsonObjectSchema).optional(),isError:z.boolean().optional(),outputRef:IdSchema.optional(),
});
export type MessagePart = z.infer<typeof MessagePartSchema>;
export const MessageSchema = z.object({
  type:z.literal('message'),id:IdSchema,chatId:IdSchema,runId:IdSchema.optional(),clientTurnId:IdSchema.optional(),
  role:z.enum(['user','assistant']),parts:z.array(MessagePartSchema),
  raw:z.object({type:z.literal('provider.payload'),flavor:ProviderFlavorSchema,data:JsonValueSchema}).optional(),
  createdAt:TimestampSchema,updatedAt:TimestampSchema,sequence:z.number().int().positive().optional(),
});
export type Message = z.infer<typeof MessageSchema>;
export const ConversationSetupSchema = z.object({type:z.literal('conversation.setup'),system:z.string(),tools:z.array(ToolSpecSchema),skillCatalog:z.string(),connectorIds:z.array(IdSchema),createdAt:TimestampSchema});
export type ConversationSetup = z.infer<typeof ConversationSetupSchema>;
export const ChatSchema = z.object({
  type:z.literal('chat'),id:IdSchema,pinned:z.boolean().default(false),title:z.string(),mode:ModeSchema,providerId:IdSchema.optional(),modelId:z.string().optional(),effort:z.string().optional(),
  connectorIds:z.array(IdSchema).default([]),disabledConnectorIds:z.array(IdSchema).default([]),
  setup:ConversationSetupSchema.optional(),createdAt:TimestampSchema,updatedAt:TimestampSchema,deletedAt:TimestampSchema.optional(),activeRunId:IdSchema.optional(),
});
export type Chat = z.infer<typeof ChatSchema>;
export const ChatInputSchema = z.object({type:z.literal('chat.input'),id:IdSchema.optional(),pinned:z.boolean().optional(),title:z.string().max(300).default('New chat'),mode:ModeSchema.default('build'),providerId:IdSchema.optional(),modelId:z.string().optional(),effort:z.string().optional(),connectorIds:z.array(IdSchema).default([]),disabledConnectorIds:z.array(IdSchema).default([])});
export const ChatPatchSchema = ChatInputSchema.partial().extend({type:z.literal('chat.patch')});
export const RunStatusSchema = z.enum(['queued','running','awaitingApproval','awaitingElicitation','continuing','completed','cancelled','failed']);
export const RunOutcomeSchema = z.enum(['completed','truncated','maxIterations','refused','cancelled','failed']);
export const RunSchema = z.object({type:z.literal('run'),id:IdSchema,chatId:IdSchema,status:RunStatusSchema,outcome:RunOutcomeSchema.optional(),error:z.string().optional(),createdAt:TimestampSchema,updatedAt:TimestampSchema,lastEventId:z.number().int().nonnegative(),clientTurnId:IdSchema.optional(),parentRunId:IdSchema.optional()});
export type Run = z.infer<typeof RunSchema>;
export const StartRunSchema = z.object({
  type:z.literal('run.start'),chatId:IdSchema,text:z.string().max(200000).default(''),
  providerId:IdSchema.optional(),modelId:z.string().optional(),mode:ModeSchema.optional(),effort:z.string().optional(),
  attachmentIds:z.array(IdSchema).default([]),webSearch:z.boolean().default(false),idempotencyKey:IdSchema.optional(),clientTurnId:IdSchema.optional(),
  script:z.enum(['text','tools','approval','nestedApproval','elicitation','elicitationURL','error','long','compaction','vision']).optional(),
});
export type StartRun = z.infer<typeof StartRunSchema>;
export const ApprovalSchema = z.object({type:z.literal('approval'),id:IdSchema,callId:IdSchema,toolName:z.string(),source:ToolSourceSchema,arguments:JsonValueSchema,reason:z.string(),title:z.string(),parentCallId:IdSchema.optional()});
export type Approval = z.infer<typeof ApprovalSchema>;
export const ApprovalDecisionSchema = z.object({type:z.literal('approval.decision'),approvalId:IdSchema,decision:z.enum(['allowOnce','allowAlways','deny'])});
export const ElicitationSchema = z.object({type:z.literal('elicitation'),id:IdSchema,message:z.string(),schema:JsonObjectSchema,callId:IdSchema.optional(),parentCallId:IdSchema.optional(),connectorId:IdSchema.optional(),connectorName:z.string().optional(),mode:z.enum(['form','url']).optional(),url:z.string().url().optional()});
export const ElicitationResponseSchema = z.object({type:z.literal('elicitation.response'),elicitationId:IdSchema,action:z.enum(['accept','decline','cancel']),content:JsonObjectSchema.optional()});
export const UsageSchema = z.object({type:z.literal('usage').default('usage'),inputTokens:z.number().nonnegative(),outputTokens:z.number().nonnegative(),cacheReadTokens:z.number().nonnegative().default(0),cacheWriteTokens:z.number().nonnegative().default(0)});
export type Usage = z.infer<typeof UsageSchema>;
export const ToolActivitySchema = z.object({type:z.literal('tool.activity'),id:IdSchema,name:z.string(),source:ToolSourceSchema,presentation:ToolPresentationSchema,arguments:JsonValueSchema.optional(),parentCallId:IdSchema.optional()});
export const ToolCompletionSchema = z.object({type:z.literal('tool.completion'),status:z.enum(['succeeded','failed','denied','cancelled']),summary:z.string(),preview:z.string(),content:z.array(JsonObjectSchema).optional(),outputRef:IdSchema.optional()});
export const RunEventPayloadSchema = z.discriminatedUnion('type',[
 z.object({type:z.literal('run.started')}),
 z.object({type:z.literal('iteration.started'),iteration:z.number().int()}),
 z.object({type:z.literal('text.delta'),blockId:IdSchema,text:z.string()}),
 z.object({type:z.literal('text.finished'),blockId:IdSchema}),
 z.object({type:z.literal('reasoning.delta'),blockId:IdSchema,text:z.string()}),
 z.object({type:z.literal('reasoning.finished'),blockId:IdSchema}),
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
 z.object({type:z.literal('run.finished'),outcome:RunOutcomeSchema,message:z.string().optional()}),
]);
export type RunEventPayload = z.infer<typeof RunEventPayloadSchema>;
export const RunEventSchema = z.object({type:z.literal('run.event'),id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),runId:IdSchema,chatId:IdSchema,createdAt:TimestampSchema,event:RunEventPayloadSchema});
export type RunEvent = z.infer<typeof RunEventSchema>;
export const ConnectorSchema = z.object({type:z.literal('connector'),error:z.string().optional(),toolCount:z.number().int().optional(),promptsCount:z.number().int().optional(),hasNewTools:z.boolean().optional(),headerNames:z.array(z.string()).optional(),id:IdSchema,name:z.string(),url:z.string().url(),transport:z.enum(['streamableHttp','sse']),enabled:z.boolean(),trusted:z.boolean(),disabledTools:z.array(z.string()),authStatus:z.enum(['none','required','connected']),updatedAt:TimestampSchema});
export type Connector = z.infer<typeof ConnectorSchema>;
export const ConnectorInputSchema = z.object({type:z.literal('connector.input'),name:z.string().min(1).max(100),url:z.string().url(),transport:z.enum(['streamableHttp','sse']).default('streamableHttp'),enabled:z.boolean().default(true),trusted:z.boolean().default(false),disabledTools:z.array(z.string()).default([]),extraHeaders:z.record(z.string(),z.string()).optional(),token:z.string().optional()});
export const ConnectorPatchSchema = ConnectorInputSchema.partial().extend({type:z.literal('connector.patch')});
export const ConsentSchema = z.object({type:z.literal('consent'),host:z.string().min(1),allowed:z.boolean(),updatedAt:TimestampSchema.optional()});
export const SkillSchema = z.object({type:z.literal('skill'),id:IdSchema,name:z.string(),description:z.string(),document:z.string(),enabled:z.boolean(),updatedAt:TimestampSchema});
export type Skill = z.infer<typeof SkillSchema>;
export const SkillInputSchema = z.object({type:z.literal('skill.input'),name:z.string().min(1).max(100),description:z.string().max(2000),document:z.string().max(500000),enabled:z.boolean().default(true)});
export const RegistrySchema = z.object({type:z.literal('skill.registry'),id:IdSchema,name:z.string(),url:z.string().url(),enabled:z.boolean()});
export const RegistryInputSchema = z.object({type:z.literal('skill.registry.input'),name:z.string().min(1),url:z.string().url(),enabled:z.boolean().default(true)});
export const UploadRequestSchema = z.object({type:z.literal('upload.request'),clientAttachmentId:IdSchema.optional(),name:z.string().min(1),mediaType:z.string().min(1),size:z.number().int().positive().max(25000000),chatId:IdSchema.optional()});
export const UploadCompleteSchema = z.object({type:z.literal('upload.complete'),clientAttachmentId:IdSchema.optional(),hiddenFromCode:z.boolean().default(false),storageId:IdSchema,name:z.string(),mediaType:z.string(),size:z.number().int().nonnegative(),chatId:IdSchema.optional()});
export const TranscriptionSchema = z.object({type:z.literal('transcription'),text:z.string(),language:z.string().optional(),segments:z.array(z.object({type:z.literal('transcription.segment'),start:z.number(),end:z.number(),text:z.string()}))});
export const UserSchema = z.object({type:z.literal('user'),id:IdSchema,name:z.string(),email:z.string().optional()});
export type User = z.infer<typeof UserSchema>;
export const SessionSchema = z.object({type:z.literal('session'),user:UserSchema,expiresAt:TimestampSchema,bearerToken:z.string().optional()});
export const AuthInputSchema = z.object({type:z.literal('auth.input'),email:z.string().email(),password:z.string().min(12).max(256),name:z.string().max(100).optional()});
export const PreferencesSchema = z.object({type:z.literal('preferences'),vision:z.object({type:z.literal('vision.preferences').default('vision.preferences'),providerId:IdSchema.optional(),modelId:z.string().optional(),enabled:z.boolean().default(true)}),voice:z.object({type:z.literal('voice.preferences').default('voice.preferences'),model:z.string().default('whisper-large-v3-turbo'),language:z.string().optional(),configured:z.boolean().default(false)}),updatedAt:TimestampSchema});
export const PreferencesInputSchema = z.object({type:z.literal('preferences.input'),vision:z.object({providerId:IdSchema.optional(),modelId:z.string().optional(),enabled:z.boolean().optional()}).optional(),voice:z.object({model:z.string().optional(),language:z.string().optional(),apiKey:z.string().optional()}).optional()});
export const BootstrapSchema = z.object({type:z.literal('bootstrap'),protocolVersion:z.number().int(),user:UserSchema,chats:z.array(ChatSchema),providers:z.array(ProviderSchema),models:z.array(ModelSchema),connectors:z.array(ConnectorSchema),skills:z.array(SkillSchema),consents:z.array(ConsentSchema).optional(),registries:z.array(RegistrySchema).optional(),preferences:PreferencesSchema.optional(),activeRuns:z.array(RunSchema),syncCursor:z.string(),syncRoot:z.string(),serverTime:TimestampSchema});
export type Bootstrap = z.infer<typeof BootstrapSchema>;
export const UserEventSchema = z.object({type:z.literal('user.event'),id:z.number().int().positive(),createdAt:TimestampSchema,entity:z.enum(['chat','message','run','provider','model','connector','skill','consent','attachment']),entityId:IdSchema,operation:z.enum(['upsert','delete']),value:JsonValueSchema.optional(),syncCursor:z.string()});
export const PageQuerySchema = z.object({cursor:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).default(50),q:z.string().max(500).optional()});
export function PageSchema<T extends z.ZodType>(item:T){return z.object({type:z.literal('page'),items:z.array(item),nextCursor:z.string().nullable()});}
export const SyncRequestSchema = z.object({type:z.literal('sync.request'),strategy:z.enum(['cursor','merkle']).default('cursor'),cursor:z.string().optional(),root:z.string().optional(),prefixes:z.array(z.string()).optional(),limit:z.number().int().min(1).max(1000).default(500)});
export const SyncEntitySchema = z.object({type:z.literal('sync.entity'),key:z.string(),hash:z.string(),updatedAt:TimestampSchema,deleted:z.boolean(),value:JsonValueSchema.nullable()});
export type SyncEntity = z.infer<typeof SyncEntitySchema>;
export const SyncResponseSchema = z.object({type:z.literal('sync.response'),strategy:z.enum(['cursor','merkle']),root:z.string(),cursor:z.string(),entities:z.array(SyncEntitySchema),nextCursor:z.string().nullable(),nodes:z.array(z.object({type:z.literal('sync.node'),prefix:z.string(),hash:z.string(),count:z.number().int()}))});
export const ErrorSchema = z.object({type:z.literal('error'),code:z.string(),message:z.string(),requestId:z.string().optional(),details:JsonValueSchema.optional()});
export const OkSchema = z.object({type:z.literal('ok')});
export const ENDPOINTS = {
 bootstrap:'/v1/bootstrap',chats:'/v1/chats',runs:'/v1/runs',events:'/v1/events',providers:'/v1/providers',models:'/v1/models',connectors:'/v1/connectors',skills:'/v1/skills',registries:'/v1/skill-registries',uploads:'/v1/uploads',transcribe:'/v1/transcribe',sync:'/v1/sync',
} as const;

// Additive client-review fields, v1. Snapshot is authoritative even after stream retention.
export const RunBlockSchema = z.object({type:z.enum(['text','reasoning']),id:IdSchema,text:z.string(),finished:z.boolean()});
export const RunToolStateSchema = z.object({type:z.literal('tool.state'),activity:ToolActivitySchema,argumentsJson:z.string(),running:z.boolean(),completion:ToolCompletionSchema.optional(),progress:z.array(JsonObjectSchema)});
export const RunSnapshotSchema = z.object({type:z.literal('run.snapshot'),run:RunSchema,lastEventId:z.number().int().nonnegative(),blocks:z.array(RunBlockSchema),tools:z.array(RunToolStateSchema),pendingApprovals:z.array(ApprovalSchema),pendingElicitations:z.array(ElicitationSchema),usage:UsageSchema.optional(),messages:z.array(MessageSchema)});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export const OAuthAuthorizationSchema = z.object({type:z.literal('oauth.authorization'),url:z.string().url(),state:z.string()});
export const UploadUrlSchema = z.object({type:z.literal('upload.url'),uploadUrl:z.string().url(),method:z.enum(['POST','PUT']).optional(),expiresAt:TimestampSchema});
export const UploadReceiptSchema = z.object({type:z.literal('upload.receipt'),storageId:IdSchema});
export const ProviderTestResultSchema = z.object({type:z.literal('provider.test.result'),ok:z.boolean(),models:z.array(ModelSchema),message:z.string().optional()});
export const RegistryEntrySchema = z.object({type:z.literal('skill.registry.entry'),id:IdSchema,name:z.string(),description:z.string(),url:z.string().url().optional()});
export const MCPResourceSchema = z.object({type:z.literal('mcp.resource'),uri:z.string(),name:z.string(),description:z.string().optional(),mimeType:z.string().optional()});
export const MCPPromptSchema = z.object({type:z.literal('mcp.prompt'),name:z.string(),description:z.string().optional(),arguments:z.array(JsonObjectSchema).optional()});
export const MCPResourceResultSchema = z.object({type:z.literal('mcp.resource.result'),contents:z.array(JsonObjectSchema)});
export const MCPPromptResultSchema = z.object({type:z.literal('mcp.prompt.result'),description:z.string().optional(),messages:z.array(JsonObjectSchema)});

export const ChatTruncateSchema = z.object({type:z.literal('chat.truncate'),clientTurnId:IdSchema});
export const ChatTruncateResultSchema = z.object({type:z.literal('chat.truncated'),chat:ChatSchema,removedRunIds:z.array(IdSchema),removedMessageIds:z.array(IdSchema)});
export const AttachmentPatchSchema = z.object({type:z.literal('attachment.patch'),hiddenFromCode:z.boolean()});
export const TranscribeRequestSchema = z.object({type:z.literal('transcribe.request'),audioBase64:z.string().min(1).max(35000000),mediaType:z.string(),fileName:z.string().optional(),model:z.string().optional(),language:z.string().optional(),prompt:z.string().max(10000).optional()});
