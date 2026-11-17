import {z} from 'zod';
import {ToolErrorSchema} from './tool-boundary.js';

export const SUBAGENT_LIMITS = {
  DEPTH_MAX: 8, DEPTH_DEFAULT: 1, TURNS_MAX: 100, TURNS_DEFAULT: 15,
  CHILDREN_MAX: 4, VISIBILITY_DEPTH_MAX: 16, WAIT_TIMEOUT_MS_MAX: 120_000,
  MESSAGE_MAX_CHARACTERS: 32_000, ARTIFACTS_MAX: 100, CHECKS_MAX: 32,
  TOOLS_MAX: 256, NAME_MAX_CHARACTERS: 100, MODEL_MAX_CHARACTERS: 200,
  ARTIFACT_PATH_MAX_CHARACTERS: 500, ID_MAX_CHARACTERS: 80,
  SHA256_HEX_CHARACTERS: 64,
} as const;
export const SUBAGENT_WORKSPACE_ROOT = '/workspace/.agents';
export const SUBAGENT_TOOL_NAMES = ['spawn_agent', 'message_agent', 'wait_agents', 'close_agent'] as const;
export const SubagentIdSchema = z.string().regex(new RegExp(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,${SUBAGENT_LIMITS.ID_MAX_CHARACTERS - 1}}$`));
export const SubagentStatusSchema = z.enum(['spawning', 'running', 'waiting', 'completed', 'failed', 'cancelling', 'cancelled']);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;
const ToolNames = z.array(z.string().min(1)).max(SUBAGENT_LIMITS.TOOLS_MAX).refine(a => new Set(a).size === a.length).meta({uniqueItems: true});
const Configuration = {
  name: z.string().min(1).max(SUBAGENT_LIMITS.NAME_MAX_CHARACTERS).optional(), model: z.string().min(1).max(SUBAGENT_LIMITS.MODEL_MAX_CHARACTERS).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
};
export const SpawnAgentSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('create'), prompt: z.string().min(1).max(SUBAGENT_LIMITS.MESSAGE_MAX_CHARACTERS),
    tools: ToolNames, visibility_depth: z.number().int().min(0).max(SUBAGENT_LIMITS.VISIBILITY_DEPTH_MAX),
    discover_siblings: z.boolean().default(false),
    turn_cap: z.number().int().positive().max(SUBAGENT_LIMITS.TURNS_MAX).default(SUBAGENT_LIMITS.TURNS_DEFAULT),
    ...Configuration}).strict(),
  z.object({action: z.literal('resume'), subagent_id: SubagentIdSchema, ...Configuration}).strict(),
]);
export type SpawnAgent = z.infer<typeof SpawnAgentSchema>;
export const MessageAgentSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('send'), subagent_id: SubagentIdSchema,
    message: z.string().min(1).max(SUBAGENT_LIMITS.MESSAGE_MAX_CHARACTERS)}).strict(),
  z.object({action: z.literal('configure'), subagent_id: SubagentIdSchema, ...Configuration}).strict(),
  z.object({action: z.literal('discover')}).strict(),
]);
export const WaitAgentsSchema = z.object({
  subagent_ids: z.array(SubagentIdSchema).min(1).max(SUBAGENT_LIMITS.CHILDREN_MAX)
    .refine(a => new Set(a).size === a.length).meta({uniqueItems: true}),
  mode: z.enum(['any', 'all']), timeout_ms: z.number().int().min(0).max(SUBAGENT_LIMITS.WAIT_TIMEOUT_MS_MAX),
}).strict();
export type WaitAgents = z.infer<typeof WaitAgentsSchema>;
export const CloseAgentSchema = z.object({subagent_id: SubagentIdSchema}).strict();
export const SubagentToolCallSchema = z.discriminatedUnion('tool', [
  z.object({tool: z.literal('spawn_agent'), args: SpawnAgentSchema}).strict(),
  z.object({tool: z.literal('message_agent'), args: MessageAgentSchema}).strict(),
  z.object({tool: z.literal('wait_agents'), args: WaitAgentsSchema}).strict(),
  z.object({tool: z.literal('close_agent'), args: CloseAgentSchema}).strict(),
]);
export type SubagentToolCall = z.infer<typeof SubagentToolCallSchema>;
export const ArtifactPathSchema = z.string().min(1).max(SUBAGENT_LIMITS.ARTIFACT_PATH_MAX_CHARACTERS).refine(path =>
  !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && !path.includes('%') &&
  path.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'Expected an isolated relative artifact path');
const HashSchema = z.string().regex(new RegExp(`^[a-f0-9]{${SUBAGENT_LIMITS.SHA256_HEX_CHARACTERS}}$`));
export const SubagentCheckSchema = z.object({id: z.string().min(1), status: z.enum(['passed', 'failed', 'skipped'])}).strict();
export const HandoffRecordSchema = z.object({
  subagent_id: SubagentIdSchema, revision: z.number().int().nonnegative(), status: z.literal('completed'),
  artifacts: z.array(z.object({path: ArtifactPathSchema, sha256: HashSchema}).strict()).max(SUBAGENT_LIMITS.ARTIFACTS_MAX)
    .refine(a => new Set(a.map(f => f.path)).size === a.length),
  checks: z.array(SubagentCheckSchema).min(1).max(SUBAGENT_LIMITS.CHECKS_MAX)
    .refine(a => new Set(a.map(c => c.id)).size === a.length),
  diff_summary: z.string().min(1).max(SUBAGENT_LIMITS.MESSAGE_MAX_CHARACTERS),
}).strict();
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;
export const SubagentPermissionsSchema = z.object({
  tools: ToolNames, max_depth: z.number().int().min(0).max(SUBAGENT_LIMITS.DEPTH_MAX),
  visibility_depth: z.number().int().min(0).max(SUBAGENT_LIMITS.VISIBILITY_DEPTH_MAX), discover_siblings: z.boolean(),
  turn_cap: z.number().int().positive().max(SUBAGENT_LIMITS.TURNS_MAX),
  required_checks: z.array(z.string().min(1)).min(1).max(SUBAGENT_LIMITS.CHECKS_MAX),
}).strict();
export type SubagentPermissions = z.infer<typeof SubagentPermissionsSchema>;
export const SubagentMessageSchema = z.object({
  id: SubagentIdSchema, sender_id: SubagentIdSchema, sequence: z.number().int().positive(),
  text: z.string().min(1).max(SUBAGENT_LIMITS.MESSAGE_MAX_CHARACTERS), tainted: z.boolean(),
  disposition: z.enum(['pending', 'delivered', 'discarded']),
}).strict();
const SubagentNodeFields = {
  id: SubagentIdSchema, parent_id: SubagentIdSchema.nullable(), spawn_call_id: z.string().min(1),
  spawn_fingerprint: z.string(), prompt: z.string(), depth: z.number().int().nonnegative(), permissions: SubagentPermissionsSchema,
  name: z.string(), model: z.string(), effort: z.enum(['low', 'medium', 'high']),
  turns: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  tainted: z.boolean(), workspace: z.string(), handles: z.array(z.string().min(1)),
  inbox: z.array(SubagentMessageSchema),
};
const EmptyLifecycle = {handoff: z.null(), error: z.null()};
const StoppedLifecycle = {handoff: z.null(), error: ToolErrorSchema.nullable()};
export const SubagentLifecycleSchema = z.discriminatedUnion('status', [
  z.object({status: z.literal('spawning'), ...EmptyLifecycle}).strict(),
  z.object({status: z.literal('running'), ...EmptyLifecycle}).strict(),
  z.object({status: z.literal('waiting'), ...EmptyLifecycle}).strict(),
  z.object({status: z.literal('completed'), handoff: HandoffRecordSchema, error: z.null()}).strict(),
  z.object({status: z.literal('failed'), handoff: z.null(), error: ToolErrorSchema}).strict(),
  z.object({status: z.literal('cancelling'), ...StoppedLifecycle}).strict(),
  z.object({status: z.literal('cancelled'), ...StoppedLifecycle}).strict(),
]);
export type SubagentLifecycle = z.infer<typeof SubagentLifecycleSchema>;
const [firstLifecycle, ...otherLifecycles] = SubagentLifecycleSchema.options;
export const SubagentNodeSchema = z.discriminatedUnion('status', [
  firstLifecycle.extend(SubagentNodeFields), ...otherLifecycles.map(variant => variant.extend(SubagentNodeFields)),
]);
export type SubagentNode = z.infer<typeof SubagentNodeSchema>;
export const SubagentTreeSchema = z.object({nodes: z.array(SubagentNodeSchema).min(1)}).strict();
export type SubagentTree = z.infer<typeof SubagentTreeSchema>;
const WaitAgentFields = {subagent_id: SubagentIdSchema, tainted: z.boolean()};
export const WaitAgentEntrySchema = z.discriminatedUnion('status', [
  firstLifecycle.extend(WaitAgentFields), ...otherLifecycles.map(variant => variant.extend(WaitAgentFields)),
]);
export const WaitAgentsResultSchema = z.object({
  status: z.enum(['ready', 'waiting', 'timeout']), tainted: z.boolean(), agents: z.array(WaitAgentEntrySchema),
}).strict();
export const DiscoverAgentsResultSchema = z.object({
  tainted: z.boolean(), agents: z.array(z.object({
    id: SubagentIdSchema, parent_id: SubagentIdSchema.nullable(), name: z.string(),
    status: SubagentStatusSchema, tainted: z.boolean(),
  }).strict()),
}).strict();
export type DiscoverAgentsResult = z.infer<typeof DiscoverAgentsResultSchema>;
export type WaitAgentsResult = z.infer<typeof WaitAgentsResultSchema>;

// Spawn, resume and configure acknowledge the same stable address.
export const SubagentAddressResultSchema = z.object({subagent_id: SubagentIdSchema}).strict();
export const SendAgentMessageResultSchema = SubagentAddressResultSchema.extend({message_id: SubagentIdSchema}).strict();
export const CloseAgentResultSchema = SubagentAddressResultSchema.extend({status: SubagentStatusSchema}).strict();
export const SubagentToolResultSchema = z.union([
  SubagentAddressResultSchema, SendAgentMessageResultSchema, CloseAgentResultSchema,
  DiscoverAgentsResultSchema, WaitAgentsResultSchema,
]);
export type SubagentAddressResult = z.infer<typeof SubagentAddressResultSchema>;
export type SendAgentMessageResult = z.infer<typeof SendAgentMessageResultSchema>;
export type CloseAgentResult = z.infer<typeof CloseAgentResultSchema>;
export type SubagentToolResult = z.infer<typeof SubagentToolResultSchema>;
