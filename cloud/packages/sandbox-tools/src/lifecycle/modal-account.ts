import {ModalClient, NotFoundError, type App, type Sandbox} from 'modal';
import {browserSandboxOptions} from '../modal/browser-network.js';
import {modalSandboxPort} from '../modal/port.js';
import {SANDBOX_APP_NAME} from './constants.js';
import type {ModalAccount, ModalCredential, SandboxWriter} from './ports.js';

export interface ModalAccountOptions {
  appName?: string;
  /** The PRA-51 image as published in this account, `praxis-sandbox:<git sha>`. */
  imageName: string;
}

function token(credential: ModalCredential, name: string): string {
  const value = credential[name];
  if (!value) throw new Error(`Modal credential slot lacks ${name}`);
  return value.reveal();
}

async function unlessMissing(lookup: Promise<Sandbox>): Promise<Sandbox | undefined> {
  try {
    return await lookup;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/** One Modal account behind its own client; the credential is revealed only into the SDK constructor. */
export function modalAccount(credential: ModalCredential, options: ModalAccountOptions): ModalAccount {
  const client = new ModalClient({
    tokenId: token(credential, 'MODAL_TOKEN_ID'),
    tokenSecret: token(credential, 'MODAL_TOKEN_SECRET'),
  });
  const appName = options.appName ?? SANDBOX_APP_NAME;
  let app: Promise<App> | undefined;
  const appFor = () => (app ??= client.apps.fromName(appName, {createIfMissing: true}));
  const writer = (target: SandboxWriter) => target.sandboxId
    ? unlessMissing(client.sandboxes.fromId(target.sandboxId))
    : unlessMissing(client.sandboxes.fromName(appName, target.name));

  return {
    async create(spec) {
      const [owner, image, volume] = await Promise.all([
        appFor(),
        client.images.fromName(options.imageName),
        client.volumes.fromName(spec.volumeName, {createIfMissing: true}),
      ]);
      const sandbox = await client.sandboxes.create(owner, image, {
        name: spec.name,
        volumes: {[spec.mountPath]: volume},
        workdir: spec.mountPath,
        timeoutMs: spec.timeoutMs,
        idleTimeoutMs: spec.idleTimeoutMs,
        cpu: spec.cpu,
        cpuLimit: spec.cpu,
        memoryMiB: spec.memoryMiB,
        memoryLimitMiB: spec.memoryMiB,
        // PRA-19: open internet, private and metadata ranges blocked.
        ...browserSandboxOptions(),
      });
      try {
        const probe = await modalSandboxPort(sandbox).exec({argv: ['test', '-d', spec.mountPath], cwd: '/', timeoutMs: spec.readyTimeoutMs});
        if (probe.exitCode !== 0) throw new Error('Sandbox started without its Volume mounted');
      } catch (error) {
        await sandbox.terminate({wait: true}).catch(() => undefined);
        throw error;
      }
      return sandbox.sandboxId;
    },
    async running(sandboxId) {
      const sandbox = await unlessMissing(client.sandboxes.fromId(sandboxId));
      return sandbox !== undefined && await sandbox.poll() === null;
    },
    async terminate(target) {
      const sandbox = await writer(target);
      if (sandbox) await sandbox.terminate({wait: true});
    },
    async attach(sandboxId) {
      return modalSandboxPort(await client.sandboxes.fromId(sandboxId));
    },
  };
}
