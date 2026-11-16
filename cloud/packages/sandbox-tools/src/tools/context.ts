import type {ExportSink, SandboxPort} from '../port.js';

export interface SandboxToolContext {
  port: SandboxPort;
  /** The chat directory, e.g. `/workspace/chats/<chatId>`; every path argument resolves inside it. */
  root: string;
  exports: ExportSink;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
