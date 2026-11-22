import type {ExportSink, SandboxPort} from '../port.js';

export interface SandboxToolContext {
  port: SandboxPort;
  /** Set only for sandboxes created with browserSandboxOptions, which blocks private and metadata networks. */
  browserNetworkRestricted?: boolean;
  /** The chat directory, e.g. `/workspace/chats/<chatId>`; every path argument resolves inside it. */
  root: string;
  exports: ExportSink;
  /** Approved `.praxis/diagnostics.json` hashes; recorded by the runner when the user approves a config (PRA-56). */
  trustedDiagnostics?: ReadonlySet<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
