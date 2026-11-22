import type {ComposioConnectedAccount, ComposioUsageRequest} from '@praxis/protocol';
import type {TenantId} from '@praxis/types';
import type {FeatureContext} from '../../contracts.js';
import type {ToolRouterClient} from './client.js';

export interface ComposioPorts {
  router: ToolRouterClient;
  tenantId(userId: string): Promise<TenantId>;
  /** Connected rows from the Convex `connections` table (PRA-47); pending or failed rows are excluded. */
  connectedAccounts(userId: string): Promise<ComposioConnectedAccount[]>;
  /** Idempotent per run/call; counted before dispatch so a failed count never runs unmetered actions. */
  recordUsage(request: ComposioUsageRequest): Promise<void>;
  spill(input: {userId: string; runId: string; callId: string; text: string}): Promise<string>;
}
export type ComposioPortsFor = (context: FeatureContext) => ComposioPorts | undefined;
