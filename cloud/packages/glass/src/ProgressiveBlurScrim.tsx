import React from 'react';
import styles from './scrim.module.css';

/** ProgressiveBlurScrim: a blur that ramps up toward the edge, without bloom. */
export interface ProgressiveBlurScrimProps extends React.HTMLAttributes<HTMLDivElement> {
  edge: 'top' | 'bottom';
  height?: number;
  tintColor?: string;
  layers?: 'all' | 'blur' | 'tint';
  /** The edge band's radius; the others halve inward from it. Default 6 px. */
  maxBlur?: number;
  /** The paper feather's strength at the edge, 0–1 (default 0.88). A light feather keeps the scrim free of a white band. */
  tintStrength?: number;
}

/** Radii from the edge inward. */
export const SCRIM_RADII = [6, 3, 1.5, 0.75, 0.375] as const;

export function ProgressiveBlurScrim({
  edge,
  height = 64,
  tintColor,
  layers = 'all',
  maxBlur = SCRIM_RADII[0],
  tintStrength,
  className = '',
  style,
  ...rest
}: ProgressiveBlurScrimProps) {
  return (
    <div
      aria-hidden="true"
      data-slot={`progressive-blur-${edge}`}
      data-layers={layers}
      className={`${styles.scrim} ${styles[edge]} ${className}`.trim()}
      style={
        {
          '--scrim-height': `${height}px`,
          ...(tintColor ? { '--scrim-tint': tintColor } : null),
          ...(tintStrength !== undefined ? { '--scrim-tint-a': `${Math.round(tintStrength * 100)}%`, '--scrim-tint-b': `${Math.round(tintStrength * 45)}%` } : null),
          ...style,
        } as React.CSSProperties
      }
      {...rest}
    >
      {layers !== 'tint'
        ? SCRIM_RADII.map((radius, i) => (
            <div key={radius} className={styles.band} style={{ '--band-blur': `${(radius * maxBlur) / SCRIM_RADII[0]}px`, '--band-index': i } as React.CSSProperties} />
          ))
        : null}
      {layers !== 'blur' ? <div className={styles.feather} /> : null}
    </div>
  );
}

export interface ScrollBlurProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  height?: string | number;
  maxHeight?: string | number;
  scrimHeight?: number;
  /** Let children leave the box: no scroll, no clip, no mask (cascading submenus live outside it). */
  open?: boolean;
  viewportRef?: React.Ref<HTMLDivElement>;
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
}

function toCssSize(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

function assignViewportRef(ref: React.Ref<HTMLDivElement> | undefined, node: HTMLDivElement | null) {
  if (typeof ref === 'function') ref(node);
  else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
}

export function ScrollBlur({
  children,
  height,
  maxHeight,
  scrimHeight = 16,
  open = false,
  viewportRef,
  onViewportScroll,
  className = '',
  style,
  ...rest
}: ScrollBlurProps) {
  const localViewportRef = React.useRef<HTMLDivElement | null>(null);
  const supportsScrollTimeline =
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timeline: scroll()');

  const syncFallbackMask = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || open || supportsScrollTimeline) return;
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll <= 1) {
        el.style.setProperty('--fade-top', '0px');
        el.style.setProperty('--fade-bottom', '0px');
        return;
      }
      const top = Math.min(1, el.scrollTop / Math.max(1, scrimHeight)) * scrimHeight;
      const bottom = Math.min(1, (maxScroll - el.scrollTop) / Math.max(1, scrimHeight)) * scrimHeight;
      el.style.setProperty('--fade-top', `${Math.round(top)}px`);
      el.style.setProperty('--fade-bottom', `${Math.round(bottom)}px`);
    },
    [open, scrimHeight, supportsScrollTimeline],
  );

  React.useLayoutEffect(() => {
    const el = localViewportRef.current;
    if (!el || open || supportsScrollTimeline) return;
    syncFallbackMask(el);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncFallbackMask(el)) : null;
    resizeObserver?.observe(el);
    if (el.firstElementChild) resizeObserver?.observe(el.firstElementChild);
    const mutationObserver =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(() => syncFallbackMask(el)) : null;
    mutationObserver?.observe(el, { childList: true, subtree: true });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [open, supportsScrollTimeline, syncFallbackMask]);

  const setRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      localViewportRef.current = node;
      assignViewportRef(viewportRef, node);
    },
    [viewportRef],
  );

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (event) => {
    syncFallbackMask(event.currentTarget);
    onViewportScroll?.(event);
  };

  return (
    <div
      data-slot="scroll-blur"
      data-open={open || undefined}
      className={`${styles.scroll} ${className}`.trim()}
      style={{ height: toCssSize(height), maxHeight: toCssSize(maxHeight), ...style }}
      {...rest}
    >
      <div
        ref={setRef}
        onScroll={handleScroll}
        data-slot="scroll-blur-viewport"
        className={styles.viewport}
        style={{ maxHeight: toCssSize(maxHeight), '--fade-size': `${scrimHeight}px` } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}
