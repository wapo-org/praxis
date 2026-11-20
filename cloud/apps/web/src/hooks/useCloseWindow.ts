import React from 'react';

/** Closes a window this app opened (the connect popup); a tab the user opened ignores the request. */
export function useCloseWindow(): void {
  React.useEffect(() => {
    window.close();
  }, []);
}
