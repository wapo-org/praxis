import type {APIRequestContext, Page} from '@playwright/test';
import type {AllowedIssue} from './judge.js';

export interface FlowContext {
  page: Page;
  /** API origin for direct requests, bypassing the web proxy. */
  api: string;
  request: APIRequestContext;
  convexUrl: string;
  /** Seed for flows that make random choices; the same seed replays the same actions. */
  seed: number;
  note(line: string): void;
}

export interface WebFlow {
  /** Stable id used by `--flows` and `cloud/verify/feature-map.json`. */
  id: string;
  title: string;
  /** Off-by-default flows (fuzzing) run only when named in `--flows`. */
  default: boolean;
  session?: 'shared' | 'isolated';
  allow: readonly AllowedIssue[];
  run(context: FlowContext): Promise<void>;
}
