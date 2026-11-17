import type {CooldownStore, CredentialLog, CredentialPool} from '@praxis/credentials';
import type {WebSpendAdmission, WebSpendCall, WebSpendCharge} from '@praxis/protocol';
import type {SealedSecret} from '@praxis/types';
import type {FeatureContext, KV} from '../../contracts.js';

export interface WebAccounting {
  // Admission atomically reserves spend and enforces user/global limits; duplicate claims never dispatch.
  reserve(call: WebSpendCall): Promise<WebSpendAdmission>;
  admitAttempt(call: WebSpendCall): Promise<boolean>;
  settle(charge: WebSpendCharge): Promise<void>;
  // Only for calls that provably never billed; uncertain dispatches stay reserved for reconciliation.
  release(call: WebSpendCall): Promise<void>;
}
export interface WebPorts {
  pools: {exa: CredentialPool<SealedSecret>; firecrawl: CredentialPool<SealedSecret>};
  cooldowns: CooldownStore;
  accounting: WebAccounting;
  fetch: typeof fetch;
  egress: typeof fetch;
  assertPublicUrl(url: string): Promise<URL>;
  cache: Pick<KV, 'get' | 'set'>;
  spill(input: {userId: string; runId: string; callId: string; text: string}): Promise<string>;
  log?: CredentialLog;
}
export type WebPortsFor = (context: FeatureContext) => WebPorts | undefined;
