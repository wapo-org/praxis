/**
 * Runtime displacement-map & specular-rim generator — exact port of kube.io
 * liquid-glass-css-svg from wapo.dp/src/lib/glass/displacement-map.ts.
 */

import type { MaterialLevel } from './engine-detect';

export const BAKED_PROFILES: Record<MaterialLevel, number[]> = {
  ultrathin: [1.0, 0.9403, 0.791, 0.597, 0.4776, 0.3582, 0.209, 0.0896, 0.0],
  thin: [
    1.0, 0.9394, 0.8283, 0.697, 0.6263, 0.5556, 0.4848, 0.4444, 0.404,
    0.3535, 0.3232, 0.2828, 0.2626, 0.2424, 0.2121, 0.1919, 0.1818,
    0.1616, 0.1414, 0.1313, 0.1212, 0.1111, 0.0909, 0.0909, 0.0808,
    0.0707, 0.0606, 0.0505, 0.0505, 0.0404, 0.0404, 0.0303, 0.0303,
    0.0202, 0.0202, 0.0202, 0.0202, 0.0101, 0.0101, 0.0101, 0.0101,
    0.0101, 0.0,
  ],
  regular: [
    1.0, 1.0, 0.874, 0.7795, 0.6614, 0.5906, 0.5118, 0.4646, 0.4016,
    0.3543, 0.3228, 0.2835, 0.2598, 0.2283, 0.2126, 0.189, 0.1732,
    0.1496, 0.1339, 0.126, 0.1102, 0.0945, 0.0866, 0.0787, 0.0709,
    0.0551, 0.0551, 0.0472, 0.0394, 0.0315, 0.0315, 0.0236, 0.0236,
    0.0157, 0.0157, 0.0157, 0.0079, 0.0079, 0.0079, 0.0079, 0.0,
  ],
  thick: [
    1.0, 1.0, 0.9104, 0.8209, 0.7313, 0.6567, 0.5821, 0.5224, 0.4627,
    0.4179, 0.3731, 0.3358, 0.2985, 0.2687, 0.2388, 0.2164, 0.194,
    0.1716, 0.1567, 0.1418, 0.1269, 0.1119, 0.1045, 0.0896, 0.0821,
    0.0746, 0.0672, 0.0597, 0.0522, 0.0448, 0.0373, 0.0299, 0.0224,
    0.0149, 0.0075, 0.0,
  ],
};

export interface DisplacementMapsResult {
  displacementUrl: string;
  specularUrl: string;
  frostMaskUrl: string;
}

const mapCache = new Map<string, DisplacementMapsResult>();

function createSvgMaps(params: {
  width: number;
  height: number;
  radius: number;
  bezel: number;
  material: MaterialLevel;
}): DisplacementMapsResult {
  const w = Math.max(8, Math.round(params.width));
  const h = Math.max(8, Math.round(params.height));
  const r = Math.max(2, Math.min(Math.round(params.radius), Math.floor(Math.min(w, h) / 2)));
  const bezel = Math.max(2, Math.min(Math.round(params.bezel), Math.floor(Math.min(w, h) / 2)));

  // Use Canvas 2D when available on client for pixel-exact kube.io ring map,
  // with SVG data-URI fallback for non-canvas test environments (jsdom).
  if (typeof document !== 'undefined') {
    try {
      const dispCanvas = document.createElement('canvas');
      dispCanvas.width = w;
      dispCanvas.height = h;
      const dCtx = dispCanvas.getContext('2d');

      const specCanvas = document.createElement('canvas');
      specCanvas.width = w;
      specCanvas.height = h;
      const sCtx = specCanvas.getContext('2d');

      if (dCtx && sCtx) {
        const dImg = dCtx.createImageData(w, h);
        const sImg = sCtx.createImageData(w, h);
        const dBuf = new Uint32Array(dImg.data.buffer);
        const sBuf = new Uint32Array(sImg.data.buffer);

        // Neutral displacement fill: R=128, G=128, B=0, A=255 (0xFF008080 in little-endian)
        dBuf.fill(0xff008080);
        sBuf.fill(0x00000000);

        const profile = BAKED_PROFILES[params.material] ?? BAKED_PROFILES.regular;
        const innerR = Math.max(0, r - bezel);
        const innerR2 = innerR * innerR;
        const outerR2 = (r + 1) * (r + 1);
        const rimBand = 2.5;
        const lightX = Math.cos((-60 * Math.PI) / 180);
        const lightY = Math.sin((-60 * Math.PI) / 180);

        const xLeft = r;
        const xRight = w - r;
        const yTop = r;
        const yBottom = h - r;

        for (let y = 0; y < h; y++) {
          const cy = y < yTop ? yTop : y > yBottom ? yBottom : y;
          const dy = y - cy;
          const dy2 = dy * dy;
          const rowOffset = y * w;

          for (let x = 0; x < w; x++) {
            const cx = x < xLeft ? xLeft : x > xRight ? xRight : x;
            const dx = x - cx;
            const d2 = dx * dx + dy2;

            if (d2 >= innerR2 && d2 <= outerR2) {
              const dist = Math.sqrt(d2);
              const depth = r - dist;
              const fade = depth < 0 ? Math.max(0, 1 + depth) : 1;

              if (depth >= -1 && depth < bezel && dist > 0.0001) {
                const idx = Math.min(
                  profile.length - 1,
                  Math.max(0, Math.floor(( Math.max(0, depth) / bezel) * profile.length)),
                );
                const mag = (profile[idx] ?? 0) * fade;
                const nx = dx / dist;
                const ny = dy / dist;
                // Displace inward along normal
                const red = Math.max(0, Math.min(255, Math.round(128 - nx * mag * 127)));
                const green = Math.max(0, Math.min(255, Math.round(128 - ny * mag * 127)));
                dBuf[rowOffset + x] = (255 << 24) | (0 << 16) | (green << 8) | red;

                // Specular rim along outer 2.5px
                if (depth <= rimBand) {
                  const t = Math.max(0, Math.min(1, Math.max(0, depth) / rimBand));
                  const semi = Math.sqrt(Math.max(0, 1 - Math.pow(1 - t * 2, 2)));
                  const ndotl = Math.abs(nx * lightX + ny * lightY);
                  const s = ndotl * semi;
                  const val = Math.max(0, Math.min(255, Math.round(255 * s)));
                  const alpha = Math.max(0, Math.min(255, Math.round(255 * s * s * fade)));
                  sBuf[rowOffset + x] = (alpha << 24) | (val << 16) | (val << 8) | val;
                }
              }
            }
          }
        }

        dCtx.putImageData(dImg, 0, 0);
        sCtx.putImageData(sImg, 0, 0);

        const displacementUrl = dispCanvas.toDataURL('image/png');
        const specularUrl = specCanvas.toDataURL('image/png');
        const frostMaskUrl = specularUrl;
        return { displacementUrl, specularUrl, frostMaskUrl };
      }
    } catch {
      // Fallback below when canvas context is unavailable (e.g. unit tests)
    }
  }

  const svgDisp = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="${r}" fill="rgb(128,128,0)" stroke="rgb(164,96,0)" stroke-width="${bezel}"/></svg>`;
  const svgSpec = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${Math.max(1, r - 1)}" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="1.5"/></svg>`;
  return {
    displacementUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svgDisp)}`,
    specularUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svgSpec)}`,
    frostMaskUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svgSpec)}`,
  };
}

export function generateDisplacementMaps(params: {
  width: number;
  height: number;
  radius: number;
  bezel: number;
  material: MaterialLevel;
}): DisplacementMapsResult {
  const w = Math.max(8, Math.round(params.width));
  const h = Math.max(8, Math.round(params.height));
  const r = Math.max(2, Math.round(params.radius));
  const b = Math.max(2, Math.round(params.bezel));
  const key = `${params.material}:${w}x${h}:r${r}:b${b}`;

  const cached = mapCache.get(key);
  if (cached) return cached;

  const generated = createSvgMaps({ width: w, height: h, radius: r, bezel: b, material: params.material });
  if (mapCache.size > 64) {
    const firstKey = mapCache.keys().next().value;
    if (firstKey) mapCache.delete(firstKey);
  }
  mapCache.set(key, generated);
  return generated;
}
