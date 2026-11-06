/**
 * The glass wakes when held (source: the kube.io magnifier rig): refraction
 * rises 0.8 → 1.0 on an underdamped spring and the shadow grows and shifts on
 * its own two springs. Imperative, so a press never re-renders React. At rest
 * nothing is inline and the CSS finish applies, so a theme change just works.
 */
import { animate, frame, motionValue } from 'framer-motion';
import { lensScale, type GlassMaterial } from './material';
import { SPRINGS } from './motion';

/**
 * The contact shadow, rest → held: it spreads and lifts, it never hardens. Rest geometry and
 * alpha are --glass-contact and --glass-contact-a (tokens.css), which `contact` carries.
 */
export const HELD_SHADOW = { x: 4, y: 12, blur: 30, alpha: 0.04 } as const;

export function shadowAt(geometry: number, alpha: number, contact = { y: 1, blur: 14, alpha: 0.03 }) {
  return {
    x: HELD_SHADOW.x * geometry,
    y: contact.y + HELD_SHADOW.y * geometry,
    blur: contact.blur + HELD_SHADOW.blur * geometry,
    alpha: contact.alpha + HELD_SHADOW.alpha * alpha,
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
  let tokens = { rgb: '0, 0, 0', strength: 1, lift: 'none', contact: { y: 1, blur: 14, alpha: 0.03 }, inner: 1, rim: 0.5, border: 0.5 };
  let holding = false;

  const write = () => {
    const shadow = shadowAt(geometry.get(), alpha.get(), tokens.contact);
    map?.setAttribute('scale', String(rest + (held - rest) * ratio.get()));
    el.style.boxShadow = `${shadow.x}px ${shadow.y}px ${shadow.blur}px rgba(${tokens.rgb}, ${(shadow.alpha * tokens.strength).toFixed(4)}), ${tokens.lift}`;
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
        const rgb = style.getPropertyValue('--glass-shadow-rgb').trim() || '0, 0, 0';
        const strength = num('--glass-shadow', 1);
        const contact = style.getPropertyValue('--glass-contact').trim().split(/\s+/);
        tokens = {
          rgb,
          strength,
          lift: `${style.getPropertyValue('--glass-lift').trim() || '0 0 0'} rgba(${rgb}, ${(num('--glass-lift-a', 0) * strength).toFixed(4)})`,
          contact: {
            y: Number.parseFloat(contact[1] ?? '') || 1,
            blur: Number.parseFloat(contact[2] ?? '') || 14,
            alpha: num('--glass-contact-a', 0.03),
          },
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

