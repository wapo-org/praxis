import { GlassBackdrop } from './GlassBackdrop';
import React from 'react';
import {
  animate,
  motion,
  useMotionTemplate,
  useMotionValue,
  useSpring,
  useTransform,
} from 'framer-motion';
import {
  MATERIAL_RAMP,
  SHAPE_RADIUS,
  INTENSITY_BASE_SCALE,
  FINISH_DEFAULTS,
  prefersReducedMotion,
  type GlassShape,
  type ResolvedFinish,
} from './engine-detect';
import {
  useGlassRuntime,
  useGlassMaterial,
  useGlassOverrides,
  type GlassMaterialControls,
} from './glass-store';
import { generateDisplacementMaps } from './displacement-map';

export interface GlassSurfaceProps
  extends
    Omit<
      React.HTMLAttributes<HTMLDivElement>,
      'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'
    >,
    GlassMaterialControls {
  shape?: GlassShape;
  radius?: number;
  interactive?: boolean;
  children?: React.ReactNode;
}

export const GlassSurface = React.forwardRef<HTMLDivElement, GlassSurfaceProps>(
  function GlassSurface(
    {
      shape = 'card',
      radius,
      material: propMaterial,
      intensity: propIntensity = 'medium',
      refraction: propRefraction = true,
      frost: propFrost = 'progressive',
      finish: propFinish,
      backdrop: propBackdrop = 'auto',
      stretchable: propStretchable = false,
      bounce: propBounce = false,
      spotlight: propSpotlight = true,
      interactive = false,
      className = '',
      style,
      children,
      onPointerEnter,
      onPointerMove,
      onPointerLeave,
      onPointerDown,
      onPointerUp,
      ...restProps
    },
    forwardedRef,
  ) {
    const ctx = useGlassMaterial();
    const overrides = useGlassOverrides();
    const registerFilter = useGlassRuntime((s) => s.registerFilter);
    const unregisterFilter = useGlassRuntime((s) => s.unregisterFilter);

    const material = overrides.material ?? propMaterial ?? ctx.level ?? 'regular';
    const intensity = overrides.intensity ?? propIntensity;
    const refraction = overrides.refraction ?? propRefraction;
    const frost = overrides.frost ?? propFrost;
    const backdrop = overrides.backdrop ?? propBackdrop;
    const stretchable = overrides.stretchable ?? propStretchable;
    const bounce = overrides.bounce ?? propBounce;
    const spotlight = overrides.spotlight ?? propSpotlight;

    const finish: ResolvedFinish = {
      ...FINISH_DEFAULTS,
      ...propFinish,
      ...overrides.finish,
    };

    const ramp = MATERIAL_RAMP[material];
    const shapeRadius =
      shape === 'free' ? (radius ?? SHAPE_RADIUS.free) : (radius ?? SHAPE_RADIUS[shape]);
    const cssRadius = shape === 'capsule' ? '9999px' : `${shapeRadius}px`;

    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const setRefs = React.useCallback(
      (node: HTMLDivElement | null) => {
        rootRef.current = node;
        if (typeof forwardedRef === 'function') {
          forwardedRef(node);
        } else if (forwardedRef) {
          forwardedRef.current = node;
        }
      },
      [forwardedRef],
    );

    const [geo, setGeo] = React.useState<{ w: number; h: number }>({ w: 240, h: 52 });

    React.useEffect(() => {
      const el = rootRef.current;
      if (!el) return;
      const measure = () => {
        const w = el.offsetWidth || 240;
        const h = el.offsetHeight || 52;
        if (w >= 8 && h >= 8) {
          setGeo((prev) =>
            Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h },
          );
        }
      };
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
      }
      return undefined;
    }, []);

    const isReducedTransparency = ctx.strategy === 'reduced-transparency';
    const isSvgStrategy =
      !isReducedTransparency &&
      refraction &&
      (backdrop === 'svg' || (backdrop === 'auto' && ctx.strategy === 'svg-displacement'));

    const reactId = React.useId();
    const filterId = `glass-fx-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

    const [held, setHeld] = React.useState(false);

    const scaleRatioTarget = useMotionValue(
      ramp.refraction * INTENSITY_BASE_SCALE[intensity] * 0.8,
    );
    const scaleRatio = useSpring(scaleRatioTarget, { stiffness: 250, damping: 14 });

    React.useEffect(() => {
      scaleRatioTarget.set(ramp.refraction * INTENSITY_BASE_SCALE[intensity] * (held ? 1.0 : 0.8));
    }, [scaleRatioTarget, ramp.refraction, intensity, held]);

    React.useEffect(() => {
      if (!isSvgStrategy) {
        unregisterFilter(filterId);
        return;
      }
      const r = shape === 'capsule' ? Math.min(geo.w, geo.h) / 2 : shapeRadius;
      const maps = generateDisplacementMaps({
        width: geo.w,
        height: geo.h,
        radius: r,
        bezel: ramp.bezel,
        material,
      });
      const currentScale =
        ramp.maxDisplacement * ramp.refraction * INTENSITY_BASE_SCALE[intensity] * (held ? 1 : 0.8);

      registerFilter(filterId, {
        id: filterId,
        width: geo.w,
        height: geo.h,
        displacementUrl: maps.displacementUrl,
        specularUrl: maps.specularUrl,
        scale: currentScale,
        specularOpacity: ramp.specularOpacity * finish.rim,
        saturate: ramp.saturate,
      });

      return () => unregisterFilter(filterId);
    }, [
      isSvgStrategy,
      filterId,
      geo.w,
      geo.h,
      shape,
      shapeRadius,
      ramp.bezel,
      ramp.maxDisplacement,
      ramp.refraction,
      ramp.specularOpacity,
      ramp.saturate,
      material,
      intensity,
      held,
      finish.rim,
      registerFilter,
      unregisterFilter,
    ]);

    // Shadow & inset finish springs
    const shadowXTarget = useMotionValue(0);
    const shadowYTarget = useMotionValue(4);
    const shadowBlurTarget = useMotionValue(12);
    const shadowAlphaTarget = useMotionValue(0.12);
    const insetAlphaTarget = useMotionValue(0.18);

    const shadowX = useSpring(shadowXTarget, { stiffness: 340, damping: 30 });
    const shadowY = useSpring(shadowYTarget, { stiffness: 340, damping: 30 });
    const shadowBlur = useSpring(shadowBlurTarget, { stiffness: 340, damping: 30 });
    const shadowAlpha = useSpring(shadowAlphaTarget, { stiffness: 220, damping: 24 });
    const insetAlpha = useSpring(insetAlphaTarget, { stiffness: 220, damping: 24 });

    React.useEffect(() => {
      shadowXTarget.set(held ? 2 : 0);
      shadowYTarget.set(held ? 12 : 4);
      shadowBlurTarget.set(held ? 24 : 12);
      shadowAlphaTarget.set(held ? 0.18 : 0.1);
      insetAlphaTarget.set(held ? 0.24 : 0.16);
    }, [held, shadowXTarget, shadowYTarget, shadowBlurTarget, shadowAlphaTarget, insetAlphaTarget]);

    const outerShadow = useTransform(
      [shadowX, shadowY, shadowBlur, shadowAlpha],
      (values: number[]) => {
        const [x = 0, y = 4, blur = 12, alpha = 0.1] = values;
        return `${x}px ${y}px ${blur}px rgba(0,0,0,${(alpha * finish.shadow).toFixed(4)})`;
      },
    );

    const insetShadow = useTransform([shadowX, shadowY, insetAlpha], (values: number[]) => {
      const [x = 0, y = 4, inset = 0.16] = values;
      const parts = [
        `inset ${x / 2}px ${y / 2}px 20px rgba(0,0,0,${(inset * finish.inner * 0.45).toFixed(4)})`,
        `inset ${-x / 2}px ${-y / 2}px 20px rgba(255,255,255,${(inset * finish.inner * 0.65).toFixed(4)})`,
        `inset 0 1px 0 0 rgba(255,255,255,${(0.52 * finish.rim).toFixed(3)})`,
        `inset 0 -1px 0 0 rgba(255,255,255,${(0.22 * finish.rim).toFixed(3)})`,
      ];
      if (finish.border > 0) {
        parts.push(
          `inset 0 0 0 1px rgba(255,255,255,${(0.18 * finish.border).toFixed(3)})`,
          `inset 0 0 0 1px rgba(21,20,15,${(0.08 * finish.border).toFixed(3)})`,
        );
      }
      return parts.join(', ');
    });

    // Pointer-tracked radial spotlight
    const spotX = useMotionValue(0);
    const spotY = useMotionValue(0);
    const spotOpacity = useMotionValue(0);
    const spotBackground = useMotionTemplate`radial-gradient(circle 132px at ${spotX}px ${spotY}px, rgba(21,20,15,0.08), rgba(21,20,15,0) 68%)`;

    // 2D Elastic rubber-band pull
    const pullX = useMotionValue(0);
    const pullY = useMotionValue(0);
    const springPullX = useSpring(pullX, { stiffness: 420, damping: 28 });
    const springPullY = useSpring(pullY, { stiffness: 420, damping: 28 });
    const dragOriginRef = React.useRef<{ x: number; y: number } | null>(null);

    const handlePointerEnter = (e: React.PointerEvent<HTMLDivElement>) => {
      onPointerEnter?.(e);
      if (spotlight && e.pointerType === 'mouse' && !prefersReducedMotion()) {
        const r = rootRef.current?.getBoundingClientRect();
        if (r) {
          spotX.set(e.clientX - r.left);
          spotY.set(e.clientY - r.top);
        }
        animate(spotOpacity, 1, { duration: 0.22 });
      }
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      onPointerMove?.(e);
      if (spotlight && e.pointerType === 'mouse' && !prefersReducedMotion()) {
        const r = rootRef.current?.getBoundingClientRect();
        if (r) {
          spotX.set(e.clientX - r.left);
          spotY.set(e.clientY - r.top);
        }
      }
      if (stretchable && dragOriginRef.current) {
        const dx = e.clientX - dragOriginRef.current.x;
        const dy = e.clientY - dragOriginRef.current.y;
        const bx = 18;
        const by = 48;
        pullX.set(bx * Math.tanh(dx / (bx * 2.2)));
        pullY.set(by * Math.tanh(dy / (by * 2.2)));
      }
    };

    const handlePointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
      onPointerLeave?.(e);
      setHeld(false);
      dragOriginRef.current = null;
      pullX.set(0);
      pullY.set(0);
      animate(spotOpacity, 0, { duration: 0.32 });
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      onPointerDown?.(e);
      if (interactive || bounce || stretchable) {
        setHeld(true);
      }
      if (stretchable) {
        dragOriginRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      onPointerUp?.(e);
      setHeld(false);
      dragOriginRef.current = null;
      pullX.set(0);
      pullY.set(0);
    };

    const sheenBackground = `linear-gradient(135deg, rgba(255,255,255,${(0.24 * finish.sheen).toFixed(3)}) 0%, rgba(255,255,255,0) 48%, rgba(255,255,255,${(0.08 * finish.sheen).toFixed(3)}) 100%)`;

    return (
      <motion.div
        ref={setRefs}
        data-glass-surface=""
        data-glass-strategy={ctx.strategy}
        data-glass-material={material}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        style={{
          position: 'relative',
          borderRadius: cssRadius,
          boxShadow: outerShadow,
          x: stretchable ? springPullX : undefined,
          y: stretchable ? springPullY : undefined,
          scale: bounce && held ? 0.97 : 1,
          ...style,
        }}
        className={`praxis-glass-surface ${className}`.trim()}
        {...restProps}
      >
        <GlassBackdrop
          reduced={isReducedTransparency}
          svg={isSvgStrategy}
          cssRadius={cssRadius}
          filterId={filterId}
          ramp={ramp}
          frost={frost}
          sheenBackground={sheenBackground}
          insetShadow={insetShadow}
          webgl={ctx.strategy === 'webgl-refraction' && refraction && backdrop === 'auto'}
          rootRef={rootRef}
          material={material}
          intensity={intensity}
          radius={shape === 'capsule' ? Math.min(geo.w, geo.h) / 2 : shapeRadius}
          rim={finish.rim}
        />

        {/* Pointer-tracked spotlight */}
        {spotlight ? (
          <motion.div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: cssRadius,
              background: spotBackground,
              opacity: spotOpacity,
              pointerEvents: 'none',
              zIndex: 2,
            }}
          />
        ) : null}

        {/* Content layer */}
        <div style={{ position: 'relative', zIndex: 10, width: '100%' }}>{children}</div>
      </motion.div>
    );
  },
);
