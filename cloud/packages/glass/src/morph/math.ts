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
  /** corner-shape superellipse parameter at rest (1 is a circle). */
  corner: number;
}

export interface Shape extends Box {
  radius: number;
  corner: number;
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

export function shapeAt(p: number, form: number, g: MorphGeometry): Shape {
  const { source: s, final: f } = g;
  const { path } = MORPH;
  const rawW = lerp(s.width, f.width, p);
  const rawH = lerp(s.height, f.height, p);
  const aspect = Math.max(f.width / f.height, f.height / f.width);
  const pull = lerp(1, path.wideRound, smoothstep(path.wideFrom, path.wideTo, aspect));
  const round = pull * smoothstep(0, path.roundIn, p) * (1 - smoothstep(path.roundOutFrom, path.roundOutTo, form));
  const circle = Math.sqrt(Math.max(0, rawW * rawH));
  const width = lerp(rawW, circle, round);
  const height = lerp(rawH, circle, round);

  const fx = anchorFraction(s.left + s.width / 2, f.left, f.width);
  const fy = anchorFraction(s.top + s.height / 2, f.top, f.height);
  const toAnchor = Math.min(p, 1);
  const anchorX = lerp(s.left + s.width / 2, f.left + fx * f.width, toAnchor);
  const anchorY = lerp(s.top + s.height / 2, f.top + fy * f.height, toAnchor);
  // The anchor settles early, so the edge beside the button never swings past where it will rest.
  const anchored = smoothstep(0, path.anchorBy, p);
  const left = anchorX - lerp(0.5, fx, anchored) * width;
  const top = anchorY - lerp(0.5, fy, anchored) * height;

  // Corner radius is part of the motion: near-circle, then squircle, then the rest corner.
  const half = Math.min(width, height) / 2;
  const squared = smoothstep(path.squareFrom, path.squareTo, form);
  const moving = lerp(half, Math.min(g.radius, half), squared);
  const radius = Math.min(half, lerp(Math.min(g.sourceRadius, half), moving, smoothstep(0, path.roundIn, p)));
  return { left, top, width, height, radius, corner: lerp(1, g.corner, squared) };
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

export function stepSpring(state: SpringState, target: number, spring: SpringValue, dt: number) {
  state.v += (spring.stiffness * (target - state.x) - spring.damping * state.v) * dt;
  state.x += state.v * dt;
}

/** Longest integration step: keeps the stiff springs stable on a slow frame. */
export const MAX_SUBSTEP = 1 / 480;
