import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Image, ModalClient} from 'modal';
import {BASE_IMAGE, DEBIAN_PACKAGES, DEBIAN_SNAPSHOT, sandboxBaseImage, sandboxToolsImage, sandboxNotebookImage} from './image.js';

afterEach(() => vi.restoreAllMocks());

describe('sandbox image', () => {
  it('keeps base, tools and downstream layers independently extensible', () => {
    const modal = new ModalClient({tokenId: 'unused', tokenSecret: 'unused'});
    const registry = vi.spyOn(modal.images, 'fromRegistry');
    const base = sandboxBaseImage(modal);
    const tools = sandboxToolsImage(modal);
    const browser = tools.dockerfileCommands(['ENV PRAXIS_TEST_LAYER=browser']);
    expect(registry).toHaveBeenCalledWith(BASE_IMAGE);
    expect(BASE_IMAGE).toMatch(/^node:22\.16\.0-bookworm-slim@sha256:[a-f0-9]{64}$/);
    expect(base).not.toBe(tools);
    expect(browser).not.toBe(tools);
  });

  it('adds Jupyter after the shared tools layer', () => {
    const layer = vi.spyOn(Image.prototype, 'dockerfileCommands');
    sandboxNotebookImage(new ModalClient({tokenId: 'unused', tokenSecret: 'unused'}));
    expect(layer).toHaveBeenCalledTimes(2);
    expect(layer.mock.calls[0]![0].join(' ')).toContain('WORKDIR /workspace');
    const commands = layer.mock.calls[1]![0].join(' ');
    const lock = readFileSync(new URL('./notebook-requirements.lock', import.meta.url), 'utf8');
    expect(commands).toContain(Buffer.from(lock).toString('base64'));
    expect(commands).toContain('--require-hashes');
    expect(commands).toContain('--only-binary=:all:');
    expect(commands).toContain('pip check');
    const requirements = lock.split(/\n(?=[a-z])/).filter(entry => entry.trim());
    expect(requirements.length).toBeGreaterThan(20);
    for (const requirement of requirements) {
      expect(requirement).toMatch(/^[a-z0-9-]+==[0-9.]+/);
      expect(requirement).toMatch(/--hash=sha256:[a-f0-9]{64}/);
    }
    expect(lock).toContain('ipykernel==6.29.5');
    expect(lock).toContain('jupyter-client==8.6.3');
  });

  it('freezes package resolution and bounds installation without weakening apt signatures', () => {
    const layer = vi.spyOn(Image.prototype, 'dockerfileCommands');
    sandboxToolsImage(new ModalClient({tokenId: 'unused', tokenSecret: 'unused'}));
    const commands = layer.mock.calls[0]![0].join('\n');
    expect(commands).toContain(`/archive/debian/${DEBIAN_SNAPSHOT}/`);
    for (const [name, version] of Object.entries(DEBIAN_PACKAGES)) expect(commands).toContain(`${name}=${version}`);
    expect(commands).toContain('timeout 150s');
    expect(commands).toContain('APT::Update::Error-Mode=any');
    expect(commands).not.toMatch(/trusted=yes|allow-unauthenticated|Verify-Peer=false/);
    expect(commands).toContain('WORKDIR /workspace');
  });
});
