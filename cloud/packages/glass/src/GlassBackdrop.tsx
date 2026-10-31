import React from 'react';
import { motion, type MotionValue } from 'framer-motion';
import { type MaterialSpec } from './engine-detect';
import { useGlassRuntime } from './glass-store';
import { registerRefraction } from './webgl/runtime';
import type { SurfaceParams } from './webgl/renderer';
const FROST_MASK_MID =
  'radial-gradient(closest-side, rgba(0,0,0,0.18) 54%, rgba(0,0,0,0.88) 88%, rgba(0,0,0,1) 100%)';
const FROST_MASK_RIM =
  'radial-gradient(closest-side, rgba(0,0,0,0) 68%, rgba(0,0,0,0.72) 90%, rgba(0,0,0,1) 100%)';
export function GlassBackdrop({
  reduced,
  svg,
  cssRadius,
  filterId,
  ramp,
  frost,
  sheenBackground,
  insetShadow,
  webgl,
  rootRef,
  ...params
}: SurfaceParams & {
  reduced: boolean;
  svg: boolean;
  cssRadius: string;
  filterId: string;
  ramp: MaterialSpec;
  sheenBackground: string;
  insetShadow: MotionValue<string>;
  webgl: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const setStrategy = useGlassRuntime((s) => s.setStrategy);
  React.useEffect(() => {
    if (!webgl || reduced || !rootRef.current || !canvas.current) return;
    return registerRefraction(rootRef.current, canvas.current, { ...params, frost }, () =>
      setStrategy('progressive-frost'),
    );
  }, [
    webgl,
    reduced,
    params.material,
    params.intensity,
    params.radius,
    params.rim,
    frost,
    setStrategy,
  ]);
  return (
    <>
      {reduced ? (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: cssRadius,
            backgroundColor: 'var(--paper-card)',
            border: '1px solid var(--paper-hairline)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      ) : svg ? (
        /* Chromium SVG displacement + progressive frost tier */
        <>
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: cssRadius,
              backdropFilter: `url(#${filterId}) blur(${frost === 'none' ? 0 : ramp.frostCore}px)`,
              WebkitBackdropFilter: `url(#${filterId}) blur(${frost === 'none' ? 0 : ramp.frostCore}px)`,
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
          <motion.div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: cssRadius,
              backgroundColor: 'var(--glass-tint, rgba(251, 251, 249, 0.72))',
              backgroundImage: sheenBackground,
              boxShadow: insetShadow,
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        </>
      ) : (
        /* WebKit / Firefox 3-layer progressive frost tier */
        <>
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: cssRadius,
              backdropFilter: `blur(${frost === 'none' ? 0 : ramp.frostCore}px)`,
              WebkitBackdropFilter: `blur(${frost === 'none' ? 0 : ramp.frostCore}px)`,
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
          {frost === 'progressive' ? (
            <>
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: cssRadius,
                  backdropFilter: `blur(${ramp.frostMid}px)`,
                  WebkitBackdropFilter: `blur(${ramp.frostMid}px)`,
                  maskImage: FROST_MASK_MID,
                  WebkitMaskImage: FROST_MASK_MID,
                  pointerEvents: 'none',
                  zIndex: 0,
                }}
              />
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: cssRadius,
                  backdropFilter: `blur(${ramp.frostRim}px) saturate(${ramp.saturate}%)`,
                  WebkitBackdropFilter: `blur(${ramp.frostRim}px) saturate(${ramp.saturate}%)`,
                  maskImage: FROST_MASK_RIM,
                  WebkitMaskImage: FROST_MASK_RIM,
                  pointerEvents: 'none',
                  zIndex: 0,
                }}
              />
            </>
          ) : null}
          <motion.div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: cssRadius,
              backgroundColor: 'var(--glass-tint, rgba(251, 251, 249, 0.72))',
              backgroundImage: sheenBackground,
              boxShadow: insetShadow,
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        </>
      )}

      {webgl && !reduced ? (
        <canvas
          ref={canvas}
          data-glass-webgl="pending"
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            borderRadius: cssRadius,
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      ) : null}
    </>
  );
}
