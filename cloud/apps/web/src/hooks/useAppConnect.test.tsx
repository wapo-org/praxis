// @vitest-environment jsdom
import { ConvexError } from 'convex/values';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectReturnUrl, connectTarget, type AppConnect, useAppConnect } from './useAppConnect';

const connectAction = vi.fn();
const disconnectAction = vi.fn();
vi.mock('convex/react', () => ({
  useAction: (reference: unknown) => (String(reference).includes('disconnect') ? disconnectAction : connectAction),
}));
vi.mock('../../../../convex/_generated/api', () => ({
  api: { composio: { connections: { connect: 'composio/connections:connect', disconnect: 'composio/connections:disconnect' } } },
}));

let hook: AppConnect;
function Probe() {
  hook = useAppConnect();
  return null;
}
let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  connectAction.mockReset();
  disconnectAction.mockReset();
  host = document.createElement('div');
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

describe('connect return and target URLs', () => {
  it('returns a popup to the self-closing page and a full-page redirect to the route it left', () => {
    const location = { origin: 'https://praxis.example', pathname: '/c/chat-1' };
    expect(connectReturnUrl(location, true)).toBe('https://praxis.example/settings/apps/connected');
    expect(connectReturnUrl(location, false)).toBe('https://praxis.example/c/chat-1');
  });

  it('navigates only to http(s) connect pages', () => {
    expect(connectTarget('https://connect.composio.dev/link/abc')).toBe('https://connect.composio.dev/link/abc');
    expect(() => connectTarget('javascript:alert(1)')).toThrow('Could not start connecting');
  });
});

describe('useAppConnect', () => {
  it('opens the popup during the click and sends it to the Connect Link', async () => {
    const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    connectAction.mockResolvedValue('https://connect.composio.dev/link/abc');
    await act(async () => hook.connect('gmail'));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank', expect.stringContaining('popup'));
    expect(popup.opener).toBeNull();
    expect(connectAction).toHaveBeenCalledWith({ toolkit: 'gmail', returnTo: `${window.location.origin}/settings/apps/connected` });
    expect(popup.location.replace).toHaveBeenCalledWith('https://connect.composio.dev/link/abc');
    expect(hook.busy).toBeNull();
  });

  it('closes the popup and shows the server message when connecting fails', async () => {
    const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    connectAction.mockRejectedValue(new ConvexError('Toolkit is already connected'));
    await act(async () => hook.connect('gmail'));
    expect(popup.close).toHaveBeenCalled();
    expect(hook.error).toBe('Toolkit is already connected');
  });

  it('disconnects and keeps internal errors generic', async () => {
    disconnectAction.mockRejectedValue(new Error('[Request ID: 1] Server Error'));
    await act(async () => hook.disconnect('gmail'));
    expect(disconnectAction).toHaveBeenCalledWith({ toolkit: 'gmail' });
    expect(hook.error).toBe('Could not disconnect. Try again.');
  });
});
