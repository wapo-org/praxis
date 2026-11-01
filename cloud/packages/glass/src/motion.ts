/**
 * The one motion module. Every animated component imports from here.
 * CSS mirrors these values as --duration-* / --ease-standard (apps/web/src/styles/tokens.css).
 * Only transform and opacity are ever animated.
 */
import React from 'react';
import type { Transition } from 'framer-motion';

export const DURATION = { fast: 0.12, base: 0.2, slow: 0.32 } as const;
export const EASE_STANDARD = [0.2, 0, 0, 1] as const;

/** The single spring: quick, barely-there overshoot (damping ratio ≈ 0.83). */
export const SPRING_VALUE = { stiffness: 520, damping: 38, mass: 1 } as const;
export const SPRING: Transition = { type: 'spring', ...SPRING_VALUE };
/** Delay between staggered list rows. */
export const STAGGER = 0.03;

const tween = (duration: number): Transition => ({ type: 'tween', duration, ease: EASE_STANDARD });

export const TRANSITION = {
  fast: tween(DURATION.fast),
  base: tween(DURATION.base),
  slow: tween(DURATION.slow),
  spring: SPRING,
  none: { duration: 0 } as Transition,
} as const;

export interface MotionFrame {
  opacity?: number;
  scale?: number;
  x?: number;
  y?: number;
}

export interface MotionPreset {
  initial: MotionFrame;
  animate: MotionFrame;
  exit: MotionFrame & { transition?: Transition };
  transition: Transition;
}

/** Menus and popovers: scale from the anchor origin (set transform-origin on the element) plus opacity. */
export const popIn: MotionPreset = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98, transition: TRANSITION.fast },
  transition: SPRING,
};

/** Sheets and dialogs: rise a little and fade. */
export const sheet: MotionPreset = {
  initial: { opacity: 0, y: 16, scale: 0.99 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 12, scale: 0.99, transition: TRANSITION.fast },
  transition: SPRING,
};

/** Scrim behind sheets. */
export const fade: MotionPreset = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: TRANSITION.fast },
  transition: TRANSITION.base,
};

/** New list rows and messages. */
export const listItem: MotionPreset = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, transition: TRANSITION.fast },
  transition: TRANSITION.base,
};

/** Press feedback for every tappable control. */
export const press = { whileTap: { scale: 0.97 }, transition: TRANSITION.fast } as const;

const REDUCED: MotionPreset = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: TRANSITION.fast },
  transition: TRANSITION.fast,
};

/** Collapse any preset to an opacity-only fade under prefers-reduced-motion. */
export function resolvePreset(preset: MotionPreset, reduced: boolean): MotionPreset {
  return reduced ? REDUCED : preset;
}

const query = '(prefers-reduced-motion: reduce)';
function subscribe(update: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(query);
  media.addEventListener?.('change', update);
  return () => media.removeEventListener?.('change', update);
}
function snapshot() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}

/** Spread onto a motion element: preset props, already reduced-motion aware. */
export function usePreset(preset: MotionPreset) {
  const p = resolvePreset(preset, useReducedMotion());
  return { initial: p.initial, animate: p.animate, exit: p.exit, transition: p.transition };
}

export function usePress() {
  return useReducedMotion() ? {} : press;
}
