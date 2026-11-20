import type {SessionCreateParams} from '@composio/client/resources/tool-router/session';
import {COMPOSIO_CONNECTOR_PREFIX, COMPOSIO_FIREWALL_HOOK_ID, composioConnectorId, type Chat,
  type ComposioConnectedAccount} from '@praxis/protocol';
import type {TenantId} from '@praxis/types';

/** The Firewall: Composio's prompt-injection check withholds a poisoned tool response before the agent sees it. */
export const COMPOSIO_FIREWALL_HOOK = {
  type: 'after_execute', id: COMPOSIO_FIREWALL_HOOK_ID, name: 'Praxis Firewall', applies_to: 'all',
  handler: {type: 'prompt_injection_check', action: 'block'},
} as const satisfies NonNullable<SessionCreateParams['hooks']>[number];

/** Locale-independent code-unit order, so session config and connect lists are byte-identical across hosts. */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Chat scope: disabled app connectors drop out; a chat that names Composio connectors allows only those. */
export function chatAccounts(accounts: readonly ComposioConnectedAccount[], chat: Pick<Chat, 'connectorIds' | 'disabledConnectorIds'>): ComposioConnectedAccount[] {
  const named = chat.connectorIds.filter(id => id.startsWith(COMPOSIO_CONNECTOR_PREFIX));
  return accounts.filter(account => {
    const id = composioConnectorId(account.toolkit);
    return !chat.disabledConnectorIds.includes(id) && (!named.length || named.includes(id));
  });
}

/** Pins each toolkit to the user's recorded connected account; instant accounts, workbench and proxy calls stay off. */
export function sessionConfig(tenantId: TenantId, accounts: readonly ComposioConnectedAccount[]): SessionCreateParams {
  if (!accounts.length) throw new Error('A Tool Router session needs at least one connected toolkit');
  const toolkits = [...new Set(accounts.map(account => account.toolkit))].sort(byCodeUnit);
  const pinned = toolkits.map(toolkit => [toolkit, accounts
    .filter(account => account.toolkit === toolkit).map(account => account.connectedAccountId)] as const);
  return {
    user_id: tenantId,
    toolkits: {enable: toolkits},
    connected_accounts: Object.fromEntries(pinned),
    instant: false,
    manage_connections: {enable: false},
    workbench: {enable: false},
    proxy_execute: {enable: false},
    multi_account: {enable: false},
    search: {enable: true},
    execute: {enable_multi_execute: true},
    hooks: [COMPOSIO_FIREWALL_HOOK],
  };
}
