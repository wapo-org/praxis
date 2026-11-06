/**
 * The one motion module. Every animated component imports from here.
 * Spatial motion is springs through framer-motion, never CSS curves: only they
 * carry velocity when interrupted. CSS --duration-* / --ease-standard
 * (apps/web/src/styles/tokens.css) are for colour fades and ambient loops only.
 * Only transform and opacity animate, plus the lens scale for the held rig.
 */
import React from 'react';
import type { Transition } from 'framer-motion';

export const DURATION = { fast: 0.12, base: 0.2, slow: 0.32 } as const;
export const EASE_STANDARD = [0.2, 0, 0, 1] as const;

/** The default spring: quick, barely-there overshoot (damping ratio ≈ 0.83). */
export const SPRING_VALUE = { stiffness: 520, damping: 38, mass: 1 } as const;
export const SPRING: Transition = { type: 'spring', ...SPRING_VALUE };
/** Delay between staggered list rows. */
export const STAGGER = 0.03;

/**
 * One family of springs, tuned by feel. Framer carries the live velocity into a
 * retargeted spring, so every one of these is interruptible and reverses from
 * where it is. Nothing in the app plays a canned curve for spatial motion.
 */
export const SPRINGS = {
  /** Press feedback, switch knob, segmented thumb, chevrons: small, fast things. */
  snap: { stiffness: 760, damping: 46, mass: 1 },
  /** The highlight gliding between rows. */
  glide: { stiffness: 460, damping: 36, mass: 1 },
  /** Large things: the sidebar, panel content, pages. */
  panel: { stiffness: 340, damping: 32, mass: 1 },
  /** The material lags the pointer by its own mass (source: PULL_FOLLOW). */
  follow: { stiffness: 340, damping: 30 },
  /** The glass wakes when held: refraction overshoots (source: scaleRatio spring). */
  lens: { stiffness: 250, damping: 14 },
  /** Held shadow geometry and alphas (source: magnifier shadow springs). */
  shadow: { stiffness: 340, damping: 30 },
  shadowAlpha: { stiffness: 220, damping: 24 },
} as const;

/**
 * The menu morph (morph/*): fast, then soft. Measured from the iOS recording: the
 * shape does nearly all its growth in about 150 ms after an 80-100 ms lift, then a
 * long quiet settle with no bounce. Springs carry velocity, so any reversal is
 * continuous. Both button classes use these same numbers.
 */
export const MORPH = {
  open: {
    /** Critically damped, so never a bounce; the settle below is its own slow term. */
    shape: { stiffness: 1600, damping: 80 },
    /** Much slower than the shape: rows are still oversized when the glass has landed. */
    content: { stiffness: 289, damping: 34 },
    /** The source lifts before the glass starts growing. */
    lift: { stiffness: 2600, damping: 102 },
    /** Seconds from the press before the glass starts to grow. */
    shapeDelay: 0.11,
    contentDelay: 0.11,
  },
  close: {
    shape: { stiffness: 2500, damping: 100 },
    content: { stiffness: 3600, damping: 120 },
    lift: { stiffness: 1600, damping: 80 },
  },
  /** Under prefers-reduced-motion: a plain short fade, no shape change. */
  fade: { stiffness: 1200, damping: 70 },
  path: {
    anchorBy: 0.35,
    roundIn: 0.14,
    roundOutFrom: 0.6,
    roundOutTo: 1,
    squareFrom: 0.58,
    squareTo: 0.9,
    settleFrom: 0.8,
    settleWidth: 0.025,
    settleHeight: 0.025,
    /** Seconds: how slowly the last few percent bleed off. */
    settleTau: 0.09,
    /** Progress past which the settle starts bleeding off. */
    settleStart: 0.9,
    /** The panel carries on past its rest place, away from the button, by this share of its height. */
    carry: 0.11,
    carryInFrom: 0.1,
    carryInTo: 0.7,
    carryOutFrom: 0.7,
    carryOutTo: 0.9,
  },
  content: {
    oversize: 0.55,
    sharpFrom: 0.62,
    sharpTo: 0.88,
    blurFrom: 0.12,
    blurTo: 0.46,
    blurOutFrom: 0.74,
    blurOutTo: 0.93,
    tintFrom: 0.62,
    tintTo: 0.9,
    /** Fixed strength of the filter on the arriving copy, in px: never animated. */
    bend: 90,
    blur: 1.6,
  },
  /** The lift's wider shadow, in px on screen, while the source is still source-sized. */
  liftShadow: { y: 6, blur: 28, alpha: 0.16 },
  /** Below this the source's own glass and the morph hand over to each other. */
  sourceHandover: 0.06,
  /** The attached class's blob is this share of the button's short side, within these px. */
  blob: { share: 0.6, min: 12, max: 24 },
} as const;

export type SpringValue = { stiffness: number; damping: number };
const spring = (value: SpringValue): Transition => ({ type: 'spring', ...value });
export const SNAP = spring(SPRINGS.snap);
export const GLIDE = spring(SPRINGS.glide);
export const PANEL = spring(SPRINGS.panel);

/** Near-critically damped: fades and small moves that should not overshoot. */
export const TRANSITION = {
  fast: spring({ stiffness: 760, damping: 56 }),
  base: spring({ stiffness: 520, damping: 46 }),
  slow: spring({ stiffness: 300, damping: 35 }),
  spring: SPRING,
  none: { duration: 0 } as Transition,
} as const;

export type MotionFrame = {
  opacity?: number;
  scale?: number;
  x?: number | string;
  y?: number | string;
};

export interface MotionPreset {
  initial: MotionFrame;
  animate: MotionFrame;
  exit: MotionFrame & { transition?: Transition };
  transition: Transition;
}

/** Menus and popovers: grow from the anchor origin (set transform-origin on the element) plus opacity. */
export const popIn: MotionPreset = {
  initial: { opacity: 0, scale: 0.88 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.92, transition: TRANSITION.base },
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
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, transition: TRANSITION.fast },
  transition: SPRING,
};

/**
 * The floating sidebar, all the way off the leading edge and back. Never a fade:
 * opacity on an ancestor would blank the lens for the whole trip.
 */
export const sidebarSlide: MotionPreset = {
  initial: { x: '-110%' },
  animate: { x: 0 },
  exit: { x: '-110%', transition: PANEL },
  transition: PANEL,
};

/** Page changes in the main area: a small settle, nothing that competes with the glass. */
export const pageChange: MotionPreset = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4, transition: TRANSITION.fast },
  transition: PANEL,
};

/** Push navigation inside a tray or settings stack: the next page slides in from the trailing edge. */
export const slideIn: MotionPreset = {
  initial: { opacity: 0, x: 24 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 24, transition: TRANSITION.fast },
  transition: SPRING,
};

/** The page underneath a push: it recedes a little towards the leading edge. */
export const slideUnder: MotionPreset = {
  initial: { opacity: 1, x: 0 },
  animate: { opacity: 0, x: -24 },
  exit: { opacity: 1, x: 0 },
  transition: SPRING,
};

/** Press feedback for every tappable control. */
export const press = { whileTap: { scale: 0.97 }, transition: SNAP } as const;

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
