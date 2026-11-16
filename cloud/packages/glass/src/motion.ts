/** Mirrors --duration-* and --ease-standard in tokens.css; animate transform/opacity only. */
import React from 'react';
import type { Transition } from 'framer-motion';

export const DURATION = { fast: 0.12, base: 0.2, slow: 0.32 } as const;
export const EASE_STANDARD = [0.2, 0, 0, 1] as const;

export const SPRING_VALUE = { stiffness: 520, damping: 38, mass: 1 } as const;
export const SPRING: Transition = { type: 'spring', ...SPRING_VALUE };
export const STAGGER = 0.03;

const tween = (duration: number): Transition => ({ type: 'tween', duration, ease: EASE_STANDARD });

export const TRANSITION = {
  fast: tween(DURATION.fast),
  base: tween(DURATION.base),
  slow: tween(DURATION.slow),
  spring: SPRING,
  none: { duration: 0 } as Transition,
} as const;

export type MotionFrame = {
  opacity?: number;
  scale?: number;
  x?: number;
  y?: number;
};

export interface MotionPreset {
  initial: MotionFrame;
  animate: MotionFrame;
  exit: MotionFrame & { transition?: Transition };
  transition: Transition;
}

/** Scale from element transform-origin + opacity. */
export const popIn: MotionPreset = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98, transition: TRANSITION.fast },
  transition: SPRING,
};

export const sheet: MotionPreset = {
  initial: { opacity: 0, y: 16, scale: 0.99 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 12, scale: 0.99, transition: TRANSITION.fast },
  transition: SPRING,
};

export const fade: MotionPreset = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: TRANSITION.fast },
  transition: TRANSITION.base,
};

export const listItem: MotionPreset = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, transition: TRANSITION.fast },
  transition: TRANSITION.base,
};

export const slideIn: MotionPreset = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 24, transition: TRANSITION.fast },
  transition: SPRING,
};

export const slideUnder: MotionPreset = {
  initial: { opacity: 1, x: 0 },
  animate: { opacity: 0, x: -24 },
  exit: { opacity: 1, x: 0 },
  transition: SPRING,
};

export const press = { whileTap: { scale: 0.97 }, transition: TRANSITION.fast } as const;

const REDUCED: MotionPreset = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: TRANSITION.fast },
  transition: TRANSITION.fast,
};

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

export function usePreset(preset: MotionPreset) {
  const p = resolvePreset(preset, useReducedMotion());
  return { initial: p.initial, animate: p.animate, exit: p.exit, transition: p.transition };
}

export function usePress() {
  return useReducedMotion() ? {} : press;
}
