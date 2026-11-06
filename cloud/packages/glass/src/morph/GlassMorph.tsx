import { usePresence } from 'framer-motion';
import React from 'react';
import { GlassSurface, type GlassSurfaceProps } from '../GlassSurface';
import { LensFilter } from '../LensFilter';
import { glassTier, useBaseChroma } from '../material';
import { MORPH, useReducedMotion } from '../motion';
import { createMorph } from './engine';
import styles from './morph.module.css';
import { subscribeTransit, transitMaps, warmTransit } from './transit';

export interface GlassMorphProps extends Omit<GlassSurfaceProps, 'ref' | 'radius' | 'initial' | 'animate' | 'exit' | 'transition'> {
  /** The button this glass grows out of and returns to. */
  source: () => HTMLElement | null;
  radius: number;
  /** False until the shell has its final position; the morph starts from the first true. */
  ready?: boolean;
  /** Ref and props of the positioned outer element. */
  shellRef?: React.Ref<HTMLDivElement>;
  shellProps?: React.HTMLAttributes<HTMLDivElement>;
  surfaceRef?: React.Ref<HTMLDivElement>;
}

/** The rim bending the arriving rows: fixed strength, one prebuilt map. */
const BendFilter = React.memo(function BendFilter({ id, url, width, height }: { id: string; url: string; width: number; height: number }) {
  return (
    <svg aria-hidden="true" focusable="false" colorInterpolationFilters="sRGB" style={{ display: 'none' }}>
      <defs>
        <filter id={id} x="0" y="0" width="100%" height="100%">
          <feImage href={url} x={0} y={0} width={width} height={height} preserveAspectRatio="none" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={MORPH.content.bend} xChannelSelector="R" yChannelSelector="G" result="bent" />
          <feGaussianBlur in="bent" stdDeviation={MORPH.content.blur} result="soft" />
          {/* Blur thins small type to a grey; the rows should arrive inky, as they do on iOS. */}
          <feComponentTransfer in="soft">
            <feFuncA type="linear" slope={MORPH.content.ink} />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
  );
});

function assign<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as React.MutableRefObject<T | null>).current = value;
}

/**
 * A floating panel whose glass is one piece that changes shape: it grows out of its
 * button and goes back into it (DESIGN.md, Menu morph). Mount it under AnimatePresence;
 * it holds its own exit until the glass is back at the button, and a reopen during the
 * close reverses from wherever it is.
 */
export function GlassMorph({ source, radius, ready = true, shellRef, shellProps, surfaceRef, material = 'thick', children, ...surface }: GlassMorphProps) {
  const shell = React.useRef<HTMLDivElement | null>(null);
  const root = React.useRef<HTMLDivElement | null>(null);
  const body = React.useRef<HTMLDivElement | null>(null);
  const sharp = React.useRef<HTMLDivElement | null>(null);
  const transit = React.useRef<HTMLSpanElement | null>(null);
  const flash = React.useRef<HTMLSpanElement | null>(null);
  const [isPresent, safeToRemove] = usePresence();
  const reduced = useReducedMotion();
  const reducedRef = React.useRef(reduced);
  reducedRef.current = reduced;
  const sourceRef = React.useRef(source);
  sourceRef.current = source;
  const removeRef = React.useRef(safeToRemove);
  removeRef.current = safeToRemove;
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);
  const maps = React.useSyncExternalStore(subscribeTransit, transitMaps, () => null);
  const chroma = useBaseChroma();
  const filterId = `glass-morph-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const tier = glassTier();
  const bendId = `${filterId}-bend`;
  const bendIdRef = React.useRef<string | null>(null);
  bendIdRef.current = tier === 'svg' && maps ? bendId : null;

  const [morph] = React.useState(() =>
    createMorph({
      layers: () => {
        if (!shell.current || !root.current || !body.current || !sharp.current) return null;
        return {
          shell: shell.current,
          surface: root.current,
          body: body.current,
          sharp: sharp.current,
          lens: root.current.querySelector<HTMLElement>(':scope > [data-glass-lens]'),
          transit: transit.current,
          flash: flash.current,
          blurredClass: styles.blurred!,
          bendFilter: bendIdRef.current,
          glyphClass: styles.glyph!,
        };
      },
      trigger: () => sourceRef.current(),
      radius,
      reduced: () => reducedRef.current,
      onSize: (width, height) =>
        setSize((old) => (old && old.width === width && old.height === height ? old : { width, height })),
    }),
  );

  React.useEffect(() => {
    warmTransit();
    morph.resume();
    return () => morph.destroy();
  }, [morph]);

  const opened = React.useRef(false);
  React.useLayoutEffect(() => {
    if (!isPresent) {
      opened.current = false;
      morph.close(() => removeRef.current?.());
    } else if (ready && !opened.current) {
      opened.current = true;
      morph.open();
    }
  }, [isPresent, ready, morph]);

  const setShell = React.useCallback(
    (node: HTMLDivElement | null) => {
      shell.current = node;
      assign(shellRef, node);
    },
    [shellRef],
  );
  const setRoot = React.useCallback(
    (node: HTMLDivElement | null) => {
      root.current = node;
      assign(surfaceRef, node);
    },
    [surfaceRef],
  );

  const lens = tier === 'svg' && maps && size;
  return (
    <div ref={setShell} {...shellProps}>
      <GlassSurface ref={setRoot} radius={radius} material={material} {...surface}>
        {lens ? <LensFilter id={filterId} material="regular" maps={{ ...maps, width: size.width, height: size.height }} chroma={chroma} /> : null}
        {lens ? <BendFilter id={bendId} url={maps.displacementUrl} width={size.width} height={size.height} /> : null}
        <span
          ref={transit}
          aria-hidden="true"
          data-glass-transit=""
          className={styles.transit}
          style={lens ? { backdropFilter: `url(#${filterId})`, WebkitBackdropFilter: `url(#${filterId})` } : undefined}
        />
        <span ref={flash} aria-hidden="true" className={styles.flash} />
        <div ref={body} data-morph-body="" className={styles.body}>
          <div ref={sharp} className={styles.sharp}>
            {children as React.ReactNode}
          </div>
        </div>
      </GlassSurface>
    </div>
  );
}
