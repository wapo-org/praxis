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
export type ApprovalReceiptWire = z.infer<typeof ApprovalReceiptWireSchema>;
export const ToolErrorCodeSchema = z.enum([
  'schema', 'path-traversal', 'taint-blocked', 'policy-denied', 'approval-required', 'budget', 'upstream-firewall', 'upstream',
  'not-found', 'conflict', 'timeout',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;
const errorShape = {message: z.string(), remediation: z.string().min(1)};
export const ToolErrorSchema = z.discriminatedUnion('code', [
  z.object({code: z.literal('schema'), ...errorShape}),
  z.object({code: z.literal('path-traversal'), ...errorShape}),
  z.object({code: z.literal('taint-blocked'), ...errorShape}),
  z.object({code: z.literal('policy-denied'), ...errorShape}),
  z.object({code: z.literal('approval-required'), ...errorShape}),
  z.object({code: z.literal('budget'), ...errorShape}),
  z.object({code: z.literal('upstream-firewall'), ...errorShape}),
  z.object({code: z.literal('upstream'), ...errorShape}),
  z.object({code: z.literal('not-found'), ...errorShape}),
  z.object({code: z.literal('conflict'), ...errorShape}),
  z.object({code: z.literal('timeout'), ...errorShape}),
]);
export type ToolError = z.infer<typeof ToolErrorSchema>;
