// @vitest-environment jsdom
import { AnimatePresence } from 'framer-motion';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { inertCopy } from './copy';
import { GlassMorph } from './GlassMorph';
import { ownGlass, readSource } from './source';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function rect(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => new DOMRect(left, top, width, height);
}

describe('which class a trigger is', () => {
  const surfaceWith = (html: string) => {
    const surface = document.createElement('div');
    surface.setAttribute('data-glass-surface', 'svg');
    surface.innerHTML = html;
    document.body.appendChild(surface);
    rect(surface, 0, 0, 40, 40);
    return surface;
  };

  it('an icon button alone in its glass is separate: its glass becomes the menu', () => {
    const surface = surfaceWith('<button id="only"><svg></svg></button>');
    const trigger = surface.querySelector<HTMLElement>('#only')!;
    rect(trigger, 2, 2, 36, 36);
    expect(ownGlass(trigger)).toBe(surface);
    expect(readSource(trigger).kind).toBe('separate');
    expect(readSource(trigger).box.width).toBe(40);
  });

  it('a button with text is attached, even in its own glass: only icon buttons morph', () => {
    const surface = surfaceWith('<button id="only"><svg></svg>Export</button>');
    const trigger = surface.querySelector<HTMLElement>('#only')!;
    rect(trigger, 2, 2, 36, 36);
    expect(ownGlass(trigger)).toBeNull();
    expect(readSource(trigger).kind).toBe('attached');
  });

  it('an accessible name is not text: an icon button with aria-label still morphs', () => {
    const surface = surfaceWith('<button id="only" aria-label="Share"><svg></svg></button>');
    const trigger = surface.querySelector<HTMLElement>('#only')!;
    rect(trigger, 2, 2, 36, 36);
    expect(readSource(trigger).kind).toBe('separate');
  });

  it('a button sharing glass with a neighbour is attached, even though it sits in glass', () => {
    const surface = surfaceWith('<button id="a"><svg></svg></button><button id="b"><svg></svg></button>');
    const trigger = surface.querySelector<HTMLElement>('#b')!;
    rect(trigger, 20, 2, 18, 36);
    expect(ownGlass(trigger)).toBeNull();
    const source = readSource(trigger);
    expect(source.kind).toBe('attached');
    expect(source.surface).toBeNull();
    // A small blob on the button, not the button's box.
    expect(source.box.width).toBeLessThan(18);
    expect(source.box.left + source.box.width / 2).toBeCloseTo(29);
    expect(source.radius).toBeCloseTo(source.box.width / 2);
  });

  it('a lone icon button in a much bigger object is attached', () => {
    const surface = surfaceWith('<button id="only"><svg></svg></button>');
    rect(surface, 0, 0, 400, 400);
    const trigger = surface.querySelector<HTMLElement>('#only')!;
    rect(trigger, 2, 2, 36, 36);
    expect(readSource(trigger).kind).toBe('attached');
  });

  it('a button in no glass at all is attached', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    rect(button, 10, 10, 30, 30);
    expect(readSource(button).kind).toBe('attached');
  });
});

describe('the arriving copy', () => {
  it('cannot be found, focused or chosen, and keeps what the rows are styled by', () => {
    const host = document.createElement('div');
    host.innerHTML = '<button id="x" role="menuitem" tabindex="0" data-dropdown-item-id="a" data-testid="row" data-slot="s" aria-label="Row" class="row" data-tone="destructive">Row</button>';
    const copy = inertCopy(host);
    const row = copy.querySelector('button')!;
    expect(copy.getAttribute('aria-hidden')).toBe('true');
    expect(copy.inert).toBe(true);
    for (const name of ['id', 'role', 'tabindex', 'data-dropdown-item-id', 'data-testid', 'data-slot', 'aria-label']) expect(row.hasAttribute(name), name).toBe(false);
    expect(row.className).toBe('row');
    expect(row.getAttribute('data-tone')).toBe('destructive');
  });
});

describe('GlassMorph without layout', () => {
  it('opens and closes at once, so nothing waits on a frame that will never come', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const source = () => null;
    const done = vi.fn();
    const render = (open: boolean) =>
      root.render(
        <AnimatePresence onExitComplete={done}>
          {open ? (
            <GlassMorph key="m" source={source} shellProps={{ id: 'shell' }}>
              <span>row</span>
            </GlassMorph>
          ) : null}
        </AnimatePresence>,
      );
    await act(async () => render(true));
    expect(document.getElementById('shell')).not.toBeNull();
    await act(async () => render(false));
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(document.getElementById('shell')).toBeNull();
    expect(done).toHaveBeenCalledTimes(1);
    root.unmount();
  });
});
