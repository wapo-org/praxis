// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from './index';
import { AttachmentChip } from '../../chat/AttachmentChip';

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Attachment primitive (shadcn port)', () => {
  it('renders states, sizes, orientations, and data-slot attributes cleanly', async () => {
    await act(async () => {
      root.render(
        <AttachmentGroup>
          {(['idle', 'uploading', 'processing', 'error', 'done'] as const).map((state) => (
            <Attachment
              key={state}
              state={state}
              size={state === 'idle' ? 'xs' : state === 'error' ? 'sm' : 'default'}
              orientation={state === 'done' ? 'vertical' : 'horizontal'}
            >
              <AttachmentMedia variant={state === 'done' ? 'image' : 'icon'}>
                {state === 'done' ? <img src="https://example.com/a.png" alt="a" /> : <span>I</span>}
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{state}-file.pdf</AttachmentTitle>
                <AttachmentDescription>PDF · 12 KB</AttachmentDescription>
              </AttachmentContent>
            </Attachment>
          ))}
        </AttachmentGroup>,
      );
    });

    expect(host.querySelector('[data-slot="attachment-group"]')).not.toBeNull();
    for (const state of ['idle', 'uploading', 'processing', 'error', 'done']) {
      expect(host.querySelector(`[data-slot="attachment"][data-state="${state}"]`)).not.toBeNull();
    }
    expect(host.querySelector('[data-slot="attachment"][data-size="xs"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="attachment"][data-size="sm"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="attachment"][data-orientation="vertical"]')).not.toBeNull();
  });

  it('supports AttachmentTrigger as a link and keeps AttachmentActions independent', async () => {
    const onRemove = vi.fn();
    await act(async () => {
      root.render(
        <Attachment state="done">
          <AttachmentTrigger render={<a href="https://example.com/spec.pdf" target="_blank" rel="noreferrer" />} />
          <AttachmentMedia variant="icon">
            <span>P</span>
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>spec.pdf</AttachmentTitle>
            <AttachmentDescription>PDF · 24 KB</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction aria-label="Remove spec.pdf" onClick={onRemove}>
              ×
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>,
      );
    });

    const link = host.querySelector<HTMLAnchorElement>('[data-slot="attachment-trigger"]')!;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://example.com/spec.pdf');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Remove spec.pdf"]')!.click();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('maps blocked files and size warnings on AttachmentChip cleanly', async () => {
    await act(async () => {
      root.render(
        <div>
          <AttachmentChip
            testId="blocked-chip"
            name="huge.bin"
            mediaType="application/octet-stream"
            note="Too large to attach."
            noteLevel="block"
          />
          <AttachmentChip
            testId="uploading-chip"
            name="notes.txt"
            mediaType="text/plain"
            status="Uploading…"
          />
        </div>,
      );
    });

    expect(host.querySelector('[data-testid="blocked-chip"]')?.getAttribute('data-state')).toBe('error');
    expect(host.querySelector('[data-testid="uploading-chip"]')?.getAttribute('data-state')).toBe('uploading');
  });
});
