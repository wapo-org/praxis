import type { Chat } from '@praxis/protocol';

export type WireMode = Chat['mode'];
export const MODES = ['auto', 'ask', 'execute'] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_MODE: Mode = 'execute';
export const MODE_LABELS: Record<Mode, string> = { auto: 'Auto', ask: 'Ask', execute: 'Execute' };

export const isMode = (value: unknown): value is Mode => MODES.includes(value as Mode);

export function toWireMode(mode: Mode): WireMode {
  return mode === 'execute' ? 'build' : mode;
}

export function fromWireMode(mode: string | null | undefined): Mode {
  if (mode === 'build' || mode === 'execute') return 'execute';
  if (mode === 'ask') return 'ask';
  if (mode === 'auto' || mode === 'plan') return 'auto';
  return DEFAULT_MODE;
}
