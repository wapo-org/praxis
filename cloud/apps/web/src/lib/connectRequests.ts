import { ComposioConnectRequiredSchema } from '@praxis/protocol';
import type { ActiveToolStep } from '../state/types';

/** Toolkits a run asked the user to connect (PRA-48 `composio.connect-required` tool results), once each. */
export function connectRequestToolkits(steps: readonly ActiveToolStep[]): string[] {
  const toolkits = new Set<string>();
  for (const step of steps) {
    for (const part of step.completion?.content ?? []) {
      const request = ComposioConnectRequiredSchema.safeParse(part);
      if (!request.success) continue;
      for (const { toolkit } of request.data.toolkits) toolkits.add(toolkit);
    }
  }
  return [...toolkits];
}
