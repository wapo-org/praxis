import { generateMapsAsync, type GeneratedMaps } from '../displacement-map';
import { glassTier } from '../material';

const SIZE = 128;
const SPEC = { width: SIZE, height: SIZE, radius: SIZE / 2, bezel: 22, material: 'regular' as const };

let ready: GeneratedMaps | null = null;
let started = false;
const listeners = new Set<() => void>();

export function transitMaps(): GeneratedMaps | null {
  return ready;
}

export function subscribeTransit(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called when the first glass mounts, so even the first open of a session finds the map decoded. */
export function warmTransit() {
  if (started || typeof document === 'undefined' || glassTier() !== 'svg') return;
  started = true;
  const build = async () => {
    const maps = await generateMapsAsync(SPEC);
    if (!maps) return;
    void Promise.all(
      [maps.displacementUrl].map((src) => {
        const image = new Image();
        image.src = src;
        return image.decode().catch(() => undefined);
      }),
    ).then(() => {
      ready = maps;
      listeners.forEach((listener) => listener());
    });
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(build, { timeout: 500 });
  else setTimeout(build, 0);
}
