import { AsyncLocalStorage } from 'node:async_hooks';

export interface TimingSpan {
  startMs: number;
  endMs: number;
  durationMs: number;
  calls?: number;
}

export interface RunStartTiming {
  runId: string;
  chatId: string;
  startedAt: string;
  postResponseMs?: number;
  queueWaitMs?: number;
  runStartedMs?: number;
  providerRequestMs?: number;
  steps: Record<string, TimingSpan>;
}

export class RunTimingTracker {
  readonly t0 = performance.now();
  readonly startedAt = new Date().toISOString();
  readonly steps: Record<string, TimingSpan> = {};
  private readonly memos = new Map<string, Promise<unknown>>();
  postResponseMs?: number;
  queueWaitMs?: number;
  runStartedMs?: number;
  providerRequestMs?: number;

  constructor(
    public runId: string,
    public readonly chatId: string,
    private readonly deferFn?: (work: Promise<unknown>) => void,
  ) {}

  mark(field: 'postResponseMs' | 'queueWaitMs' | 'runStartedMs' | 'providerRequestMs', value?: number) {
    if (this[field] !== undefined) return;
    this[field] = round2(value ?? performance.now() - this.t0);
  }

  recordSpan(name: string, startAbs: number, endAbs: number) {
    const startMs = round2(startAbs - this.t0);
    const endMs = round2(endAbs - this.t0);
    const durationMs = round2(Math.max(0, endAbs - startAbs));
    const prev = this.steps[name];
    if (!prev) {
      this.steps[name] = { startMs, endMs, durationMs, calls: 1 };
    } else {
      this.steps[name] = {
        startMs: Math.min(prev.startMs, startMs),
        endMs: Math.max(prev.endMs, endMs),
        durationMs: round2(prev.durationMs + durationMs),
        calls: (prev.calls ?? 1) + 1,
      };
    }
  }

  async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const s = performance.now();
    try {
      return await fn();
    } finally {
      this.recordSpan(name, s, performance.now());
    }
  }

  memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const cached = this.memos.get(key) as Promise<T> | undefined;
    if (cached) return cached;
    const promise = fn().catch((err) => {
      this.memos.delete(key);
      throw err;
    });
    this.memos.set(key, promise);
    return promise;
  }

  defer(work: Promise<unknown>) {
    if (this.deferFn) {
      this.deferFn(work);
    } else {
      void work.catch(() => {});
    }
  }

  snapshot(): RunStartTiming {
    return {
      runId: this.runId,
      chatId: this.chatId,
      startedAt: this.startedAt,
      ...(this.postResponseMs !== undefined ? { postResponseMs: this.postResponseMs } : {}),
      ...(this.queueWaitMs !== undefined ? { queueWaitMs: this.queueWaitMs } : {}),
      ...(this.runStartedMs !== undefined ? { runStartedMs: this.runStartedMs } : {}),
      ...(this.providerRequestMs !== undefined ? { providerRequestMs: this.providerRequestMs } : {}),
      steps: { ...this.steps },
    };
  }
}

const storage = new AsyncLocalStorage<RunTimingTracker>();
const recentTimings = new Map<string, RunTimingTracker>();

export function registerRunTiming(tracker: RunTimingTracker) {
  recentTimings.delete(tracker.runId);
  recentTimings.set(tracker.runId, tracker);
  if (recentTimings.size > 200) {
    const oldest = recentTimings.keys().next().value;
    if (oldest) recentTimings.delete(oldest);
  }
}

export function getRunTiming(runId: string): RunStartTiming | undefined {
  return recentTimings.get(runId)?.snapshot();
}

export function currentRunTiming(): RunTimingTracker | undefined {
  return storage.getStore();
}

export function withRunTiming<T>(tracker: RunTimingTracker | undefined, fn: () => T): T {
  return tracker ? storage.run(tracker, fn) : fn();
}

export async function timedStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const tracker = storage.getStore();
  return tracker ? tracker.span(name, fn) : fn();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
