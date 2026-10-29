import React from 'react';
import { useGlassRuntime, type FilterSpec } from './glass-store';

/**
 * GlassFilters — Page-level SVG displacement & specular filter definitions
 * ported from wapo.dp/src/lib/glass/GlassFilters.tsx.
 */
export function GlassFilters() {
  const filters = useGlassRuntime((s) => s.filters);
  const entries = Object.entries(filters);
  if (entries.length === 0) return null;

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      colorInterpolationFilters="sRGB"
      style={{
        position: 'absolute',
        width: 0,
        height: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <defs>
        {entries.map(([key, spec]) => (
          <GlassDisplacementFilterDef key={key} id={spec.id} spec={spec} />
        ))}
      </defs>
    </svg>
  );
}

function GlassDisplacementFilterDef({ id, spec }: { id: string; spec: FilterSpec }) {
  const w = Math.max(1, Math.round(spec.width));
  const h = Math.max(1, Math.round(spec.height));
  const bleed = 2;

  return (
    <filter
      id={id}
      filterUnits="userSpaceOnUse"
      x={-bleed}
      y={-bleed}
      width={w + bleed * 2}
      height={h + bleed * 2}
      colorInterpolationFilters="sRGB"
    >
      <feImage
        href={spec.displacementUrl}
        x="0"
        y="0"
        width={w}
        height={h}
        preserveAspectRatio="none"
        result="displacement_map"
      />
      <feDisplacementMap
        in="SourceGraphic"
        in2="displacement_map"
        scale={spec.scale}
        xChannelSelector="R"
        yChannelSelector="G"
        result="displaced"
      />
      <feColorMatrix
        in="displaced"
        type="saturate"
        values={String(Math.max(0, spec.saturate) / 100)}
        result="saturated"
      />
      {spec.specularOpacity > 0 ? (
        <>
          <feImage
            href={spec.specularUrl}
            x="0"
            y="0"
            width={w}
            height={h}
            preserveAspectRatio="none"
            result="specular_map"
          />
          <feComponentTransfer in="specular_map" result="specular_scaled">
            <feFuncR type="linear" slope={spec.specularOpacity} />
            <feFuncG type="linear" slope={spec.specularOpacity} />
            <feFuncB type="linear" slope={spec.specularOpacity} />
          </feComponentTransfer>
          <feBlend in="saturated" in2="specular_scaled" mode="screen" />
        </>
      ) : null}
    </filter>
  );
}
