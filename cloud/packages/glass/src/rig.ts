/**
 * The glass wakes when held (source: the kube.io magnifier rig): refraction
 * rises 0.8 → 1.0 on an underdamped spring and the shadow grows and shifts on
 * its own two springs. Imperative, so a press never re-renders React. At rest
 * nothing is inline and the CSS finish applies, so a theme change just works.
 */
import { animate, frame, motionValue } from 'framer-motion';
import { lensScale, type GlassMaterial } from './material';
import { SPRINGS } from './motion';

/** Rest (0, 4, 9, .16, .20) → held (4, 16, 24, .22, .27). Keep in sync with glass.module.css. */
export function shadowAt(geometry: number, alpha: number) {
  return {
    x: 4 * geometry,
    y: 4 + 12 * geometry,
    blur: 9 + 15 * geometry,
    alpha: 0.16 + 0.06 * alpha,
    inset: 0.2 + 0.07 * alpha,
  };
}

export function createRig(el: HTMLElement, material: GlassMaterial) {
  const ratio = motionValue(0);
  const geometry = motionValue(0);
  const alpha = motionValue(0);
  const rest = lensScale(material, false);
  const held = lensScale(material, true);
  let lens: HTMLElement | null = null;
  let map: Element | null = null;
  let tokens = { rgb: '0, 0, 0', strength: 1, ambient: 'none', inner: 1, rim: 0.5, border: 0.5 };
  let holding = false;

  const write = () => {
    const shadow = shadowAt(geometry.get(), alpha.get());
    map?.setAttribute('scale', String(rest + (held - rest) * ratio.get()));
    el.style.boxShadow = `${shadow.x}px ${shadow.y}px ${shadow.blur}px rgba(${tokens.rgb}, ${(shadow.alpha * tokens.strength).toFixed(4)}), ${tokens.ambient}`;
    if (lens) {
      const inset = (shadow.inset * tokens.inner).toFixed(4);
      lens.style.boxShadow = [
        `inset ${shadow.x / 2}px ${shadow.y / 2}px 24px rgba(0,0,0,${inset})`,
        `inset ${-shadow.x / 2}px ${-shadow.y / 2}px 24px rgba(255,255,255,${inset})`,
        `inset 0 1px 0 0 rgba(255,255,255,${(0.5 * tokens.rim).toFixed(3)})`,
        `inset 0 -1px 0 0 rgba(255,255,255,${(0.22 * tokens.rim).toFixed(3)})`,
        `inset 0 0 0 1px rgba(255,255,255,${(0.16 * tokens.border).toFixed(3)})`,
        `inset 0 0 0 1px rgba(15,15,20,${(0.07 * tokens.border).toFixed(3)})`,
      ].join(', ');
    }
  };
  const schedule = () => frame.render(write);
  const unsubscribers = [ratio, geometry, alpha].map((value) => value.on('change', schedule));

  const clearIfRested = () => {
    if (holding || geometry.isAnimating() || alpha.isAnimating() || ratio.isAnimating()) return;
    el.style.boxShadow = '';
    if (lens) lens.style.boxShadow = '';
    map?.setAttribute('scale', String(rest));
  };

  return {
    hold(next: boolean) {
      if (next === holding) return;
      holding = next;
      if (next) {
        const style = getComputedStyle(el);
        const num = (name: string, fallback: number) => Number.parseFloat(style.getPropertyValue(name)) || fallback;
        tokens = {
          rgb: style.getPropertyValue('--glass-shadow-rgb').trim() || '0, 0, 0',
          strength: num('--glass-shadow', 1),
          ambient: style.getPropertyValue('--glass-ambient').trim() || '0 0 0 transparent',
          inner: num('--glass-inner', 1),
          rim: num('--glass-rim', 0.5),
          border: num('--glass-border', 0.5),
        };
        lens = el.querySelector<HTMLElement>(':scope > [data-glass-lens]');
        map = el.querySelector(':scope > svg feDisplacementMap');
      }
      const target = next ? 1 : 0;
      const run = (value: typeof ratio, spring: (typeof SPRINGS)[keyof typeof SPRINGS]) =>
        animate(value, target, { type: 'spring', ...spring, velocity: value.getVelocity(), onComplete: clearIfRested });
      run(ratio, SPRINGS.lens);
      run(geometry, SPRINGS.shadow);
      run(alpha, SPRINGS.shadowAlpha);
    },
    destroy() {
      unsubscribers.forEach((off) => off());
      ratio.stop();
      geometry.stop();
      alpha.stop();
    },
  };
}

