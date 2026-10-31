// Shader port from wapo.dp: quartic bezel, Snell refraction, Poisson frost and specular rim.
export const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const FRAG_SRC = `
precision highp float;
varying vec2 vUv;

uniform vec2 uResolution;      // backdrop rect size in px (reference: viewport)
uniform vec2 uSurfaceOrigin;   // this canvas's top-left inside that rect, y down
uniform vec2 uSurfaceSize;     // this canvas's size in px
uniform vec2 uGlassCenter;
uniform vec2 uGlassSize;
uniform float uRadius;
uniform float uBezel;
uniform float uThickness;
uniform float uIOR;
uniform float uBlur;
uniform float uFrost;          // progressive frost rim radius, px (0 = off)
uniform float uFrostSat;       // rim-band saturate, CSS semantics (1 = off)
uniform float uSpecular;
uniform float uTint;
uniform float uShadow;
uniform sampler2D uBgTex;
uniform float uBgAspect;
uniform float uHasTex;
uniform vec3 uBase;

float sdRoundedRect(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float surfaceHeight(float t) {
  float s = 1.0 - t;
  return pow(1.0 - s*s*s*s, 0.25);
}

vec3 sampleBg(vec2 screenUV) {
  if (uHasTex < 0.5) return uBase;
  float screenAspect = uResolution.x / uResolution.y;
  vec2 uv = screenUV;
  if (uBgAspect > screenAspect) {
    float s = screenAspect / uBgAspect;
    uv.x = uv.x * s + (1.0 - s) * 0.5;
  } else {
    float s = uBgAspect / screenAspect;
    uv.y = uv.y * s + (1.0 - s) * 0.5;
  }
  uv.y = 1.0 - uv.y;
  return texture2D(uBgTex, uv).rgb;
}

vec3 sampleBgBlurred(vec2 uv, float radius) {
  if (radius < 0.5) return sampleBg(uv);
  vec3 sum = vec3(0.0);
  vec2 px = 1.0 / uResolution;
  vec2 offsets[16];
  offsets[0]  = vec2(-0.94201, -0.39906);
  offsets[1]  = vec2( 0.94558, -0.76890);
  offsets[2]  = vec2(-0.09418, -0.92938);
  offsets[3]  = vec2( 0.34495,  0.29387);
  offsets[4]  = vec2(-0.91588, -0.45771);
  offsets[5]  = vec2(-0.81544,  0.48568);
  offsets[6]  = vec2(-0.38277, -0.56071);
  offsets[7]  = vec2(-0.12675,  0.84686);
  offsets[8]  = vec2( 0.89642,  0.41254);
  offsets[9]  = vec2( 0.18150, -0.30020);
  offsets[10] = vec2(-0.01445, -0.16001);
  offsets[11] = vec2( 0.59614,  0.71118);
  offsets[12] = vec2( 0.49742, -0.47280);
  offsets[13] = vec2( 0.80685,  0.04588);
  offsets[14] = vec2(-0.32490, -0.03965);
  offsets[15] = vec2(-0.60975,  0.06566);
  for (int i = 0; i < 16; i++) {
    sum += sampleBg(uv + offsets[i] * radius * px);
  }
  // Progressive frost runs the radius up past the reference's 12px, where a
  // single 16-tap Poisson disc shows speckle. A second half-radius ring
  // smooths it for the price of 8 taps, and only while frost is active.
  if (radius > 4.0) {
    for (int i = 0; i < 16; i += 2) {
      sum += sampleBg(uv + offsets[i] * radius * 0.5 * px);
    }
    return sum / 24.0;
  }
  return sum / 16.0;
}

void main() {
  vec2 screenPx = uSurfaceOrigin + vec2(vUv.x, 1.0 - vUv.y) * uSurfaceSize;
  vec2 p = screenPx - uGlassCenter;
  vec2 halfSize = uGlassSize * 0.5;

  float sd = sdRoundedRect(p, halfSize, uRadius);

  if (sd > 0.0) {
    float shadowFalloff = exp(-sd * sd / 800.0);
    float shadowAlpha = uShadow * shadowFalloff * 0.6;
    gl_FragColor = vec4(0.0, 0.0, 0.0, shadowAlpha);
    return;
  }

  float distFromEdge = -sd;
  float bezel = max(1.0, min(uBezel, min(uRadius, min(halfSize.x, halfSize.y)) - 1.0));
  float t = clamp(distFromEdge / bezel, 0.0, 1.0);

  // Progressive frost — candidate C's band ratios, measured on the ellipse
  // inscribed in the surface (the shader twin of the CSS tier's
  // radial-gradient(closest-side) masks): 0 over the core, rising through
  // the 0.55..0.85 mid band and the 0.78..0.98 rim band to the full radius.
  float dNorm = length(abs(p) / halfSize);
  float frostMid = smoothstep(0.55, 0.85, dNorm);
  float frostRim = smoothstep(0.78, 0.98, dNorm);
  float frostRadius = uFrost * (0.1 + 0.3 * frostMid + 0.6 * frostRim);

  float h = surfaceHeight(t);
  float dt = 0.001;
  float h2 = surfaceHeight(min(t + dt, 1.0));
  float dh = (h2 - h) / dt;

  float slopeAngle = atan(dh * (uThickness / bezel));
  float sinR = sin(slopeAngle) / uIOR;
  sinR = clamp(sinR, -1.0, 1.0);
  float thetaR = asin(sinR);
  float displacement = h * uThickness * (tan(slopeAngle) - tan(thetaR));

  vec2 grad;
  float eps = 0.5;
  grad.x = sdRoundedRect(p + vec2(eps, 0.0), halfSize, uRadius) - sd;
  grad.y = sdRoundedRect(p + vec2(0.0, eps), halfSize, uRadius) - sd;
  grad /= max(length(grad), 0.0001);

  vec2 offset = -grad * displacement / uResolution;

  vec2 screenUV = screenPx / uResolution;
  vec2 refractedUV = screenUV + offset;

  vec3 color = sampleBgBlurred(refractedUV, uBlur + frostRadius);

  // Rim-band saturate — CSS frost semantics: the colour strengthens toward
  // the edge and the core is left alone (mix weight 1 in the centre).
  float luma = dot(color, vec3(0.213, 0.715, 0.072));
  color = mix(vec3(luma), color, mix(1.0, uFrostSat, frostRim));

  vec2 lightDir = normalize(vec2(0.5, -0.7));
  float rimDot = abs(dot(grad, lightDir));
  float rimFalloff = 1.0 - smoothstep(0.0, bezel * 0.4, distFromEdge);
  float specHighlight = pow(rimDot * rimFalloff, 1.5);
  color += vec3(specHighlight * uSpecular);

  float innerShadow = 1.0 - smoothstep(0.0, bezel * 0.6, distFromEdge);
  color *= mix(1.0, 0.7, innerShadow * 0.3);

  float innerRim = smoothstep(0.0, 2.0, distFromEdge) * (1.0 - smoothstep(2.0, 5.0, distFromEdge));
  color += vec3(innerRim * 0.15 * uSpecular);

  color = mix(color, vec3(1.0), uTint);

  float alpha = smoothstep(0.0, 1.5, distFromEdge);
  gl_FragColor = vec4(color, alpha);
}
`;
