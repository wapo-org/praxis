import { FRAG_SRC, VERT_SRC } from './shaders';
import { MATERIAL_PARAMS } from './params';
import {
  MATERIAL_RAMP,
  INTENSITY_BASE_SCALE,
  type MaterialLevel,
  type RefractionIntensity,
} from '../engine-detect';
export interface SurfaceParams {
  material: MaterialLevel;
  intensity: RefractionIntensity;
  frost: 'progressive' | 'uniform' | 'none';
  radius: number;
  rim: number;
}
/** One offscreen WebGL context; 2D presentation canvases never allocate GL contexts. */
export class RefractionRenderer {
  readonly canvas = document.createElement('canvas');
  readonly gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private buffer: WebGLBuffer;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  constructor(onLost: () => void) {
    const gl = this.canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw Error('WebGL unavailable');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      onLost();
    });
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw Error(error ?? 'Shader compilation failed');
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC),
      fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw Error('Shader link failed');
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, parameter, gl.CLAMP_TO_EDGE);
    for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, parameter, gl.LINEAR);
  }
  private u(name: string) {
    if (!this.uniforms.has(name))
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }
  upload(source: HTMLCanvasElement) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }
  render(box: DOMRect, output: HTMLCanvasElement, params: SurfaceParams) {
    const gl = this.gl,
      p = MATERIAL_PARAMS[params.material],
      ramp = MATERIAL_RAMP[params.material];
    // CSS pixel resolution bounds fill/readback cost; text remains in the untouched DOM layer.
    const w = Math.max(1, Math.ceil(box.width)),
      h = Math.max(1, Math.ceil(box.height));
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(w, this.canvas.width);
      this.canvas.height = Math.max(h, this.canvas.height);
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const pos = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    const vec = (name: string, x: number, y: number) => gl.uniform2f(this.u(name), x, y);
    vec('uResolution', innerWidth, innerHeight);
    vec('uSurfaceOrigin', box.left, box.top);
    vec('uSurfaceSize', box.width, box.height);
    vec('uGlassCenter', box.left + box.width / 2, box.top + box.height / 2);
    vec('uGlassSize', box.width, box.height);
    const values = {
      uRadius: Math.min(params.radius, box.width / 2, box.height / 2),
      uBezel: p.bezel,
      uThickness: p.thickness * INTENSITY_BASE_SCALE[params.intensity],
      uIOR: p.ior,
      uBlur: params.frost === 'none' ? 0 : p.blur,
      uFrost: params.frost === 'progressive' ? ramp.frostRim : 0,
      uFrostSat: ramp.saturate / 100,
      uSpecular: p.specular * params.rim,
      uTint: 0,
      uShadow: 0,
      uBgAspect: innerWidth / innerHeight,
      uHasTex: 1,
    };
    for (const [name, value] of Object.entries(values)) gl.uniform1f(this.u(name), value);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.u('uBgTex'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (output.width !== w || output.height !== h) {
      output.width = w;
      output.height = h;
    }
    const ctx = output.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.canvas, 0, this.canvas.height - h, w, h, 0, 0, w, h);
  }
  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.program);
  }
}
