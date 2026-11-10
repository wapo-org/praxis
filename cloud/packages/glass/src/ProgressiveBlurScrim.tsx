import React from 'react';
import styles from './scrim.module.css';

/**
 * ProgressiveBlurScrim: a blur that ramps up toward the edge, without bloom.
 *
 * Technique (stacked windowed bands): five backdrop-filter layers whose radii double toward the edge
 * (0.375 → 6 px). Each layer's mask is a band that rises, holds and falls, overlapping only its neighbours,
 * so every point sees about one radius instead of all of them summed. Each layer also extends past the
 * visible scrim into the content (its mask is sized to the scrim), so the blur samples real pixels there
 * instead of repeating the layer's edge row, which is what made bright content glow. No brightness or
 * saturation boost; a light paper feather keeps the bar legible.
 * Sources: Kenneth Nym, "Progressive blur in CSS" (code.nym.sh/kennethnym); Josh W. Comeau, "Next-level
 * frosted glass with backdrop-filter" (joshwcomeau.com/css/backdrop-filter); Chromium "backdrop-filter
 * mirror edgeMode" PSA (groups.google.com/a/chromium.org/g/blink-dev/c/ZtMnFCHZhMQ).
 * Pure CSS; nothing runs per frame.
 */
export interface ProgressiveBlurScrimProps extends React.HTMLAttributes<HTMLDivElement> {
  edge: 'top' | 'bottom';
  height?: number;
  tintColor?: string;
  /**
   * `blur` (the bands) and `tint` (the paper feather) can be placed apart: the chat keeps the bands inside the
   * content lane, because Chromium mirrors scrolled text into a blur that reaches past the column's edge.
   */
  layers?: 'all' | 'blur' | 'tint';
}

/** Radii from the edge inward. */
export const SCRIM_RADII = [6, 3, 1.5, 0.75, 0.375] as const;

export function ProgressiveBlurScrim({
  edge,
  height = 64,
  tintColor,
  layers = 'all',
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
          ...style,
        } as React.CSSProperties
      }
      {...rest}
    >
      {layers !== 'tint'
        ? SCRIM_RADII.map((radius, i) => (
            <div key={radius} className={styles.band} style={{ '--band-blur': `${radius}px`, '--band-index': i } as React.CSSProperties} />
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
  /** Fade size in px at a scrolled edge. */
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

/** A scroll viewport whose edges fade out only once scrolled (CSS scroll-driven mask, no JS). */
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
  return (
    <div
      data-slot="scroll-blur"
      data-open={open || undefined}
      className={`${styles.scroll} ${className}`.trim()}
      style={{ height: toCssSize(height), maxHeight: toCssSize(maxHeight), ...style }}
      {...rest}
    >
      <div
        ref={viewportRef}
        onScroll={onViewportScroll}
        data-slot="scroll-blur-viewport"
        className={styles.viewport}
        style={{ maxHeight: toCssSize(maxHeight), '--fade-size': `${scrimHeight}px` } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}
