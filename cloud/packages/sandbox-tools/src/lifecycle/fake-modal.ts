import {FakeSandboxPort} from '../fake.js';
import type {ModalAccount, ModalCredential, SandboxSpec, SandboxWriter} from './ports.js';

interface FakeSandbox {
  id: string;
  spec: SandboxSpec;
  slot: string;
  running: boolean;
  port: FakeSandboxPort;
}

/** In-memory Modal for lifecycle tests; it refuses a second live writer on one Volume, as PRA-52 must never cause. */
export class FakeModal {
  readonly sandboxes: FakeSandbox[] = [];
  readonly terminated: string[] = [];
  /** Delay inside create, so concurrent callers overlap the boot. */
  createDelayMs = 5;
  /** The next create registers a running sandbox and then throws, like a boot that dies halfway. */
  failNextCreate = false;

  get creates(): number {
    return this.sandboxes.length;
  }

  live(volumeName: string): FakeSandbox[] {
    return this.sandboxes.filter(s => s.running && s.spec.volumeName === volumeName);
  }

  lose(sandboxId: string): void {
    const sandbox = this.sandboxes.find(s => s.id === sandboxId);
    if (sandbox) sandbox.running = false;
  }

  account(credential: ModalCredential): ModalAccount {
    const slot = credential.MODAL_TOKEN_ID?.reveal() ?? 'unknown';
    const find = (writer: SandboxWriter) => writer.sandboxId
      ? this.sandboxes.find(s => s.id === writer.sandboxId)
      : this.sandboxes.find(s => s.running && s.spec.name === writer.name);
    return {
      create: async spec => {
        if (this.live(spec.volumeName).length) throw new Error(`Volume ${spec.volumeName} already has a live writer`);
        const sandbox = {id: `sb-${this.sandboxes.length + 1}`, spec, slot, running: true, port: new FakeSandboxPort()};
        this.sandboxes.push(sandbox);
        await new Promise(resolve => setTimeout(resolve, this.createDelayMs));
        if (this.failNextCreate) {
          this.failNextCreate = false;
          throw new Error('container exited during start');
        }
        return sandbox.id;
      },
      running: async sandboxId => this.sandboxes.find(s => s.id === sandboxId)?.running ?? false,
      terminate: async writer => {
        const sandbox = find(writer);
        if (!sandbox?.running) return;
        sandbox.running = false;
        this.terminated.push(sandbox.id);
      },
      attach: async sandboxId => {
        const sandbox = this.sandboxes.find(s => s.id === sandboxId);
        if (!sandbox) throw new Error(`Unknown sandbox ${sandboxId}`);
        return sandbox.port;
      },
    };
  }
}
