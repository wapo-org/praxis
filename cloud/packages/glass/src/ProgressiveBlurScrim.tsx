import React from 'react';

/**
 * ProgressiveBlurScrim & ScrollBlur — Ported from:
 * - PraxisChat/PraxisChat/DesignSystem/ProgressiveBlurScrim.swift
 * - wapo.dp/src/components/ui/scroll-blur.tsx
 *
 * Uses 6 stacked backdrop-blur bands (0.5px -> 1.5px -> 3.5px -> 7px -> 12px -> 20px)
 * masked by linear gradients plus a warm paper color feather so scrolling text dissolves
 * smoothly into the top and bottom edges without a hard clipping line.
 */

export interface ProgressiveBlurScrimProps extends React.HTMLAttributes<HTMLDivElement> {
  edge: 'top' | 'bottom';
  height?: number;
  tintColor?: string;
}

const BANDS: Array<{ heightRatio: number; blurPx: number; saturate?: number }> = [
  { heightRatio: 1.0, blurPx: 0.5 },
  { heightRatio: 0.82, blurPx: 1.5 },
  { heightRatio: 0.64, blurPx: 3.5 },
  { heightRatio: 0.46, blurPx: 7 },
  { heightRatio: 0.28, blurPx: 12 },
  { heightRatio: 0.14, blurPx: 20, saturate: 1.35 },
];

export function ProgressiveBlurScrim({
  edge,
  height = 64,
  tintColor = 'var(--paper-canvas)',
  className = '',
  style,
  ...rest
}: ProgressiveBlurScrimProps) {
  const isTop = edge === 'top';
  const maskDir = isTop ? 'to bottom' : 'to top';

  return (
    <div
      aria-hidden="true"
      data-slot={`progressive-blur-${edge}`}
      className={`praxis-progressive-scrim ${className}`.trim()}
      style={{
        position: 'absolute',
        insetInline: 0,
        ...(isTop ? { top: 0 } : { bottom: 0 }),
        height: `${height}px`,
        pointerEvents: 'none',
        zIndex: 20,
        ...style,
      }}
      {...rest}
    >
      {BANDS.map((band, index) => {
        const bandHeight = Math.round(height * band.heightRatio);
        const filterStr = band.saturate
          ? `blur(${band.blurPx}px) saturate(${band.saturate})`
          : `blur(${band.blurPx}px)`;
        const maskStr = `linear-gradient(${maskDir}, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)`;
        return (
          <div
            key={index}
            style={{
              position: 'absolute',
              insetInline: 0,
              ...(isTop ? { top: 0 } : { bottom: 0 }),
              height: `${bandHeight}px`,
              backdropFilter: filterStr,
              WebkitBackdropFilter: filterStr,
              maskImage: maskStr,
              WebkitMaskImage: maskStr,
            }}
          />
        );
      })}
      {/* Warm paper feather */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `linear-gradient(${maskDir}, color-mix(in srgb, ${tintColor} 76%, transparent) 0%, color-mix(in srgb, ${tintColor} 28%, transparent) 52%, transparent 100%)`,
        }}
      />
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
  scrimHeight = 28,
  viewportRef,
  onViewportScroll,
  className = '',
  style,
  ...rest
}: ScrollBlurProps) {
  return (
    <div
      data-slot="scroll-blur"
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        height: toCssSize(height),
        maxHeight: toCssSize(maxHeight),
        ...style,
      }}
      {...rest}
    >
      <div
        ref={viewportRef}
        onScroll={onViewportScroll}
        data-slot="scroll-blur-viewport"
        style={{
          height: '100%',
          maxHeight: toCssSize(maxHeight),
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        {children}
      </div>
      <ProgressiveBlurScrim edge="top" height={scrimHeight} />
      <ProgressiveBlurScrim edge="bottom" height={scrimHeight} />
    </div>
  );
}
