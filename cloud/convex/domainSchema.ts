import {defineTable} from 'convex/server';
import {v, type VLiteral} from 'convex/values';
import {
  ApprovalChoiceSchema, MessagePartSchema, ModeSchema, ReasoningShapeSchema, RunErrorCodeSchema, RunOutcomeSchema,
  RunStatusSchema, StreamAnnotationSchema, ToolSourceSchema, ToolSpecSchema,
} from '@praxis/protocol';

function literals<T extends string>(options: readonly T[]) {
  return v.union(...options.map(option => v.literal(option)) as [VLiteral<T>, ...VLiteral<T>[]]);
}

const strings = v.array(v.string());
const optionalString = v.optional(v.string());
const optionalBoolean = v.optional(v.boolean());
const tool = v.object({
  type: v.literal('tool.spec'),
  originalName: optionalString,
  name: v.string(),
  description: v.string(),
  inputSchema: v.string(),
  source: v.object({
    type: literals(ToolSourceSchema.shape.type.options),
    serverId: optionalString,
    serverName: optionalString,
  }),
  traits: v.array(literals(ToolSpecSchema.shape.traits.element.options)),
});
const setup = v.object({
  type: v.literal('conversation.setup'),
  system: v.string(),
  tools: v.array(tool),
  hiddenTools: v.optional(v.array(tool)),
  skillCatalog: v.string(),
  connectorIds: strings,
  createdAt: v.string(),
});
const chat = v.object({
  type: v.literal('chat'),
  id: v.string(),
  webToolsEnabled: optionalBoolean,
  titleRevision: optionalString,
  pinned: v.boolean(),
  title: v.string(),
  mode: literals(ModeSchema.options),
  modelId: optionalString,
  effort: optionalString,
  connectorIds: strings,
  disabledConnectorIds: strings,
  setup: v.optional(setup),
  createdAt: v.string(),
  updatedAt: v.string(),
  deletedAt: optionalString,
  activeRunId: optionalString,
});
const annotation = v.object({
  type: literals(StreamAnnotationSchema.shape.type.options),
  url: optionalString,
  title: optionalString,
  citedText: optionalString,
  startIndex: v.optional(v.number()),
  endIndex: v.optional(v.number()),
  mediaType: optionalString,
  data: optionalString,
  text: optionalString,
});
const part = v.object({
  type: literals(MessagePartSchema.shape.type.options),
  text: optionalString,
  attachmentId: optionalString,
  mediaType: optionalString,
  url: optionalString,
  data: optionalString,
  signature: optionalString,
  callId: optionalString,
  name: optionalString,
  arguments: optionalString,
  content: optionalString,
  isError: optionalBoolean,
  outputRef: optionalString,
  afterToolCallId: optionalString,
  blockId: optionalString,
  shape: v.optional(literals(ReasoningShapeSchema.options)),
  redacted: optionalBoolean,
  startedAt: optionalString,
  finishedAt: optionalString,
  durationMs: v.optional(v.number()),
  annotations: v.optional(v.array(annotation)),
  taintSource: optionalString,
});
const message = v.object({
  type: v.literal('message'),
  id: v.string(),
  chatId: v.string(),
  runId: optionalString,
  clientTurnId: optionalString,
  promptStartedAt: optionalString,
  role: v.union(v.literal('user'), v.literal('assistant')),
  parts: v.array(part),
  raw: v.optional(v.object({type: v.literal('provider.payload'), data: v.string()})),
  createdAt: v.string(),
  updatedAt: v.string(),
  sequence: v.number(),
});
const run = v.object({
  type: v.literal('run'),
  id: v.string(),
  chatId: v.string(),
  status: literals(RunStatusSchema.options),
  outcome: v.optional(literals(RunOutcomeSchema.options)),
  error: optionalString,
  errorCode: v.optional(literals(RunErrorCodeSchema.options)),
  note: optionalString,
  createdAt: v.string(),
  updatedAt: v.string(),
  lastEventId: v.number(),
  clientTurnId: optionalString,
  parentRunId: optionalString,
  promptStartedAt: optionalString,
  taint: v.optional(v.object({tainted: v.literal(true), source: v.string(), callId: v.string()})),
});

const storeFields = {userId: v.string(), id: v.string(), revision: v.number(), updatedAt: v.string()};

export const domainTables = {
  approvals: defineTable({
    ...storeFields,
    runId: v.string(),
    toolCallId: v.string(),
    tool: v.string(),
    argsHash: v.string(),
    preview: v.string(),
    status: v.union(v.literal('pending'), v.literal('approved'), v.literal('denied')),
    decision: v.optional(literals(ApprovalChoiceSchema.options)),
  })
    .index('by_user_id', ['userId', 'id'])
    .index('by_user_run', ['userId', 'runId']),
  chats: defineTable({...storeFields, value: chat, lastSequence: v.number()})
    .index('by_user_id', ['userId', 'id'])
    .index('by_user_updated', ['userId', 'value.updatedAt']),
  messages: defineTable({...storeFields, chatId: v.string(), sequence: v.number(), value: message})
    .index('by_user_id', ['userId', 'id'])
    .index('by_chat_sequence', ['userId', 'chatId', 'sequence']),
  runs: defineTable({
    ...storeFields, chatId: v.string(), value: run,
    workflow: v.optional(v.object({
      startTurnIndex: v.number(),
      nextTurnIndex: v.number(),
      generation: v.number(),
      id: optionalString,
    })),
  })
    .index('by_user_id', ['userId', 'id'])
    .index('by_user_chat', ['userId', 'chatId'])
    .index('by_user_chat_status', ['userId', 'chatId', 'value.status']),
  runStarts: defineTable({
    userId: v.string(),
    chatId: v.string(),
    key: v.string(),
    startTurnIndex: v.number(),
    runId: v.id('runs'),
  }).index('by_user_chat_key', ['userId', 'chatId', 'key']),
  turns: defineTable({
    userId: v.string(),
    runId: v.id('runs'),
    generation: v.number(),
    turnIndex: v.number(),
    done: v.boolean(),
    status: v.union(v.literal('ready'), v.literal('completed'), v.literal('stopped')),
  }).index('by_user_run_turn', ['userId', 'runId', 'generation', 'turnIndex']),
  sandboxes: defineTable({
    userId: v.string(),
    chatId: v.string(),
    sandboxId: v.string(),
    volumeName: v.string(),
    status: v.union(v.literal('starting'), v.literal('running'), v.literal('stopped'), v.literal('failed')),
    lastUsedAt: v.string(),
  }).index('by_user_chat', ['userId', 'chatId']),
  outputs: defineTable({
    ...storeFields, chatId: v.string(), parentId: v.string(), text: v.string(),
  })
    .index('by_user_id', ['userId', 'id'])
    .index('by_user_output', ['userId', 'parentId']),
};
