import {beforeEach, describe, expect, it, vi} from 'vitest';
import {FakeSandboxPort} from '../fake.js';
import {sha256} from '../support.js';
import {checkBrowserImage} from './browser-check.js';
import {browserSandboxOptions} from './browser-network.js';
const mocks = vi.hoisted(() => ({build: vi.fn(), create: vi.fn(), terminate: vi.fn(), poll: vi.fn(), ready: vi.fn(), port: vi.fn()}));
vi.mock('modal', () => ({ModalClient: class {
  apps = {fromName: async () => ({appId: 'app'})};
  sandboxes = {create: mocks.create};
}}));
vi.mock('./browser-image.js', () => ({BROWSER_MEMORY_MIB: 2048, sandboxBrowserImage: () => ({build: mocks.build})}));
vi.mock('./port.js', () => ({modalSandboxPort: mocks.port}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.build.mockResolvedValue({imageId: 'image'});
  mocks.create.mockResolvedValue({waitUntilReady: mocks.ready, terminate: mocks.terminate, poll: mocks.poll});
  mocks.poll.mockResolvedValue(0);
  mocks.ready.mockResolvedValue(undefined);
  const port = new FakeSandboxPort();
  port.on(({argv}) => {
    if (argv[0] === 'sh') return {stdout: '123456789 /\n'};
    if (argv[4] === 'screenshot') {
      const path = argv[5]!;
      const bytes = new Uint8Array([137, 80, 78, 71]);
      port.files.set(path, bytes);
      return {stdout: JSON.stringify({ok: true, path, bytes: bytes.length, sha256: sha256(bytes)})};
    }
    return {stdout: '{"ok":true,"snapshot":"Sign in"}'};
  });
  mocks.port.mockReturnValue(port);
});

describe('opt-in Modal browser check', () => {
  it('builds and boots once with public-only egress, measures and terminates', async () => {
    const result = await checkBrowserImage();
    expect(result).toMatchObject({imageId: 'image', filesystemBytes: 123456789, screenshot: {artifact: {ref: 'export-1'}}});
    expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![2]).toMatchObject(browserSandboxOptions());
    expect(mocks.terminate).toHaveBeenCalledWith({wait: true});
    expect(mocks.poll).toHaveBeenCalledTimes(1);
  });

  it('rejects an implausibly small image measurement and still terminates', async () => {
    const port = new FakeSandboxPort().on(() => ({stdout: '521508 /\n'}));
    mocks.port.mockReturnValueOnce(port);
    await expect(checkBrowserImage()).rejects.toThrow();
    expect(mocks.terminate).toHaveBeenCalledWith({wait: true});
  });

  it('terminates even when readiness fails', async () => {
    mocks.ready.mockRejectedValueOnce(new Error('not ready'));
    await expect(checkBrowserImage()).rejects.toThrow('not ready');
    expect(mocks.terminate).toHaveBeenCalledWith({wait: true});
  });

  it('fails when termination has not stopped the sandbox', async () => {
    mocks.poll.mockResolvedValueOnce(null);
    await expect(checkBrowserImage()).rejects.toThrow('still running');
  });
});
