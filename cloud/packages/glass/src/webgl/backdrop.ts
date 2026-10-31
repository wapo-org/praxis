/** Canvas source for the real DOM behind glass. No DOM screenshot API exists in WebGL.
 * Paint backgrounds, borders, visible text runs, form values and same-origin/CORS images.
 * Native DOM stays authoritative: this texture is only the refracted material layer.
 */
const images = new Map<string, HTMLImageElement>();
function imageFor(url: string, invalidate: () => void) {
  if (!images.has(url)) {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = invalidate;
    image.onerror = () => {
      images.delete(url);
    };
    image.src = url;
    images.set(url, image);
    // Bound the process-wide source cache (texture resources themselves are shared).
    if (images.size > 32) images.delete(images.keys().next().value!);
  }
  return images.get(url);
}
export function backdropRoot(target: HTMLElement): HTMLElement {
  return target.parentElement?.closest<HTMLElement>('[data-glass-surface]') ?? document.body;
}
export function paintBackdrop(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  invalidate: () => void,
) {
  const w = innerWidth,
    h = innerHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle =
    getComputedStyle(document.documentElement).getPropertyValue('--paper-canvas').trim() ||
    '#FBFBF9';
  ctx.fillRect(0, 0, w, h);
  function paint(el: Element) {
    if (
      !(el instanceof HTMLElement) ||
      el.tagName === 'CANVAS' ||
      el.matches('script,style,svg,[data-glass-webgl]')
    )
      return;
    // Never sample a surface's own foreground, nor unrelated overlays above it.
    if (el !== root && el.hasAttribute('data-glass-surface')) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      return;
    const box = el.getBoundingClientRect();
    if (
      el !== root &&
      box.height > 0 &&
      (box.bottom <= 0 || box.top >= h) &&
      !el.querySelector('[style*=\"fixed\"]')
    )
      return;
    const clipped = /(hidden|auto|scroll|clip)/.test(
      style.overflow + style.overflowY + style.overflowX,
    );
    if (clipped && (box.bottom <= 0 || box.top >= h || box.right <= 0 || box.left >= w)) return;
    ctx.save();
    ctx.globalAlpha *= Number(style.opacity) || 1;
    if (box.width && box.height && box.bottom > 0 && box.top < h) {
      const r = Math.min(parseFloat(style.borderRadius) || 0, box.width / 2, box.height / 2);
      ctx.beginPath();
      ctx.roundRect(box.left, box.top, box.width, box.height, r);
      ctx.fillStyle = style.backgroundColor;
      ctx.fill();
      const border = parseFloat(style.borderTopWidth);
      if (border) {
        ctx.lineWidth = border;
        ctx.strokeStyle = style.borderTopColor;
        ctx.stroke();
      }
      const url = style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
      const image = url ? imageFor(url, invalidate) : undefined;
      if (image?.complete && image.naturalWidth) {
        ctx.save();
        ctx.clip();
        const s = Math.max(box.width / image.naturalWidth, box.height / image.naturalHeight);
        ctx.drawImage(
          image,
          box.left + (box.width - image.naturalWidth * s) / 2,
          box.top + (box.height - image.naturalHeight * s) / 2,
          image.naturalWidth * s,
          image.naturalHeight * s,
        );
        ctx.restore();
      }
      if (el instanceof HTMLImageElement && el.complete && el.naturalWidth) {
        // Never taint the shared canvas with a non-CORS remote image.
        if (
          new URL(el.currentSrc || el.src, location.href).origin === location.origin ||
          el.crossOrigin === 'anonymous'
        )
          ctx.drawImage(el, box.left, box.top, box.width, box.height);
      }
    }
    if (clipped) {
      ctx.beginPath();
      ctx.rect(box.left, box.top, box.width, box.height);
      ctx.clip();
    }
    ctx.fillStyle = style.color;
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.textBaseline = 'top';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
        const range = document.createRange();
        const content = child.textContent;
        // Find the visible substring with O(log n) layout reads, including very long pre-wrap messages.
        const boundary = (bottom: boolean, y: number) => {
          let lo = 0,
            hi = content.length;
          while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            range.setStart(child, mid);
            range.setEnd(child, Math.min(mid + 1, content.length));
            const r = range.getBoundingClientRect();
            if ((bottom ? r.bottom : r.top) < y) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        };
        const start = boundary(true, 0),
          end = boundary(false, h);
        for (const match of content.slice(start, end).matchAll(/\S+\s*/g)) {
          const index = start + match.index!;
          range.setStart(child, index);
          range.setEnd(child, index + match[0].length);
          const rect = range.getBoundingClientRect();
          if (rect.bottom > 0 && rect.top < h && rect.right > 0 && rect.left < w)
            ctx.fillText(match[0], rect.left, rect.top);
        }
      } else if (child instanceof Element) paint(child);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // Passwords are never sampled into GPU memory.
      if (!(el instanceof HTMLInputElement && el.type === 'password'))
        ctx.fillText(
          el.value || el.placeholder,
          box.left + parseFloat(style.paddingLeft),
          box.top + parseFloat(style.paddingTop),
        );
    }
    ctx.restore();
  }
  paint(root);
}
