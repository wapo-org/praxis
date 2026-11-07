import { afterEach, expect, it, vi } from 'vitest';
import { generateMapsAsync } from './displacement-map';
afterEach(() => vi.unstubAllGlobals());
it('encodes cold maps asynchronously once per geometry without synchronous PNG encoding', async () => {
  const toDataURL = vi.fn(() => {
    throw new Error('synchronous encoder');
  });
  const toBlob = vi.fn((done: (blob: Blob) => void) =>
    queueMicrotask(() => done(new Blob(['png']))),
  );
  const ctx = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    fillRect: vi.fn(),
    fillStyle: '',
  };
  vi.stubGlobal('window', { devicePixelRatio: 2 });
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => ctx, toBlob, toDataURL }),
  });
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:image/png;base64,cG5n';
      onload?: () => void;
      readAsDataURL() {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  const spec = { width: 123, height: 157, radius: 32, bezel: 22, material: 'regular' as const };
  const first = generateMapsAsync(spec);
  expect(generateMapsAsync(spec)).toBe(first);
  const maps = await first;
  expect(maps).toMatchObject({
    width: 123,
    height: 157,
    displacementUrl: 'data:image/png;base64,cG5n',
  });
  expect(toBlob).toHaveBeenCalledTimes(3);
  expect(toDataURL).not.toHaveBeenCalled();
  expect(await generateMapsAsync(spec)).toBe(maps);
  expect(toBlob).toHaveBeenCalledTimes(3);
});
