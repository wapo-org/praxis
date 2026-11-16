import { MORPH } from '../motion';
import type { Box } from './math';

export type SourceKind = 'separate' | 'attached';

export interface MorphSource {
  kind: SourceKind;
  /** The button's own glass, when it has one. */
  surface: HTMLElement | null;
  box: Box;
  radius: number;
}

const CONTROLS = 'button, a[href], input, textarea, select, [role="button"], [contenteditable="true"]';

/** Nothing but a glyph: no visible text. An accessible name is not visible text. */
export function iconOnly(trigger: HTMLElement): boolean {
  return !trigger.textContent?.trim() && !!trigger.querySelector('svg, img');
}

/** Morphs: this is the surface's only control, the button fills most of it, and it is only an icon. */
export function ownGlass(trigger: HTMLElement): HTMLElement | null {
  if (!iconOnly(trigger)) return null;
  const surface = trigger.closest<HTMLElement>('[data-glass-surface]');
  if (!surface || surface === trigger) return null;
  if (surface.querySelectorAll(CONTROLS).length > 1) return null;
  const a = trigger.getBoundingClientRect();
  const b = surface.getBoundingClientRect();
  return a.width * a.height >= 0.5 * b.width * b.height ? surface : null;
}

const toBox = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

export function readSource(trigger: HTMLElement): MorphSource {
  const surface = ownGlass(trigger);
  if (surface) {
    const box = toBox(surface.getBoundingClientRect());
    const radius = Number.parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0;
    return { kind: 'separate', surface, box, radius: Math.min(radius, Math.min(box.width, box.height) / 2) };
  }
  const rect = trigger.getBoundingClientRect();
  const { share, min, max } = MORPH.blob;
  const size = Math.max(min, Math.min(max, Math.min(rect.width, rect.height) * share));
  return {
    kind: 'attached',
    surface: null,
    box: { left: rect.left + rect.width / 2 - size / 2, top: rect.top + rect.height / 2 - size / 2, width: size, height: size },
    radius: size / 2,
  };
}
