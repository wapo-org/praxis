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
 * The menu morph (morph/*), measured from the iOS recording, then 15 % faster and a touch bouncier (WP-G3,
 * the owner's call). Springs carry velocity, so any reversal is continuous. One set of numbers for both classes.
 */
export const MORPH = {
  open: {
    /** Critically damped: the glass lands once and stays (WP-I1). A late overshoot or squaring read as a second
     *  move after the menu had visibly arrived: the "diagonal shift at the end" the owner saw on the tray. */
    shape: { stiffness: 2900, damping: 108 },
    /** The rows: arrive blurred and oversized, and are sharp, inked and in place before the shape reaches 95 %. */
    content: { stiffness: 6000, damping: 155 },
    /** The shape's own clock (circle, then squaring), on the shape's own spring: it is square when it is full size,
     *  so nothing reshapes after it lands. */
    form: { stiffness: 2900, damping: 108 },
    /** The source lifts before the glass starts growing. */
    lift: { stiffness: 3200, damping: 113 },
    /** Seconds from the press before the glass starts to grow. */
    shapeDelay: 0.094,
    contentDelay: 0.094,
    /** No aim past the rest size: any return from past it happens after the menu looks landed. */
    overshoot: 0,
    landAt: 0.82,
    /** The rows ride the glass while they arrive, and are pinned to their rest layout as they land (progress of
     *  `c`), so a glass still finishing its last fraction of a pixel never carries them. */
    pinFrom: 0.55,
  },
  close: {
    shape: { stiffness: 3000, damping: 110 },
    content: { stiffness: 2500, damping: 100 },
    /** Not faster than the shape: it drives the circle, so a quicker one would pop the panel round on the first frames. */
    form: { stiffness: 2500, damping: 100 },
    lift: { stiffness: 6400, damping: 160 },
  },
  /** The open panel gliding to a new size: a submenu, a filtered list, the tray's model list. Critically damped
   *  (WP-I1): it arrives once, with no return from past its new size. */
  resize: { stiffness: 900, damping: 60 },
  /** In-place submenus: the outgoing rows are mostly gone before the incoming ones show, so text never stacks. */
  panelFadeDelay: 0.05,
  /** Under prefers-reduced-motion: a plain short fade, no shape change. */
  fade: { stiffness: 1200, damping: 70 },
  path: {
    anchorBy: 0.35,
    roundIn: 0.14,
    /** It holds a circle until the rows are nearly there (progress of `c`), then squares up quickly. */
    roundOutFrom: 0.72,
    roundOutTo: 0.86,
    /** How far a very wide or tall menu is pulled toward the circle: it cannot be one. */
    wideRound: 0.55,
    wideFrom: 1.5,
    wideTo: 2.6,
    squareFrom: 0.62,
    squareTo: 0.92,
  },
  content: {
    oversize: 0.3,
    sharpFrom: 0.6,
    sharpTo: 0.81,
    blurFrom: 0.14,
    blurTo: 0.5,
    blurOutFrom: 0.7,
    blurOutTo: 0.87,
    /** The real lens, and with it the tint: on the reference's opacity by the time the rows are. */
    tintFrom: 0.62,
    tintTo: 0.87,
    /** The round lens sits under the real one and leaves only once it covers it: no sharp backdrop leaks through. */
    transitOutFrom: 0.85,
    transitOutTo: 1,
    /** Fixed strength of the filter on the arriving copy, in px: never animated. */
    bend: 36,
    blur: 1.4,
    ink: 1.35,
    /** Bending reads as refraction on a reference-sized panel and as scribble on a big one. */
    bendMaxSide: 320,
  },
  /** Below this the source's own glass and the morph hand over to each other. */
  sourceHandover: 0.06,
  /** The lift's wider shadow, in px on screen, while the source is still source-sized. */
  liftShadow: { y: 6, blur: 28, alpha: 0.16 },
  /** The rim's width on screen, in px, at any scale. */
  rimWidth: 1,
  /** The attached class's blob is this share of the button's short side, within these px. */
  blob: { share: 0.6, min: 12, max: 24 },
} as const;

export type SpringValue = { stiffness: number; damping: number };
const spring = (value: SpringValue): Transition => ({ type: 'spring', ...value });
export const SNAP = spring(SPRINGS.snap);
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

/**
 * Leaving: a fixed, short fade that ends. A spring's tail keeps an element on screen (and in the hit test)
 * for hundreds of ms after it looks gone; an exit has nothing to reverse into, so it does not need one.
 */
export const LEAVE: Transition = { type: 'tween', duration: DURATION.fast, ease: EASE_STANDARD };
/** The text inside something leaving goes first, so no glyph outlives its glass. */
export const LEAVE_CONTENT: Transition = { type: 'tween', duration: DURATION.fast * 0.6, ease: EASE_STANDARD };

/** Spotlight: anchored arrival, barely overshoots; row contents never animate. Gone in ~120 ms on close. */
export const searchArrival: MotionPreset = {
  initial: { opacity: 0, scale: 1.025 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.985, transition: LEAVE },
  transition: SNAP,
};
