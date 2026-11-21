import React from 'react';

/** Closes an overlay when Escape is pressed outside editable inputs. */
export function useEscapeToClose(onClose: () => void) {
  const latest = React.useRef(onClose);
  latest.current = onClose;

  React.useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        latest.current();
      }
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, []);
}
