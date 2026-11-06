/**
 * The menu morph as pure math: one shape path over a shape progress `p` and a
 * content progress `c`, measured from the iOS reference (DESIGN.md, Menu morph).
 * No DOM here, so every frame of the path can be asserted in a test.
 */
import { MORPH, type SpringValue } from '../motion';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MorphGeometry {
  /** Where the glass starts and returns to: the button's glass, or a small blob on the button. */
  source: Box;
  sourceRadius: number;
  /** The menu's rest box, in the same coordinates. */
  final: Box;
  radius: number;
}

export interface Shape extends Box {
  radius: number;
}

export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(low: number, high: number, value: number) {
  const t = clamp((value - low) / (high - low));
  return t * t * (3 - 2 * t);
}

/** Where the source's centre sits inside the final box: the point that stays near the button. */
function anchorFraction(sourceCenter: number, start: number, size: number) {
  return size > 0 ? clamp((sourceCenter - start) / size) : 0.5;
}

/**
 * The glass at progress `p`. It leaves the source's shape for a near-circle, grows
 * away from the button (which mirrors by itself for a menu opening up or left),
 * and squares up late. `settle` is the slow last 2-4 % the panel loses as it rests.
 */
export function shapeAt(p: number, c: number, settle: number, g: MorphGeometry): Shape {
  const { source: s, final: f } = g;
  const rawW = lerp(s.width, f.width, p);
  const rawH = lerp(s.height, f.height, p);
  const round = smoothstep(0, MORPH.path.roundIn, p) * (1 - smoothstep(MORPH.path.roundOutFrom, MORPH.path.roundOutTo, p));
  const circle = Math.sqrt(Math.max(0, rawW * rawH));
  const rest = settle * smoothstep(MORPH.path.settleFrom, 1, p);
  const width = lerp(rawW, circle, round) * (1 + MORPH.path.settleWidth * rest);
  const height = lerp(rawH, circle, round) * (1 + MORPH.path.settleHeight * rest);

  const fx = anchorFraction(s.left + s.width / 2, f.left, f.width);
  const fy = anchorFraction(s.top + s.height / 2, f.top, f.height);
  const anchorX = lerp(s.left + s.width / 2, f.left + fx * f.width, p);
  const anchorY = lerp(s.top + s.height / 2, f.top + fy * f.height, p);
  // The anchor settles early, so the edge beside the button never swings past where it will rest.
  const anchored = smoothstep(0, MORPH.path.anchorBy, p);
  const left = anchorX - lerp(0.5, fx, anchored) * width;
  // It carries on a little past its place, away from the button, then comes back as the rows land.
  const carry = MORPH.path.carry * f.height * smoothstep(MORPH.path.carryInFrom, MORPH.path.carryInTo, p) * (1 - smoothstep(MORPH.path.carryOutFrom, MORPH.path.carryOutTo, c));
  const direction = Math.sign(f.top + f.height / 2 - (s.top + s.height / 2));
  const top = anchorY - lerp(0.5, fy, anchored) * height + direction * carry;

  // Corner radius is part of the motion: near-circle, then squircle, then the rest radius.
  const half = Math.min(width, height) / 2;
  const circular = 1 - smoothstep(MORPH.path.squareFrom, MORPH.path.squareTo, c);
  const moving = lerp(g.radius, half, circular);
  const radius = Math.min(half, lerp(Math.min(g.sourceRadius, half), moving, smoothstep(0, MORPH.path.roundIn, p)));
  return { left, top, width, height, radius };
}

export interface ContentPose {
  /** Scale of the content, about the glass's centre: oversized, contracting into place. */
  scale: number;
  /** The sharp, live rows. */
  sharp: number;
  /** The static blurred copy: arrives first, then hands over to the sharp rows. */
  blurred: number;
  /** The real lens with its full tint: the glass gains it as it lands. */
  tint: number;
}

export function contentAt(c: number): ContentPose {
  const { content } = MORPH;
  return {
    scale: 1 + content.oversize * (1 - clamp(c)),
    sharp: smoothstep(content.sharpFrom, content.sharpTo, c),
    blurred: smoothstep(content.blurFrom, content.blurTo, c) * (1 - smoothstep(content.blurOutFrom, content.blurOutTo, c)),
    tint: smoothstep(content.tintFrom, content.tintTo, c),
  };
}

export interface SpringState {
  x: number;
  v: number;
}

/**
 * One semi-implicit Euler step of a spring toward `target`. Position and velocity
 * are the whole state, so a retarget reverses from exactly where it is.
 */
export function stepSpring(state: SpringState, target: number, spring: SpringValue, dt: number) {
  state.v += (spring.stiffness * (target - state.x) - spring.damping * state.v) * dt;
  state.x += state.v * dt;
}

/** Longest integration step: keeps the stiff springs stable on a slow frame. */
export const MAX_SUBSTEP = 1 / 480;
