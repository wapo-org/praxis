import type {CooldownStore, CredentialLog, CredentialPool} from '@praxis/credentials';
import type {PlatformService} from '@praxis/spend';
import type {SealedSecret} from '@praxis/types';
import type {FeatureContext, KV} from '../../contracts.js';

export interface WebSpendInput {
  userId: string;
  runId: string;
  callId: string;
  service: Extract<PlatformService, 'exa' | 'firecrawl'>;
  estimateMicroUsd: number;
}
export interface WebAccounting {
  // Admission atomically reserves spend and enforces user/global limits; duplicate claims never dispatch.
  reserve(input: WebSpendInput): Promise<'reserved' | 'denied' | 'duplicate'>;
  admitAttempt(input: WebSpendInput): Promise<boolean>;
  settle(input: WebSpendInput & {actualMicroUsd: number; slot: number; payer: 'platform'}): Promise<void>;
  release(input: WebSpendInput): Promise<void>;
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
