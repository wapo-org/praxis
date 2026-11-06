/** Static, inert copies of live DOM for the morph's arrival layers. */
/** Only what the rows' own CSS reads; ids, test ids, ARIA and row lookups must not exist twice. */
const KEEP = new Set(['class', 'style', 'd', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'data-tone', 'data-active', 'data-checked', 'data-disabled', 'data-highlighted', 'data-trailing-action', 'data-view', 'disabled', 'placeholder', 'type']);
/** A very long list only needs the rows on screen; do not spend a frame on the rest. */
const SCROLL_COPY_LIMIT = 400;

function strip(el: Element) {
  for (const name of el.getAttributeNames()) if (!KEEP.has(name)) el.removeAttribute(name);
}

/** A copy that no assistive technology, focus order, locator or row lookup can reach. */
export function inertCopy<T extends HTMLElement>(from: T): T {
  const copy = from.cloneNode(true) as T;
  strip(copy);
  copy.querySelectorAll('*').forEach(strip);
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  return copy;
}

/** Carry scroll offsets over, so a list scrolled before closing blurs the same rows. Needs the copy connected. */
export function copyScroll(from: HTMLElement, to: HTMLElement) {
  const a = from.querySelectorAll<HTMLElement>('*');
  if (a.length > SCROLL_COPY_LIMIT) return;
  const b = to.querySelectorAll<HTMLElement>('*');
  a.forEach((el, index) => {
    if (el.scrollTop && b[index]) b[index]!.scrollTop = el.scrollTop;
  });
}
