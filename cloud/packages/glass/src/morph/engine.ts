/**
 * Drives one menu's morph. Imperative and transform-first, so a frame never re-renders
 * React and never touches layout:
 *  - The glass keeps its rest size in layout. The shell's transform takes it from the
 *    source's box to the menu's, with the corner radius written against that scale.
 *  - The content layer is counter-scaled, so it arrives on its own terms.
 *  - The refraction comes from one prebuilt round map (transit.ts) that hands over to
 *    the menu's real lens by opacity as it lands. No map or filter value changes per frame.
 *  - The blur is a static copy under a fixed filter, crossfaded with the sharp rows and
 *    removed once it is gone. The blur radius never animates.
 * Nothing is left inline at rest, so the stretch and the held rig own the glass as usual.
 */
import { cancelFrame, frame } from 'framer-motion';
import { MORPH } from '../motion';
import { copyScroll, inertCopy } from './copy';
import { contentAt, MAX_SUBSTEP, shapeAt, smoothstep, stepSpring, type Box, type MorphGeometry, type SpringState } from './math';
import { registerMorph } from './registry';
import { readSource, type MorphSource } from './source';

export interface MorphLayers {
  shell: HTMLElement;
  surface: HTMLElement;
  body: HTMLElement;
  sharp: HTMLElement;
  lens: HTMLElement | null;
  transit: HTMLElement | null;
  flash: HTMLElement | null;
  blurredClass: string;
  /** Bends and blurs the arriving rows at a fixed strength; null until the map is decoded, or off Chromium. */
  bendFilter: string | null;
  glyphClass: string;
}

export interface MorphOptions {
  layers: () => MorphLayers | null;
  trigger: () => HTMLElement | null;
  radius: number;
  reduced: () => boolean;
  /** The rest size changed, so the transit filter needs it. */
  onSize?: (width: number, height: number) => void;
  /** Open has settled: nothing is left inline. */
  onRest?: () => void;
}

const MAX_FRAME = 0.04;
const GROWING_BELOW = 0.9;

export type MorphPhase = 'idle' | 'opening' | 'open' | 'closing' | 'closed';

export function createMorph(options: MorphOptions) {
  let phase: MorphPhase = 'idle';
  const p: SpringState = { x: 0, v: 0 };
  const c: SpringState = { x: 0, v: 0 };
  const lift: SpringState = { x: 0, v: 0 };
  const fade: SpringState = { x: 0, v: 0 };
  let settle = 1;
  let elapsed = 0;
  let delayed = true;
  let running = false;
  let unregister: (() => void) | undefined;
  let done: (() => void) | undefined;
  let layers: MorphLayers | null = null;
  let source: MorphSource | null = null;
  let geometry: MorphGeometry | null = null;
  let origin = { x: 0, y: 0 };
  let tx = 0;
  let ty = 0;
  let blurred: HTMLElement | null = null;
  let blurredRows: HTMLElement | null = null;
  let glyph: HTMLElement | null = null;
  let sourceFaded = false;
  let observer: ResizeObserver | null = null;
  const written = new Map<HTMLElement, Map<string, string>>();

  /** Skip a write that would change nothing: each one invalidates style. */
  const put = (el: HTMLElement | null, name: string, value: string) => {
    if (!el) return;
    let props = written.get(el);
    if (!props) written.set(el, (props = new Map()));
    if (props.get(name) === value) return;
    props.set(name, value);
    if (name.startsWith('--')) el.style.setProperty(name, value);
    else (el.style as unknown as Record<string, string>)[name] = value;
  };

  const measureFinal = (): Box | null => {
    if (!layers) return null;
    const rect = layers.shell.getBoundingClientRect();
    const width = layers.shell.offsetWidth;
    const height = layers.shell.offsetHeight;
    if (width < 1 || height < 1) return null;
    const o = getComputedStyle(layers.shell).transformOrigin.split(' ').map(Number.parseFloat);
    origin = { x: o[0] ?? 0, y: o[1] ?? 0 };
    // The rect holds whatever pose was last written; undo it to reach the layout box.
    const sx = rect.width / width;
    const sy = rect.height / height;
    return {
      left: rect.left - tx - origin.x * (1 - sx),
      top: rect.top - ty - origin.y * (1 - sy),
      width,
      height,
    };
  };

  const measure = () => {
    const final = measureFinal();
    const trigger = options.trigger();
    if (trigger) source = readSource(trigger);
    if (!final || !source) return false;
    geometry = { source: source.box, sourceRadius: source.radius, final, radius: options.radius };
    options.onSize?.(final.width, final.height);
    return true;
  };

  const write = () => {
    if (!layers || !geometry) return;
    const { shell, surface, body, sharp, lens, transit, flash } = layers;
    const shape = shapeAt(p.x, c.x, settle, geometry);
    const pose = contentAt(c.x);
    const { final } = geometry;
    const sx = Math.max(1e-3, shape.width / final.width);
    const sy = Math.max(1e-3, shape.height / final.height);
    tx = shape.left - final.left - origin.x * (1 - sx);
    ty = shape.top - final.top - origin.y * (1 - sy);
    // Until it has landed the button under it keeps the pointer: a re-tap reverses, a release selects nothing.
    put(shell, 'pointerEvents', phase === 'opening' && p.x >= GROWING_BELOW ? '' : 'none');
    put(shell, 'transform', `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`);
    put(surface, 'borderRadius', `${(shape.radius / sx).toFixed(2)}px / ${(shape.radius / sy).toFixed(2)}px`);
    put(body, 'transform', `scale(${(pose.scale / sx).toFixed(4)}, ${(pose.scale / sy).toFixed(4)})`);
    put(sharp, 'opacity', pose.sharp.toFixed(3));
    put(blurred, 'opacity', pose.blurred.toFixed(3));
    put(blurredRows, 'transform', `scale(${(pose.scale / sx).toFixed(4)}, ${(pose.scale / sy).toFixed(4)})`);
    put(lens, 'opacity', pose.tint.toFixed(3));

    const separate = source?.kind === 'separate';
    const appear = separate ? lift.x : smoothstep(0, MORPH.sourceHandover, p.x) * lift.x;
    put(transit, 'opacity', (appear * (1 - smoothstep(0.82, 1, pose.tint))).toFixed(3));
    // The attached blob has no source glass to take over from: it appears on the button.
    put(surface, '--glass-fade', appear.toFixed(3));
    const flashed = separate ? lift.x * (1 - smoothstep(0.02, 0.16, p.x)) : 0;
    put(flash, 'opacity', flashed.toFixed(3));
    // The lift's wider shadow, against the scale: only for the few frames the source is that small.
    if (flashed > 0.01) {
      const { y, blur, alpha } = MORPH.liftShadow;
      put(surface, 'boxShadow', `0 ${(y / sy).toFixed(1)}px ${(blur / Math.min(sx, sy)).toFixed(1)}px rgba(var(--glass-shadow-rgb), ${(alpha * flashed).toFixed(3)})`);
    } else {
      put(surface, 'boxShadow', '');
    }

    if (separate && source?.surface) {
      // The button's own glass hands over to this one. Nothing is left behind during the open.
      source.surface.style.setProperty('--glass-fade', (1 - lift.x).toFixed(3));
      sourceFaded = true;
    }
    if (glyph) {
      const center = geometry.source;
      const lx = (center.left + center.width / 2 - shape.left) / sx;
      const ly = (center.top + center.height / 2 - shape.top) / sy;
      put(glyph, 'transform', `translate(${lx.toFixed(2)}px, ${ly.toFixed(2)}px) translate(-50%, -50%) scale(${(1 / sx).toFixed(4)}, ${(1 / sy).toFixed(4)})`);
      put(glyph, 'opacity', (1 - smoothstep(0, MORPH.sourceHandover * 1.4, p.x)).toFixed(3));
    }
  };

  /**
   * The rows' first arrival: a static copy under a fixed filter, in a wrapper that scales with
   * the glass, so the round map bends the rows at the rim the way the rim bends the backdrop.
   */
  const addBlurred = () => {
    if (!layers || blurred) return;
    blurred = document.createElement('div');
    blurred.className = layers.blurredClass;
    blurred.setAttribute('aria-hidden', 'true');
    if (layers.bendFilter) blurred.style.filter = `url(#${layers.bendFilter})`;
    blurredRows = inertCopy(layers.sharp);
    blurredRows.removeAttribute('style');
    blurred.appendChild(blurredRows);
    layers.surface.appendChild(blurred);
    copyScroll(layers.sharp, blurredRows);
  };
  const dropBlurred = () => {
    blurred?.remove();
    if (blurred) written.delete(blurred);
    if (blurredRows) written.delete(blurredRows);
    blurred = null;
    blurredRows = null;
  };

  const addGlyph = () => {
    if (!layers || glyph || source?.kind !== 'separate') return;
    const trigger = options.trigger();
    if (!trigger) return;
    glyph = inertCopy(trigger);
    glyph.removeAttribute('style');
    glyph.className = `${trigger.className} ${layers.glyphClass}`;
    layers.surface.appendChild(glyph);
  };
  const dropGlyph = () => {
    glyph?.remove();
    if (glyph) written.delete(glyph);
    glyph = null;
  };

  const restoreSource = () => {
    if (sourceFaded) source?.surface?.style.removeProperty('--glass-fade');
    sourceFaded = false;
  };

  const clearInline = () => {
    if (!layers) return;
    const { shell, surface, body, sharp, lens, transit, flash } = layers;
    shell.style.transform = '';
    shell.style.willChange = '';
    shell.style.pointerEvents = '';
    surface.style.borderRadius = '';
    surface.style.boxShadow = '';
    surface.style.removeProperty('--glass-fade');
    delete surface.dataset.morphing;
    body.style.transform = '';
    body.style.willChange = '';
    sharp.style.opacity = '';
    sharp.style.willChange = '';
    if (lens) lens.style.opacity = '';
    if (transit) transit.style.opacity = '';
    if (flash) flash.style.opacity = '';
    written.clear();
    tx = 0;
    ty = 0;
  };

  const stop = () => {
    running = false;
    cancelFrame(tick);
    observer?.disconnect();
    observer = null;
  };

  const finishOpen = () => {
    stop();
    phase = 'open';
    p.x = 1;
    p.v = 0;
    c.x = 1;
    c.v = 0;
    lift.x = 1;
    settle = 0;
    dropBlurred();
    dropGlyph();
    clearInline();
    // The source stays hidden while its glass is the menu; the panel owns the space now.
    if (source?.kind === 'separate' && source.surface) {
      source.surface.style.setProperty('--glass-fade', '0');
      sourceFaded = true;
    }
    options.onRest?.();
  };

  const finishClose = () => {
    stop();
    phase = 'closed';
    restoreSource();
    dropBlurred();
    dropGlyph();
    const complete = done;
    done = undefined;
    complete?.();
  };

  const tickFade = (dt: number) => {
    if (!layers) return;
    const target = phase === 'closing' ? 0 : 1;
    let left = dt;
    while (left > 0) {
      const step = Math.min(left, MAX_SUBSTEP);
      stepSpring(fade, target, MORPH.fade, step);
      left -= step;
    }
    layers.surface.style.setProperty('--glass-fade', fade.x.toFixed(3));
    if (Math.abs(fade.x - target) < 0.004) {
      fade.x = target;
      if (phase === 'closing') {
        finishClose();
      } else {
        stop();
        phase = 'open';
        layers.surface.style.removeProperty('--glass-fade');
      }
    }
  };

  function tick({ delta }: { delta: number }) {
    if (!running) return;
    const dt = Math.min(MAX_FRAME, delta / 1000);
    if (options.reduced()) return tickFade(dt);
    elapsed += dt;
    const opening = phase === 'opening';
    const spec = opening ? MORPH.open : MORPH.close;
    const shapeTarget = opening ? (!delayed || elapsed >= MORPH.open.shapeDelay ? 1 : p.x) : 0;
    const contentTarget = opening ? (!delayed || elapsed >= MORPH.open.contentDelay ? 1 : c.x) : 0;
    let left = dt;
    while (left > 0) {
      const step = Math.min(left, MAX_SUBSTEP);
      stepSpring(p, shapeTarget, spec.shape, step);
      stepSpring(c, contentTarget, spec.content, step);
      // On the way back the glass stays whole until it is on the button, then hands over to the source.
      stepSpring(lift, opening || p.x > MORPH.sourceHandover ? 1 : 0, spec.lift, step);
      left -= step;
    }
    if (opening && p.x > MORPH.path.settleStart) settle *= Math.exp(-dt / MORPH.path.settleTau);
    write();
    if (opening && Math.abs(1 - p.x) < 8e-4 && Math.abs(p.v) < 0.02 && Math.abs(1 - c.x) < 2e-3 && settle < 0.01) finishOpen();
    else if (!opening && p.x < 2e-3 && Math.abs(p.v) < 0.1 && lift.x < 0.01) finishClose();
  }

  const start = () => {
    if (!layers) return;
    if (!running) {
      running = true;
      frame.update(tick, true);
    }
    if (typeof ResizeObserver !== 'undefined' && !observer) {
      observer = new ResizeObserver(() => {
        if (phase === 'opening' || phase === 'closing') measure();
      });
      observer.observe(layers.shell);
    }
  };

  /** Move the glass to the state it is in before its first paint. */
  const prepare = () => {
    if (!layers) return;
    const { shell, body, sharp, surface } = layers;
    surface.dataset.morphing = 'true';
    shell.style.willChange = 'transform';
    body.style.willChange = 'transform';
    sharp.style.willChange = 'opacity';
  };

  return {
    open() {
      layers = options.layers();
      if (!layers) return;
      if (options.reduced()) {
        phase = 'opening';
        layers.surface.style.setProperty('--glass-fade', fade.x.toFixed(3));
        start();
        return;
      }
      unregister ??= registerMorph(layers.surface, {
        growing: () => phase === 'opening' && p.x < GROWING_BELOW,
        restRect: () => (geometry && phase === 'opening' ? new DOMRect(geometry.final.left, geometry.final.top, geometry.final.width, geometry.final.height) : null),
      });
      const fresh = phase === 'idle' || phase === 'closed';
      if (!measure()) {
        // No layout to morph (jsdom, display: none): it is simply open.
        phase = 'open';
        return;
      }
      phase = 'opening';
      if (fresh) {
        elapsed = 0;
        delayed = true;
        settle = 1;
      } else {
        delayed = false;
        if (p.x < MORPH.path.settleFrom) settle = 1;
      }
      prepare();
      addBlurred();
      addGlyph();
      write();
      start();
    },
    close(onDone: () => void) {
      done = onDone;
      layers = layers ?? options.layers();
      // AnimatePresence only listens for the exit after this commit's layout effects: never finish inside one.
      if (!layers) return queueMicrotask(finishClose);
      if (options.reduced()) {
        phase = 'closing';
        fade.x = fade.x || 1;
        start();
        return;
      }
      const wasOpen = phase === 'open';
      if (!measure()) return queueMicrotask(finishClose);
      phase = 'closing';
      if (wasOpen) {
        p.x = 1;
        c.x = 1;
        lift.x = 1;
        settle = 0;
        written.clear();
      }
      prepare();
      addBlurred();
      addGlyph();
      write();
      start();
    },
    /** Effects re-run (StrictMode, a fast refresh): pick an interrupted morph back up. */
    resume() {
      if (phase !== 'opening' && phase !== 'closing') return;
      if (!options.reduced()) {
        addBlurred();
        addGlyph();
        write();
      }
      start();
    },
    destroy() {
      stop();
      restoreSource();
      unregister?.();
      unregister = undefined;
      dropBlurred();
      dropGlyph();
    },
    get phase() {
      return phase;
    },
  };
}
