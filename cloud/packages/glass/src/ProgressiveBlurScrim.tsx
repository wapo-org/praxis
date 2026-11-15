import React from 'react';
import styles from './scrim.module.css';

/** Static CSS backdrop-blur bands mirroring PraxisChat ProgressiveBlurScrim.swift. */
export interface ProgressiveBlurScrimProps extends React.HTMLAttributes<HTMLDivElement> {
  edge: 'top' | 'bottom';
  height?: number;
  tintColor?: string;
}

export function ProgressiveBlurScrim({
  edge,
  height = 64,
  tintColor,
  className = '',
  style,
  ...rest
}: ProgressiveBlurScrimProps) {
  return (
    <div
      aria-hidden="true"
      data-slot={`progressive-blur-${edge}`}
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
      <div className={styles.band} />
      <div className={styles.band} />
      <div className={styles.band} />
      <div className={styles.band} />
      <div className={styles.feather} />
    </div>
  );
}

export interface ScrollBlurProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  height?: string | number;
  maxHeight?: string | number;
  scrimHeight?: number;
  viewportRef?: React.Ref<HTMLDivElement>;
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
}

function toCssSize(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

export function ScrollBlur({
  children,
  height,
  maxHeight,
  scrimHeight = 16,
  viewportRef,
  onViewportScroll,
  className = '',
  style,
  ...rest
}: ScrollBlurProps) {
  return (
    <div
      data-slot="scroll-blur"
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
