import {classifyInvocation, type ToolClassification, type ToolClassifier} from '@praxis/agent';
import {COMPOSIO_META_TOOL_NAMES, COMPOSIO_TOOL_HINTS, ComposioMultiExecuteInputSchema, type JsonValue} from '@praxis/protocol';
import type {ToolMetadata} from './client.js';

/** Search and schema lookups only read Composio's catalogue; results still taint the run. */
export const COMPOSIO_READ_BOUNDARY: ToolClassification = {capabilities: ['read'], decision: 'allow', untrustedSource: true};
const APP_EFFECT: ToolClassification = {capabilities: ['write', 'external-egress'], decision: 'approve', untrustedSource: true};
/** Static upper bound for the batch tool; each call is reclassified from its inner actions. */
export const COMPOSIO_BATCH_BOUNDARY: ToolClassification = APP_EFFECT;

// A read reaches only the user's own connected account; anything without a trusted read-only hint is an effect.
export function classifyMetadata(metadata: ToolMetadata): ToolClassification {
  const tags = new Set(metadata.tags);
  const writes = tags.has(COMPOSIO_TOOL_HINTS.destructive) || tags.has(COMPOSIO_TOOL_HINTS.create)
    || tags.has(COMPOSIO_TOOL_HINTS.update);
  if (tags.has(COMPOSIO_TOOL_HINTS.readOnly) && !writes) return COMPOSIO_READ_BOUNDARY;
  return tags.has(COMPOSIO_TOOL_HINTS.destructive) ? {...APP_EFFECT, destructive: true} : APP_EFFECT;
}

/** Unknown slugs return undefined, which the PRA-76 boundary treats as approval-required side effects. */
export function metadataRegistry(metadata: ReadonlyMap<string, ToolMetadata | null>): ToolClassifier {
  return {
    classify(call) {
      const found = metadata.get(call.tool);
      return found ? classifyMetadata(found) : undefined;
    },
  };
}

export type BatchAction = {tool_slug: string; arguments: Record<string, JsonValue>; metadata: ToolMetadata | null};
export type BatchPlan =
  | {kind: 'invalid'; classification: ToolClassification}
  | {kind: 'connect'; toolkits: string[]}
  | {kind: 'dispatch'; actions: BatchAction[]; classification: ToolClassification};

/** One plan feeds both the approval decision and dispatch, so execution matches exactly what was checked. */
export async function planBatch(args: JsonValue, allowedToolkits: ReadonlySet<string>,
  metadata: (slug: string) => Promise<ToolMetadata | null>): Promise<BatchPlan> {
  const call = {tool: COMPOSIO_META_TOOL_NAMES.multiExecute, args};
  const parsed = ComposioMultiExecuteInputSchema.safeParse(args);
  if (!parsed.success) return {kind: 'invalid', classification: classifyInvocation(call, metadataRegistry(new Map()))};
  const slugs = [...new Set(parsed.data.tools.map(tool => tool.tool_slug))];
  const found = new Map(await Promise.all(slugs.map(async slug => [slug, await metadata(slug)] as const)));
  const unconnected = [...new Set([...found.values()]
    .flatMap(entry => entry ? [entry.toolkit.slug.toLowerCase()] : [])
    .filter(toolkit => !allowedToolkits.has(toolkit)))].sort();
  if (unconnected.length) return {kind: 'connect', toolkits: unconnected};
  return {
    kind: 'dispatch',
    actions: parsed.data.tools.map(tool => ({...tool, metadata: found.get(tool.tool_slug) ?? null})),
    classification: classifyInvocation(call, metadataRegistry(found)),
  };
}

/** A batch that needs a connection dispatches nothing, so it only reads; otherwise the joined inner decision applies. */
export function planClassification(plan: BatchPlan): ToolClassification {
  return plan.kind === 'connect' ? COMPOSIO_READ_BOUNDARY : plan.classification;
}
