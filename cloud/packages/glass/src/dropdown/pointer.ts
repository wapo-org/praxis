import React from 'react';
import { isScrollPan, scrollContainer } from './gestures';
/** Hit-testing works with touch's implicit capture as well as mouse dragging. */
export function usePointerRelease(
  open: boolean,
  isScrubbing: () => boolean,
  endScrub: () => void,
  startedOnTrigger: () => boolean,
  getMenu: () => HTMLElement | null,
  getTrigger: () => HTMLElement | null,
  setOpen: (open: boolean) => void,
) {
  const ignoreClick = React.useRef(0);
  React.useEffect(() => {
    const suppress = (e: MouseEvent) => {
      if (e.isTrusted && Date.now() < ignoreClick.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        ignoreClick.current = 0;
      }
    };
    document.addEventListener('click', suppress, true);
    return () => document.removeEventListener('click', suppress, true);
  }, []);
  React.useEffect(() => {
    if (!open) return;
    let gesture: { x: number; y: number; scroll: HTMLElement | null; panning: boolean } | null = null;
    const down = (e: PointerEvent) => {
      ignoreClick.current = 0;
      gesture = { x: e.clientX, y: e.clientY, scroll: e.pointerType === 'touch' ? scrollContainer(e.target as Element, getMenu()) : null, panning: false };
    };
    const move = (e: PointerEvent) => {
      const container = gesture?.scroll;
      if (!gesture || !container || startedOnTrigger()) return;
      if (isScrollPan(e.clientX - gesture.x, e.clientY - gesture.y,
        container.scrollHeight > container.clientHeight + 1, container.scrollWidth > container.clientWidth + 1)) {
        gesture.panning = true;
        endScrub();
      }
    };
    const up = (e: PointerEvent) => {
      if (gesture?.panning) { ignoreClick.current = Date.now() + 500; gesture = null; endScrub(); return; }
      gesture = null;
      if (!isScrubbing()) return;
      endScrub();
      const hit = document.elementFromPoint?.(
        e.clientX,
        e.clientY,
      ) as HTMLElement | null;
      if (hit && getTrigger()?.contains(hit)) return;
      const row = hit?.closest<HTMLElement>('[data-dropdown-item-id]');
      if (row && getMenu()?.contains(row) && !row.hasAttribute('disabled')) {
        row.click();
      } else if (!hit || !getMenu()?.contains(hit)) setOpen(false);
      else return;
      ignoreClick.current = Date.now() + 500;
    };
    const cancel = () => {
      const dismiss = isScrubbing() && startedOnTrigger();
      gesture = null;
      endScrub();
      if (dismiss) setOpen(false);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [open, isScrubbing, endScrub, startedOnTrigger, getMenu, getTrigger, setOpen]);
}
