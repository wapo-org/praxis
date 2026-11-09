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
import { contentAt, lerp, MAX_SUBSTEP, shapeAt, smoothstep, stepSpring, type Box, type MorphGeometry, type SpringState } from './math';
import { registerMorph } from './registry';
import { hasCornerShape, ROUND_PER_CURVE_RADIUS } from '../squircle';

/** The radius the glass rests at: the token where corner-shape draws the curve, else the circle under the path. */
export const restRadius = (token: number) => (hasCornerShape() ? token : token * ROUND_PER_CURVE_RADIUS);
import { readSource, type MorphSource } from './source';

export interface MorphLayers {
  shell: HTMLElement;
  surface: HTMLElement;
  body: HTMLElement;
  sharp: HTMLElement;
  lens: HTMLElement | null;
  transit: HTMLElement | null;
  flash: HTMLElement | null;
  rim: HTMLElement | null;
  blurredClass: string;
  /** Bends and blurs the arriving rows at a fixed strength; null until the map is decoded, or off Chromium. */
  bendFilter: string | null;
  glyphClass: string;
}

export interface MorphOptions {
  layers: () => MorphLayers | null;
  trigger: () => HTMLElement | null;
  reduced: () => boolean;
  /** The rest size changed, so the transit filter needs it. */
  onSize?: (width: number, height: number) => void;
  /** Open has settled: nothing is left inline. */
  onRest?: () => void;
}

const MAX_FRAME = 0.04;
const MAX_FIRST_FRAME = 0.1;

/** The timeline runs from the press, not from when the menu finished mounting: a slow mount must not read as lag. */
let lastInput = 0;
if (typeof window !== 'undefined') {
  const mark = () => { lastInput = performance.now(); };
  window.addEventListener('pointerdown', mark, { capture: true, passive: true });
  window.addEventListener('keydown', mark, { capture: true, passive: true });
}
function openedSince() {
  const now = performance.now();
  return now - lastInput < MAX_FIRST_FRAME * 1000 ? lastInput : now;
}
const GROWING_BELOW = 0.9;

export type MorphPhase = 'idle' | 'opening' | 'open' | 'resizing' | 'closing' | 'closed';

export function createMorph(options: MorphOptions) {
  let phase: MorphPhase = 'idle';
  const p: SpringState = { x: 0, v: 0 };
  const c: SpringState = { x: 0, v: 0 };
  /** The shape's own clock: circle, then squircle. Separate from `c`, so the rows can land before the shape does. */
  const f: SpringState = { x: 0, v: 0 };
  const lift: SpringState = { x: 0, v: 0 };
  const resize: SpringState = { x: 1, v: 0 };
  let resizeFrom: Box | null = null;
  const fade: SpringState = { x: 0, v: 0 };
  let elapsed = 0;
  let delayed = true;
  let running = false;
  let firstTick = true;
  let startedAt = 0;
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
  /** Layout centres, in the shell's own px, of the rows and their blurred copy: where they rest. */
  let bodyCentre: { x: number; y: number } | null = null;
  let copyCentre: { x: number; y: number } | null = null;
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

  /** An element's layout centre in the shell's px (offsets ignore transforms), or null outside the shell. */
  const centreIn = (el: HTMLElement | null) => {
    if (!el || !layers) return null;
    let x = el.offsetWidth / 2;
    let y = el.offsetHeight / 2;
    let node: HTMLElement | null = el;
    while (node && node !== layers.shell) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent as HTMLElement | null;
    }
    return node === layers.shell ? { x, y } : null;
  };

  /**
   * The counter-transform that holds a layer's centre where its rest layout puts it, by `weight` (0: it rides
   * the glass's pose; 1: it stays put whatever the glass is doing), in the shell's px before the shell's scale.
   */
  const pinShift = (centre: { x: number; y: number } | null, sx: number, sy: number, weight: number) => {
    if (!centre || weight <= 0) return { x: 0, y: 0 };
    const dx = tx + (sx - 1) * (centre.x - origin.x);
    const dy = ty + (sy - 1) * (centre.y - origin.y);
    return { x: (-dx / sx) * weight, y: (-dy / sy) * weight };
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
    // From the tokens, never the live radius: this may be mid-flight, with the morph writing that one.
    const style = getComputedStyle(layers!.surface);
    const corner = /superellipse\(([\d.]+)\)/.exec(style.getPropertyValue('--glass-corner'));
    geometry = {
      source: source.box,
      sourceRadius: source.radius,
      final,
      // Never --glass-radius-round: it is set by an observer that may not have run yet on the first open, and a
      // morph that lands on the wrong radius swaps it when the inline styles clear (WP-G4 A2).
      radius: restRadius(Number.parseFloat(style.getPropertyValue('--glass-radius')) || 0),
      corner: corner ? Number(corner[1]) : 1,
    };
    bodyCentre = centreIn(layers!.body);
    copyCentre = null;
    options.onSize?.(final.width, final.height);
    return true;
  };

  const write = () => {
    if (!layers || !geometry) return;
    const { shell, surface, body, sharp, lens, transit, flash, rim } = layers;
    const shape = shapeAt(p.x, f.x, geometry);
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
    put(surface, 'cornerShape', `superellipse(${shape.corner.toFixed(3)})`);
    const round = shape.corner < geometry.corner - 1e-3 || Math.abs(shape.radius - geometry.radius) > 0.5;
    if ((surface.dataset.morphRound === 'true') !== round) {
      if (round) surface.dataset.morphRound = 'true';
      else delete surface.dataset.morphRound;
    }
    // One crisp line at any scale, in every frame: the rim is what says this is a piece of glass.
    put(rim, '--morph-rim', `${(MORPH.rimWidth / Math.min(sx, sy)).toFixed(2)}px`);
    // The rows ride the glass while they arrive; as they land they are pinned to their rest layout, so whatever
    // the glass still does it never carries them (WP-I1: the tray's rows drifted with its last squaring).
    const pin = smoothstep(MORPH.open.pinFrom, 1, c.x);
    const scale = `scale(${(pose.scale / sx).toFixed(4)}, ${(pose.scale / sy).toFixed(4)})`;
    const held = pinShift(bodyCentre, sx, sy, pin);
    put(body, 'transform', `translate(${held.x.toFixed(2)}px, ${held.y.toFixed(2)}px) ${scale}`);
    put(sharp, 'opacity', pose.sharp.toFixed(3));
    put(blurred, 'opacity', pose.blurred.toFixed(3));
    if (blurredRows && !copyCentre) copyCentre = centreIn(blurredRows);
    const heldCopy = pinShift(copyCentre, sx, sy, pin);
    put(blurredRows, 'transform', `translate(${heldCopy.x.toFixed(2)}px, ${heldCopy.y.toFixed(2)}px) ${scale}`);
    put(lens, 'opacity', pose.tint.toFixed(3));
    // A lens nobody can see yet should not cost a backdrop pass.
    put(lens, 'visibility', pose.tint > 0 ? '' : 'hidden');

    const separate = source?.kind === 'separate';
    const appear = separate ? lift.x : smoothstep(0, MORPH.sourceHandover, p.x) * lift.x;
    put(transit, 'opacity', (appear * (1 - smoothstep(MORPH.content.transitOutFrom, MORPH.content.transitOutTo, pose.tint))).toFixed(3));
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
    // Refraction on a reference-sized panel; a big one would only scribble its rows, so it just blurs.
    const big = geometry && Math.max(geometry.final.width, geometry.final.height) > MORPH.content.bendMaxSide;
    if (layers.bendFilter && !big) blurred.style.filter = `url(#${layers.bendFilter})`;
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
    copyCentre = null;
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
    const { shell, surface, body, sharp, lens, transit, flash, rim } = layers;
    rim?.style.removeProperty('--morph-rim');
    surface.style.removeProperty('corner-shape');
    shell.style.transform = '';
    shell.style.willChange = '';
    shell.style.pointerEvents = '';
    surface.style.borderRadius = '';
    surface.style.boxShadow = '';
    surface.style.removeProperty('--glass-fade');
    delete surface.dataset.morphing;
    delete surface.dataset.morphRound;
    body.style.transform = '';
    body.style.transformOrigin = '';
    body.style.willChange = '';
    sharp.style.opacity = '';
    sharp.style.willChange = '';
    if (lens) {
      lens.style.opacity = '';
      lens.style.visibility = '';
    }
    if (transit) transit.style.opacity = '';
    if (flash) flash.style.opacity = '';
    written.clear();
    tx = 0;
    ty = 0;
  };

  const stop = () => {
    running = false;
    cancelFrame(tick);
  };
  const unobserve = () => {
    observer?.disconnect();
    observer = null;
  };

  /**
   * The open menu changed size in layout (a submenu, a filtered list, the tray's model view). Layout has
   * already moved; the glass glides there from where it was, in transforms, with the rows held at scale 1.
   */
  const relayout = () => {
    if (!layers || !geometry) return;
    if (phase !== 'open' && phase !== 'resizing' && phase !== 'opening' && phase !== 'closing') return;
    const was = geometry.final;
    const next = measureFinal();
    if (!next) return;
    if (Math.abs(next.width - was.width) + Math.abs(next.height - was.height) + Math.abs(next.left - was.left) + Math.abs(next.top - was.top) < 0.5) return;
    if (phase === 'opening' || phase === 'closing' || options.reduced()) {
      geometry = { ...geometry, final: next };
      return;
    }
    // Continue from what is on screen.
    let from = was;
    if (phase === 'resizing' && resizeFrom) {
      from = { left: lerp(resizeFrom.left, was.left, resize.x), top: lerp(resizeFrom.top, was.top, resize.x), width: lerp(resizeFrom.width, was.width, resize.x), height: lerp(resizeFrom.height, was.height, resize.x) };
    }
    geometry = { ...geometry, final: next };
    resizeFrom = from;
    resize.x = 0;
    resize.v = 0;
    phase = 'resizing';
    layers.surface.dataset.morphing = 'true';
    // The path cannot follow a non-uniform scale; the compensated circle can.
    layers.surface.dataset.morphRound = 'true';
    layers.shell.style.willChange = 'transform';
    layers.body.style.willChange = 'transform';
    layers.body.style.transformOrigin = '0 0';
    writeResize();
    start();
  };

  function writeResize() {
    if (!layers || !geometry || !resizeFrom) return;
    const { shell, surface, body, rim } = layers;
    const { final, radius } = geometry;
    const left = lerp(resizeFrom.left, final.left, resize.x);
    const top = lerp(resizeFrom.top, final.top, resize.x);
    const sx = Math.max(1e-3, lerp(resizeFrom.width, final.width, resize.x) / final.width);
    const sy = Math.max(1e-3, lerp(resizeFrom.height, final.height, resize.x) / final.height);
    tx = left - final.left - origin.x * (1 - sx);
    ty = top - final.top - origin.y * (1 - sy);
    put(shell, 'transform', `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`);
    put(surface, 'borderRadius', `${(radius / sx).toFixed(2)}px / ${(radius / sy).toFixed(2)}px`);
    put(rim, '--morph-rim', `${(MORPH.rimWidth / Math.min(sx, sy)).toFixed(2)}px`);
    // Pin the rows to the panel's top-left at their real size; the rim's clip reveals or hides the rest.
    put(body, 'transform', `translate(${(body.offsetLeft * (1 / sx - 1)).toFixed(2)}px, ${(body.offsetTop * (1 / sy - 1)).toFixed(2)}px) scale(${(1 / sx).toFixed(4)}, ${(1 / sy).toFixed(4)})`);
  }

  const finishOpen = () => {
    stop();
    phase = 'open';
    p.x = 1;
    p.v = 0;
    c.x = 1;
    c.v = 0;
    f.x = 1;
    f.v = 0;
    lift.x = 1;
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
    unobserve();
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
    // The scheduler's first delta after idle is a nominal frame; what passed is the time since this started.
    const dt = firstTick ? Math.min(MAX_FIRST_FRAME, (performance.now() - startedAt) / 1000) : Math.min(MAX_FRAME, delta / 1000);
    firstTick = false;
    if (options.reduced()) return tickFade(dt);
    if (phase === 'resizing') {
      let remaining = dt;
      while (remaining > 0) {
        const step = Math.min(remaining, MAX_SUBSTEP);
        stepSpring(resize, 1, MORPH.resize, step);
        remaining -= step;
      }
      writeResize();
      if (Math.abs(1 - resize.x) < 1e-3 && Math.abs(resize.v) < 0.02) {
        stop();
        phase = 'open';
        resize.x = 1;
        resizeFrom = null;
        clearInline();
      }
      return;
    }
    elapsed += dt;
    const opening = phase === 'opening';
    const spec = opening ? MORPH.open : MORPH.close;
    // Past the rest size until the rows have nearly landed: the overshoot shows on the squared-up panel, then returns.
    const landing = f.x >= MORPH.open.landAt ? 1 : 1 + MORPH.open.overshoot;
    const shapeTarget = opening ? (!delayed || elapsed >= MORPH.open.shapeDelay ? landing : p.x) : 0;
    const contentTarget = opening ? (!delayed || elapsed >= MORPH.open.contentDelay ? 1 : c.x) : 0;
    let left = dt;
    while (left > 0) {
      const step = Math.min(left, MAX_SUBSTEP);
      stepSpring(p, shapeTarget, spec.shape, step);
      stepSpring(c, contentTarget, spec.content, step);
      stepSpring(f, contentTarget, spec.form, step);
      // On the way back the glass stays whole until it is on the button, then hands over to the source.
      stepSpring(lift, opening || p.x > MORPH.sourceHandover ? 1 : 0, spec.lift, step);
      left -= step;
    }
    write();
    if (opening && Math.abs(1 - p.x) < 8e-4 && Math.abs(p.v) < 0.02 && Math.abs(1 - c.x) < 2e-3 && Math.abs(1 - f.x) < 2e-3) finishOpen();
    else if (!opening && p.x < 2e-3 && Math.abs(p.v) < 0.1 && lift.x < 0.01) finishClose();
  }

  const start = () => {
    if (!layers) return;
    if (!running) {
      running = true;
      firstTick = true;
      startedAt = openedSince();
      frame.update(tick, true);
    }
    if (typeof ResizeObserver !== 'undefined' && !observer) {
      observer = new ResizeObserver(relayout);
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
      } else {
        delayed = false;
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
      const wasOpen = phase === 'open' || phase === 'resizing';
      resizeFrom = null;
      if (layers) layers.body.style.transformOrigin = '';
      if (!measure()) return queueMicrotask(finishClose);
      phase = 'closing';
      if (wasOpen) {
        p.x = 1;
        c.x = 1;
        f.x = 1;
        lift.x = 1;
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
    /** The positioned box moved (a flip, a re-anchor): same as a size change. */
    relayout,
    destroy() {
      stop();
      unobserve();
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
