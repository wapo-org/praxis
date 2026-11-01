import { backdropRoot, paintBackdrop } from './backdrop';
import { RefractionRenderer, type SurfaceParams } from './renderer';
interface Surface {
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  params: SurfaceParams;
  visible: boolean;
}
/** Mutation-driven recapture rate cap (scroll, resize and input still repaint on the next frame). */
export const MUTATION_INTERVAL_MS = 100;
const MAX_MEASURED_MUTATIONS = 64;
/** Demand-driven shared renderer. No persistent RAF and no GL allocation per surface. */
export class GlassWebGLRuntime {
  private renderer?: RefractionRenderer;
  private surfaces = new Map<HTMLElement, Surface>();
  private frame = 0;
  private failed = false;
  private scene = document.createElement('canvas');
  private observer: IntersectionObserver;
  private resize: ResizeObserver;
  private mutations: MutationObserver;
  private lastMutationPaint = -Infinity;
  private mutationTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private onFailure: () => void,
    private onRestored: () => void = () => {},
  ) {
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const s = this.surfaces.get(e.target as HTMLElement);
        if (s) s.visible = e.isIntersecting;
      }
      this.invalidate();
    });
    this.resize = new ResizeObserver(() => this.invalidate());
    this.mutations = new MutationObserver((records) => {
      if (this.behindGlass(records)) this.invalidateThrottled();
    });
    this.mutations.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'value'],
    });
    window.addEventListener('scroll', this.invalidate, { capture: true, passive: true });
    window.addEventListener('resize', this.invalidate);
    document.addEventListener('visibilitychange', this.visibility);
    document.addEventListener('input', this.invalidate);
    document.fonts?.ready.then(this.invalidate);
  }
  private visibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    } else this.invalidate();
  };
  /**
   * Whether any mutation can show through a visible surface: outside every surface, and intersecting one.
   * Huge batches are assumed relevant rather than measured one by one.
   */
  private behindGlass(records: MutationRecord[]) {
    const boxes = [...this.surfaces.values()]
      .filter((s) => s.visible && s.element.isConnected)
      .map((s) => s.element.getBoundingClientRect());
    if (!boxes.length) return false;
    if (records.length > MAX_MEASURED_MUTATIONS) return true;
    return records.some((r) => {
      const el = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!el || el.closest('[data-glass-webgl]')) return false;
      const box = el.getBoundingClientRect();
      return boxes.some(
        (b) => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top,
      );
    });
  }
  /** DOM churn behind the glass (e.g. streaming text) recaptures at most every MUTATION_INTERVAL_MS. */
  private invalidateThrottled() {
    if (this.mutationTimer) return;
    const wait = this.lastMutationPaint + MUTATION_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      this.lastMutationPaint = performance.now();
      this.invalidate();
      return;
    }
    this.mutationTimer = setTimeout(() => {
      this.mutationTimer = undefined;
      this.lastMutationPaint = performance.now();
      this.invalidate();
    }, wait);
  }
  invalidate = () => {
    if (!this.frame && !this.failed && !document.hidden)
      this.frame = requestAnimationFrame(this.render);
  };
  add(element: HTMLElement, canvas: HTMLCanvasElement, params: SurfaceParams) {
    this.surfaces.set(element, { element, canvas, params, visible: false });
    this.observer.observe(element);
    this.resize.observe(element);
    this.invalidate();
    return () => {
      this.observer.unobserve(element);
      this.resize.unobserve(element);
      this.surfaces.delete(element);
    };
  }
  /** A lost context can come back: re-negotiate (back to refraction) when the browser restores it. */
  private lost = () => {
    const canvas = this.renderer?.canvas;
    canvas?.addEventListener('webglcontextrestored', () => this.onRestored(), { once: true });
    this.fail();
  };
  private fail = () => {
    this.failed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const s of this.surfaces.values()) s.canvas.style.display = 'none';
    this.renderer?.destroy();
    this.onFailure();
  };
  private render = () => {
    this.frame = 0;
    if (this.failed || document.hidden) return;
    const visible = [...this.surfaces.values()].filter((s) => s.visible && s.element.isConnected);
    if (!visible.length) return;
    try {
      this.renderer ??= new RefractionRenderer(this.lost);
      // Paint/upload once for surfaces sharing a backdrop layer.
      const groups = new Map<HTMLElement, Surface[]>();
      for (const s of visible) {
        const root = backdropRoot(s.element);
        groups.set(root, [...(groups.get(root) ?? []), s]);
      }
      for (const [root, items] of groups) {
        paintBackdrop(root, this.scene, this.invalidate);
        this.renderer.upload(this.scene);
        for (const s of items) {
          const box = s.element.getBoundingClientRect();
          if (
            box.width < 1 ||
            box.height < 1 ||
            box.bottom <= 0 ||
            box.top >= innerHeight ||
            box.right <= 0 ||
            box.left >= innerWidth
          )
            continue;
          this.renderer.render(box, s.canvas, s.params);
          if (s.canvas.dataset.glassWebgl !== 'ready') s.canvas.dataset.glassWebgl = 'ready';
        }
      }
    } catch {
      this.fail();
    }
  };
  destroy() {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.mutationTimer);
    this.observer.disconnect();
    this.resize.disconnect();
    this.mutations.disconnect();
    window.removeEventListener('scroll', this.invalidate, true);
    window.removeEventListener('resize', this.invalidate);
    document.removeEventListener('visibilitychange', this.visibility);
    document.removeEventListener('input', this.invalidate);
    this.renderer?.destroy();
    this.surfaces.clear();
  }
}
let shared: GlassWebGLRuntime | undefined;
let users = 0;
export function registerRefraction(
  element: HTMLElement,
  canvas: HTMLCanvasElement,
  params: SurfaceParams,
  onFailure: () => void,
  onRestored?: () => void,
) {
  shared ??= new GlassWebGLRuntime(onFailure, onRestored);
  users++;
  const remove = shared.add(element, canvas, params);
  return () => {
    remove();
    if (--users === 0) {
      shared?.destroy();
      shared = undefined;
    }
  };
}
