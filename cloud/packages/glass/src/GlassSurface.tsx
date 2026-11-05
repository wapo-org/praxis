import React from 'react';
import { animate, motion, motionValue, type HTMLMotionProps } from 'framer-motion';
import { generateMaps, type GeneratedMaps } from './displacement-map';
import { LensFilter } from './LensFilter';
import { MATERIAL_RAMP, glassTier, useBaseChroma, type GlassMaterial } from './material';
import { TRANSITION } from './motion';
import { createRig } from './rig';
import { attachStretch, reducedMotion } from './stretch';
import styles from './glass.module.css';

export type { GlassMaterial } from './material';
/** `capsule` is fully round; `card` uses `radius` or the token default. */
export type GlassShape = 'capsule' | 'card';

export interface GlassMaterialControls {
  material?: GlassMaterial;
}

export interface GlassSurfaceProps extends HTMLMotionProps<'div'>, GlassMaterialControls {
  shape?: GlassShape;
  /** Corner radius in px for `card`; ignored for `capsule`. Prefer the token default. */
  radius?: number;
  /**
   * The elastic stretch (default on, from anywhere on the glass). `edge` only
   * pulls once the pointer is past the edge, for menus that scrub inside.
   */
  stretch?: boolean | 'edge';
  /** Pointer-tracked focus glow (default on). Off for touch and reduced motion regardless. */
  spotlight?: boolean;
}

type MotionFrame = HTMLMotionProps<'div'>['animate'];

/**
 * `opacity` on the root would make it a backdrop root and blank the lens inside
 * it for the whole fade, so a fade is routed through a variable the layers and
 * the content read. Everything else (scale, x, y) stays on the root's transform.
 */
function routeFade<T extends MotionFrame | HTMLMotionProps<'div'>['exit'] | HTMLMotionProps<'div'>['initial']>(frame: T): T {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !('opacity' in frame)) return frame;
  const { opacity, ...rest } = frame as Record<string, unknown>;
  return { ...rest, '--glass-fade': opacity } as unknown as T;
}

const LARGE_AREA = 160_000;
const RESIZE_DEBOUNCE_MS = 120;

/** Built at rest size and reused; never rebuilt during a gesture (transforms do not resize). */
function useLensMaps(rootRef: React.RefObject<HTMLElement | null>, material: GlassMaterial, shape: GlassShape, radius?: number) {
  const [maps, setMaps] = React.useState<GeneratedMaps | null>(null);
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || glassTier() !== 'svg' || typeof ResizeObserver === 'undefined') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastW = 0;
    let lastH = 0;
    const build = () => {
      if (disposed) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w < 8 || h < 8 || (w === lastW && h === lastH)) return;
      lastW = w;
      lastH = h;
      const r = shape === 'capsule' ? Math.min(w, h) / 2 : (radius ?? Number.parseFloat(getComputedStyle(el).borderTopLeftRadius)) || 0;
      const next = generateMaps({ width: w, height: h, radius: r, bezel: MATERIAL_RAMP[material].bezel, material });
      if (!next) return;
      // An undecoded feImage is transparent, which displaces the whole backdrop: wait for it.
      void Promise.all(
        [next.displacementUrl, next.specularUrl, next.frostMaskUrl].map((src) => {
          const img = new Image();
          img.src = src;
          return img.decode().catch(() => undefined);
        }),
      ).then(() => {
        if (!disposed) setMaps(next);
      });
    };
    let first = true;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      if (!first) {
        timer = setTimeout(build, RESIZE_DEBOUNCE_MS);
        return;
      }
      first = false;
      // Big surfaces build off the first paint; small ones are a millisecond.
      if (el.offsetWidth * el.offsetHeight > LARGE_AREA && 'requestIdleCallback' in window) {
        window.requestIdleCallback(build, { timeout: 250 });
      } else build();
    });
    observer.observe(el);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [rootRef, material, shape, radius]);
  return maps;
}

/** The radial glow at the cursor. Transform-only, so tracking repaints nothing. */
function attachSpotlight(el: HTMLElement) {
  const opacity = motionValue(0);
  const off = opacity.on('change', (value) => {
    const spot = el.querySelector<HTMLElement>(':scope > [data-glass-spot-clip] > [data-glass-spot]');
    if (spot) spot.style.opacity = String(value);
  });
  const place = (event: PointerEvent) => {
    const spot = el.querySelector<HTMLElement>(':scope > [data-glass-spot-clip] > [data-glass-spot]');
    if (!spot) return;
    const rect = el.getBoundingClientRect();
    spot.style.transform = `translate3d(${event.clientX - rect.left}px, ${event.clientY - rect.top}px, 0)`;
  };
  const enter = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || reducedMotion()) return;
    place(event);
    animate(opacity, 1, TRANSITION.base);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') place(event);
  };
  const leave = () => {
    animate(opacity, 0, TRANSITION.slow);
  };
  el.addEventListener('pointerenter', enter);
  el.addEventListener('pointermove', move, { passive: true });
  el.addEventListener('pointerleave', leave);
  return () => {
    off();
    opacity.stop();
    el.removeEventListener('pointerenter', enter);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerleave', leave);
  };
}

/**
 * Liquid glass. On Chromium a real lens (`backdrop-filter: url(#id)`, the kube.io
 * construction from wapo.dp); elsewhere a progressive frost with the same finish.
 * Layout and DOM geometry never move: the stretch is `scale` + `translate` on this
 * root and framer-motion's own transform composes with it. No re-render per frame.
 */
export const GlassSurface = React.forwardRef<HTMLDivElement, GlassSurfaceProps>(function GlassSurface(
  { material = 'regular', shape = 'card', radius, stretch = true, spotlight = true, className = '', style, initial, animate: animateProp, exit, children, ...rest },
  forwardedRef,
) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const setRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  const tier = glassTier();
  const maps = useLensMaps(rootRef, material, shape, shape === 'capsule' ? undefined : radius);
  const chroma = useBaseChroma();
  const filterId = `glass-lens-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const mode = stretch === 'edge' ? 'edge' : stretch ? 'press' : null;

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rig = createRig(el, material);
    const detachStretch = mode ? attachStretch(el, { material, mode, onHold: (held) => rig.hold(held) }) : undefined;
    const detachSpot = spotlight ? attachSpotlight(el) : undefined;
    return () => {
      detachStretch?.();
      detachSpot?.();
      rig.destroy();
    };
  }, [material, mode, spotlight]);

  const lensStyle: React.CSSProperties | undefined =
    tier === 'svg' && maps ? { backdropFilter: `url(#${filterId})`, WebkitBackdropFilter: `url(#${filterId})` } : undefined;
  const rootStyle = (
    radius === undefined || shape === 'capsule' ? style : { ...style, '--glass-radius': `${radius}px` }
  ) as HTMLMotionProps<'div'>['style'];
  const [core, mid, rim] = MATERIAL_RAMP[material].frost;

  return (
    <motion.div
      ref={setRef}
      data-glass-surface={tier}
      data-glass-material={material}
      data-glass-stretch={mode ?? undefined}
      className={`${styles.glass} ${styles[material]} ${shape === 'capsule' ? styles.capsule : ''} praxis-glass-surface ${className}`.trim()}
      style={rootStyle}
      initial={routeFade(initial)}
      animate={routeFade(animateProp)}
      exit={routeFade(exit)}
      {...rest}
    >
      {tier === 'svg' && maps ? <LensFilter id={filterId} material={material} maps={maps} chroma={chroma} /> : null}
      {tier === 'frost' ? (
        <>
          <span aria-hidden="true" className={styles.band} style={{ '--band-blur': `${core}px` } as React.CSSProperties} />
          <span aria-hidden="true" className={`${styles.band} ${styles.bandMid}`} style={{ '--band-blur': `${mid}px` } as React.CSSProperties} />
          <span aria-hidden="true" className={`${styles.band} ${styles.bandRim}`} style={{ '--band-blur': `${rim}px` } as React.CSSProperties} />
        </>
      ) : null}
      <span aria-hidden="true" data-glass-lens="" className={tier === 'svg' ? styles.lens : styles.finish} style={lensStyle} />
      {spotlight ? (
        <span aria-hidden="true" data-glass-spot-clip="" className={styles.spotClip}>
          <span data-glass-spot="" className={styles.spot} />
        </span>
      ) : null}
      {children as React.ReactNode}
    </motion.div>
  );
});
