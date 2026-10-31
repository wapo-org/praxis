/** Native pans stay native; a drag from the trigger always remains a selection gesture. */
export function scrollContainer(target: Element | null, menu: HTMLElement | null): HTMLElement | null {
  for (let node = target; node && menu?.contains(node); node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    if ((/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) ||
        (/auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1)) return node;
  }
  return null;
}
export function isScrollPan(dx: number, dy: number, vertical: boolean, horizontal: boolean) {
  return (vertical && Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.15) ||
    (horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.15);
}
