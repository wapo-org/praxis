import type { Chat } from '@praxis/protocol';

/**
 * The composer's modes (WP-I1): Auto, Ask and Execute. The wire keeps the protocol's enum, which still has
 * `plan` and `build` so older clients and stored chats stay valid:
 *   auto    <-> auto
 *   ask     <-> ask
 *   execute  -> build   (Execute is what Build was)
 *   build    -> execute
 *   plan     -> auto    (Plan left the UI; a chat or default stored as plan reads as Auto)
 */
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
