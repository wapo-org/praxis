import {
  COMPOSIO_LIMITS, COMPOSIO_META_TOOL_NAMES, ComposioMultiExecuteInputSchema, ToolInvocationSchema,
  type ToolInvocation, type ToolCapability, type JsonValue,
} from '@praxis/protocol';
import {strictest, type PolicyDecision} from './shell.js';

export const META_DEPTH_MAX = 8;
export interface MetaToolAdapter {
  recognizes(tool: string): boolean;
  unwrap(call: ToolInvocation): ToolInvocation[];
}
export const composioMetaAdapter: MetaToolAdapter = {
  recognizes: tool => tool === COMPOSIO_META_TOOL_NAMES.multiExecute,
  unwrap(call) {
    return ComposioMultiExecuteInputSchema.parse(call.args).tools.map(t => ({tool: t.tool_slug, args: t.arguments}));
  },
};
export type ToolClassification = {
  capabilities: readonly ToolCapability[];
  decision: PolicyDecision;
  untrustedSource: boolean;
  destructive?: boolean;
  untrustedWrite?: boolean;
};
export interface ToolClassifier {
  classify(call: ToolInvocation): ToolClassification | undefined;
}
const UNKNOWN_TOOL: ToolClassification = {
  capabilities: ['write', 'external-egress', 'exec'], decision: 'approve', untrustedSource: true,
};
const DENIED_TOOL: ToolClassification = {...UNKNOWN_TOOL, decision: 'deny'};

export function classifyInvocation(raw: unknown, registry: ToolClassifier, adapters: readonly MetaToolAdapter[] = [composioMetaAdapter], depth = 0): ToolClassification {
  const parsed = ToolInvocationSchema.safeParse(raw);
  if (!parsed.success || depth >= META_DEPTH_MAX) return DENIED_TOOL;
  const call = parsed.data;
  const adapter = adapters.find(a => a.recognizes(call.tool));
  if (!adapter) return registry.classify(call) ?? UNKNOWN_TOOL;
  try {
    const actions = adapter.unwrap(call);
    if (!actions.length || actions.length > COMPOSIO_LIMITS.BATCH_ACTIONS_MAX) return DENIED_TOOL;
    const inner = actions.map(action => classifyInvocation(action, registry, adapters, depth + 1));
    return {
      capabilities: [...new Set(inner.flatMap(c => c.capabilities))],
      decision: strictest(inner.map(c => c.decision)),
      untrustedSource: inner.some(c => c.untrustedSource),
      ...(inner.some(c => c.destructive) ? {destructive: true} : {}),
      ...(inner.some(c => c.untrustedWrite) ? {untrustedWrite: true} : {}),
    };
  } catch {
    return DENIED_TOOL;
  }
}
export type TaintState = {readonly tainted: boolean};
export type BoundaryResult = {readonly value: JsonValue; readonly untrustedSource: boolean};
export function propagateTaint(state: TaintState, ...sources: readonly TaintState[]): TaintState {
  return {tainted: state.tainted || sources.some(source => source.tainted)};
}
export function resultTaint(state: TaintState, result: BoundaryResult): TaintState {
  return propagateTaint(state, {tainted: result.untrustedSource});
}
export function isSideEffect(capabilities: readonly ToolCapability[]): boolean {
  return capabilities.some(c => c !== 'read');
}
