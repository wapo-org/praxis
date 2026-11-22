import React from 'react';
import type { GeneratedMaps } from './displacement-map';
import { MATERIAL_RAMP, lensScale, type BaseChroma, type GlassMaterial } from './material';

export const LensFilter = React.memo(function LensFilter({
  id,
  material,
  maps,
  chroma,
}: {
  id: string;
  material: GlassMaterial;
  maps: GeneratedMaps;
  chroma: BaseChroma | null;
}) {
  const ramp = MATERIAL_RAMP[material];
  const source = chroma ? 'balanced_source' : 'SourceGraphic';
  const image = { x: 0, y: 0, width: maps.width, height: maps.height, preserveAspectRatio: 'none' };
  return (
    <svg aria-hidden="true" focusable="false" colorInterpolationFilters="sRGB" style={{ display: 'none' }}>
      <defs>
        <filter id={id}>
          {/* The page's own colour contributes luminance, never chroma. */}
          {chroma ? (
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values={`1 0 0 0 ${chroma.or.toFixed(6)} 0 1 0 0 ${chroma.og.toFixed(6)} 0 0 1 0 ${chroma.ob.toFixed(6)} 0 0 0 1 0`}
              result="balanced_source"
            />
          ) : null}
          <feGaussianBlur in={source} stdDeviation={ramp.blur} result="blurred_source" />
          {/* The frost rises toward the rim, through an elliptical mask. */}
          <feGaussianBlur in={source} stdDeviation={ramp.blur + ramp.rimBlur} result="frost_blur" />
          <feImage href={maps.frostMaskUrl} {...image} result="frost_mask" />
          <feComposite in="frost_blur" in2="frost_mask" operator="in" result="frost_rim" />
          <feBlend in="frost_rim" in2="blurred_source" mode="normal" result="frosted_source" />
          {/* The lens. */}
          <feImage href={maps.displacementUrl} {...image} result="displacement_map" />
          <feDisplacementMap
            in="frosted_source"
            in2="displacement_map"
            scale={lensScale(material, false)}
            xChannelSelector="R"
            yChannelSelector="G"
            result="displaced"
          />
          <feColorMatrix in="displaced" type="saturate" values={String(ramp.saturate)} result="displaced_saturated" />
          {/* The specular rim. */}
          <feImage href={maps.specularUrl} {...image} result="specular_layer" />
          <feComposite in="displaced_saturated" in2="specular_layer" operator="in" result="specular_saturated" />
          <feComponentTransfer in="specular_layer" result="specular_faded">
            <feFuncA type="linear" slope={ramp.specularOpacity} />
          </feComponentTransfer>
          <feBlend in="specular_saturated" in2="displaced" mode="normal" result="with_saturation" />
          <feBlend in="specular_faded" in2="with_saturation" mode="normal" />
        </filter>
      </defs>
    </svg>
  );
});
