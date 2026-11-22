import React from 'react';
import { useAction } from 'convex/react';
import { ConvexError } from 'convex/values';
import { api } from '../../../../convex/_generated/api';
import { sheetPaths } from '../lib/navigation';

const POPUP_FEATURES = 'popup,width=560,height=720';
const CONNECT_FAILED = 'Could not start connecting. Try again.';
const DISCONNECT_FAILED = 'Could not disconnect. Try again.';

/** The popup lands on a page that closes itself; a full-page redirect comes back to the route it left. */
export function connectReturnUrl(location: Pick<Location, 'origin' | 'pathname'>, popup: boolean): string {
  const path = popup ? sheetPaths['app-connected'] : location.pathname;
  return `${location.origin}${path}`;
}

/** The server hands back Composio's hosted page; anything but http(s) is refused before navigating. */
export function connectTarget(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(CONNECT_FAILED);
  return url.href;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ConvexError && typeof cause.data === 'string' ? cause.data : fallback;
}

export interface AppConnect {
  /** The toolkit whose connect or disconnect is in flight. */
  busy: string | null;
  error: string | null;
  connect(toolkit: string): void;
  disconnect(toolkit: string): void;
}

/** Connect and disconnect through the PRA-47 Convex actions; the reactive connections query shows the result. */
export function useAppConnect(): AppConnect {
  const connectAction = useAction(api.composio.connections.connect);
  const disconnectAction = useAction(api.composio.connections.disconnect);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);

  const run = React.useCallback(async (toolkit: string, fallback: string, task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(toolkit);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(messageOf(cause, fallback));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, []);

  const connect = React.useCallback((toolkit: string) => {
    if (inFlight.current) return;
    // Open during the click gesture: a window opened after the request is blocked.
    const popup = window.open('about:blank', '_blank', POPUP_FEATURES);
    if (popup) popup.opener = null;
    void run(toolkit, CONNECT_FAILED, async () => {
      try {
        const returnTo = connectReturnUrl(window.location, popup !== null);
        const target = connectTarget(await connectAction({ toolkit, returnTo }));
        if (popup) popup.location.replace(target);
        else window.location.assign(target);
      } catch (cause) {
        popup?.close();
        throw cause;
      }
    });
  }, [connectAction, run]);

  const disconnect = React.useCallback((toolkit: string) => {
    void run(toolkit, DISCONNECT_FAILED, async () => {
      await disconnectAction({ toolkit });
    });
  }, [disconnectAction, run]);

  return { busy, error, connect, disconnect };
}
