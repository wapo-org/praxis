import {randomBytes} from 'node:crypto';
import {ToolBoundaryError, toolError} from '@praxis/agent';
import {CredentialsUnavailableError, credentialFor, healthySlots, placeOwner, type CooldownStore, type CredentialPool} from '@praxis/credentials';
import {SANDBOX_LIFECYCLE, SANDBOX_RESOURCES, type SandboxClaim, type SandboxScope} from '@praxis/protocol';
import type {SandboxPort} from '../port.js';
import {
  SANDBOX_BOOT_RETRY_MS,
  SANDBOX_MESSAGES,
  SANDBOX_READY_TIMEOUT_MS,
  SANDBOX_REFUSAL_MESSAGES,
  SANDBOX_VOLUME_MOUNT,
  SANDBOX_WAIT_MAX_MS,
} from './constants.js';
import type {ModalAccount, SandboxLogEvent, SandboxRows, SandboxSpec} from './ports.js';

const VOLUME_KEY_BYTES = 16;

/** A retryable tool error: the message never names a slot or implies the workspace moved (PRA-99). */
export class SandboxUnavailableError extends ToolBoundaryError {
  constructor(message: string, retryAtMs?: number) {
    super(retryAtMs === undefined ? toolError('unavailable', message) : {...toolError('unavailable', message), retryAtMs});
    this.name = 'SandboxUnavailableError';
  }
}

export interface ResolvedSandbox {
  sandboxId: string;
  port: SandboxPort;
  /** A fresh boot: shell state from earlier turns is gone, files on the Volume are not. */
  booted: boolean;
}

export interface SandboxResolverOptions<C> {
  rows: SandboxRows;
  pool: CredentialPool<C>;
  cooldowns: CooldownStore;
  account: (credential: C) => ModalAccount;
  log?: (event: SandboxLogEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SandboxResolver {
  /** The only way a tool reaches a sandbox: by verified owner and scope, never by an id a model supplied. */
  ensure(userId: string, scope: SandboxScope): Promise<ResolvedSandbox>;
}

type Placement = {slot: number; volumeName: string};
type Boot = Extract<SandboxClaim, {kind: 'boot'}>;
type Ready = Extract<SandboxClaim, {kind: 'ready'}>;
type Refused = Extract<SandboxClaim, {kind: 'unavailable'}>;

export const sandboxName = (volumeName: string, generation: number) => `${volumeName}-${generation}`;

/** `lifetimeMs` is what the claim reserved, so Modal's hard timeout is the spend ceiling (PRA-170). */
export function sandboxSpec(volumeName: string, generation: number, lifetimeMs: number): SandboxSpec {
  return {
    name: sandboxName(volumeName, generation),
    volumeName,
    mountPath: SANDBOX_VOLUME_MOUNT,
    timeoutMs: lifetimeMs,
    idleTimeoutMs: SANDBOX_RESOURCES.IDLE_TIMEOUT_MS,
    cpu: SANDBOX_RESOURCES.CPU_CORES,
    memoryMiB: SANDBOX_RESOURCES.MEMORY_MIB,
    readyTimeoutMs: SANDBOX_READY_TIMEOUT_MS,
  };
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function sandboxResolver<C>(options: SandboxResolverOptions<C>): SandboxResolver {
  const {rows, pool, cooldowns} = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => undefined);
  const accounts = new Map<number, ModalAccount>();

  const unavailable = (scope: SandboxScope, slot: number | null, error: CredentialsUnavailableError) => {
    const retryAtMs = error.retryAt?.getTime() ?? null;
    log({event: 'sandbox.unavailable', scope, slot, detail: error.detail, retryAtMs});
    return new SandboxUnavailableError(SANDBOX_MESSAGES.unavailable, retryAtMs ?? undefined);
  };

  /** A free-tier limit: the user sees why and when to retry; nothing was reserved or locked. */
  const refused = (scope: SandboxScope, claim: Refused) => {
    log({event: 'sandbox.unavailable', scope, slot: null, detail: claim.reason, retryAtMs: claim.retryAtMs});
    return new SandboxUnavailableError(SANDBOX_REFUSAL_MESSAGES[claim.reason], claim.retryAtMs);
  };

  /** Every call re-reads the stored slot's health and never picks another slot for a placed owner. */
  const accountFor = async (slot: number): Promise<ModalAccount> => {
    const credential = await credentialFor(pool, slot, cooldowns, now);
    let account = accounts.get(slot);
    if (!account) {
      account = options.account(credential);
      accounts.set(slot, account);
    }
    return account;
  };

  const place = async (userId: string, scope: SandboxScope, inherited: number | undefined): Promise<Placement> => {
    const volumeName = `praxis-${scope}-${randomBytes(VOLUME_KEY_BYTES).toString('hex')}`;
    if (inherited !== undefined) return {slot: inherited, volumeName};
    try {
      return {slot: placeOwner(pool, userId, await healthySlots(pool, cooldowns, now)), volumeName};
    } catch (error) {
      if (error instanceof CredentialsUnavailableError) throw unavailable(scope, null, error);
      throw error;
    }
  };

  const reuse = async (userId: string, scope: SandboxScope, claim: Ready): Promise<ResolvedSandbox | undefined> => {
    const account = await accountFor(claim.slot);
    const event = {scope, slot: claim.slot, generation: claim.generation, sandboxId: claim.sandboxId};
    if (await account.running(claim.sandboxId)) {
      log({event: 'sandbox.reuse', ...event});
      return {sandboxId: claim.sandboxId, port: await account.attach(claim.sandboxId), booted: false};
    }
    log({event: 'sandbox.gone', ...event});
    await rows.release(userId, {scope, generation: claim.generation});
    return undefined;
  };

  /** Holds the boot lock for `claim.generation`; every exit either commits or releases it. */
  const boot = async (userId: string, scope: SandboxScope, claim: Boot): Promise<ResolvedSandbox | undefined> => {
    const started = now();
    const spec = sandboxSpec(claim.volumeName, claim.generation, claim.lifetimeMs);
    let account: ModalAccount | undefined;
    let created: string | undefined;
    try {
      account = await accountFor(claim.slot);
      if (claim.previous) {
        await account.terminate({name: sandboxName(claim.volumeName, claim.previous.generation), sandboxId: claim.previous.sandboxId});
      }
      created = await account.create(spec);
      // Past the lease another caller may already own the Volume, so this sandbox must not be published.
      const committed = now() - started < SANDBOX_LIFECYCLE.BOOT_LEASE_MS && await rows.commit(userId, {
        scope, generation: claim.generation, sandboxId: created, expiresAtMs: started + spec.timeoutMs,
      });
      const event = {scope, slot: claim.slot, generation: claim.generation, sandboxId: created};
      if (!committed) {
        await account.terminate({name: spec.name, sandboxId: created});
        log({event: 'sandbox.fenced', ...event});
        return undefined;
      }
      log({event: 'sandbox.boot', ...event});
      return {sandboxId: created, port: await account.attach(created), booted: true};
    } catch (error) {
      if (account && created) await account.terminate({name: spec.name, sandboxId: created}).catch(() => undefined);
      // If the release itself fails, the boot lease expiring frees the lock instead.
      await rows.release(userId, {scope, generation: claim.generation}).catch(() => false);
      if (error instanceof CredentialsUnavailableError) throw unavailable(scope, claim.slot, error);
      log({event: 'sandbox.boot_failed', scope, slot: claim.slot, generation: claim.generation, error: errorName(error)});
      throw new SandboxUnavailableError(SANDBOX_MESSAGES.bootFailed, now() + SANDBOX_BOOT_RETRY_MS);
    }
  };

  const reuseOrUnavailable = async (userId: string, scope: SandboxScope, claim: Ready) => {
    try {
      return await reuse(userId, scope, claim);
    } catch (error) {
      if (error instanceof CredentialsUnavailableError) throw unavailable(scope, claim.slot, error);
      throw error;
    }
  };

  return {
    async ensure(userId, scope) {
      const deadline = now() + SANDBOX_WAIT_MAX_MS;
      let placement: Placement | undefined;
      for (;;) {
        const claim = await rows.claim(userId, placement ? {scope, placement} : {scope});
        let resolved: ResolvedSandbox | undefined;
        switch (claim.kind) {
          case 'unplaced':
            placement = await place(userId, scope, claim.slot);
            continue;
          case 'unavailable':
            throw refused(scope, claim);
          case 'wait':
            if (now() + claim.retryAfterMs > deadline) {
              throw new SandboxUnavailableError(SANDBOX_MESSAGES.starting, now() + SANDBOX_BOOT_RETRY_MS);
            }
            await sleep(claim.retryAfterMs);
            continue;
          case 'ready':
            resolved = await reuseOrUnavailable(userId, scope, claim);
            break;
          case 'boot':
            resolved = await boot(userId, scope, claim);
            break;
        }
        if (resolved) return resolved;
        if (now() > deadline) throw new SandboxUnavailableError(SANDBOX_MESSAGES.starting, now() + SANDBOX_BOOT_RETRY_MS);
      }
    },
  };
}

/** Modal error text may echo request details, so only the class name is logged. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
