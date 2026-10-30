import React from 'react';
/** Hit-testing works with touch's implicit capture as well as mouse dragging. */
export function usePointerRelease(
  open: boolean,
  isScrubbing: () => boolean,
  endScrub: () => void,
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
    const up = (e: PointerEvent) => {
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
      endScrub();
      setOpen(false);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [open, isScrubbing, endScrub, getMenu, getTrigger, setOpen]);
}
