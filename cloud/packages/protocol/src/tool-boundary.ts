import {z} from 'zod';

export const ToolCapabilitySchema = z.enum(['read', 'write', 'external-egress', 'exec']);
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;
export const ToolInvocationSchema = z.object({tool: z.string().min(1), args: z.json()}).strict();
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export const ApprovalBindingSchema = z.object({
  runId: z.string().min(1), toolCallId: z.string().min(1), tool: z.string().min(1),
  argsHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const ApprovalPayloadSchema = ApprovalBindingSchema.extend({
  version: z.literal(1), nonce: z.string().min(1), expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const ApprovalReceiptWireSchema = z.object({
  payload: ApprovalPayloadSchema, signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;
export const APPROVAL_RECORD_KIND = 'approval';
export const APPROVAL_PREVIEW_CHARACTERS_MAX = 1500;
export const PendingApprovalRecordSchema = ApprovalBindingSchema.extend({
  id: z.string().min(1), preview: z.string().max(APPROVAL_PREVIEW_CHARACTERS_MAX),
});
export type PendingApprovalRecord = z.infer<typeof PendingApprovalRecordSchema>;
export const ApprovalRecordSchema = z.discriminatedUnion('status', [
  PendingApprovalRecordSchema.extend({status: z.literal('pending')}),
  PendingApprovalRecordSchema.extend({status: z.literal('approved'), decision: z.enum(['allowOnce', 'allowAlways'])}),
  PendingApprovalRecordSchema.extend({status: z.literal('denied'), decision: z.literal('deny')}),
]);
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type ApprovalReceiptWire = z.infer<typeof ApprovalReceiptWireSchema>;
export const ToolErrorCodeSchema = z.enum([
  'schema', 'path-traversal', 'taint-blocked', 'policy-denied', 'approval-required', 'budget', 'upstream-firewall', 'upstream',
  'not-found', 'conflict', 'timeout', 'connection-required',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;
/** Every code carries the same fields, so one object over the code enum is the whole schema; a new code is one enum entry. */
export const ToolErrorSchema = z.object({code: ToolErrorCodeSchema, message: z.string(), remediation: z.string().min(1)});
export type ToolError = z.infer<typeof ToolErrorSchema>;
