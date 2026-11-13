// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Select } from './fields';

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false,
    media,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
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

describe('Select (GlassDropdown)', () => {
  it('renders a GlassDropdown trigger (no native <select>), preserves form value, and updates via radio menu', async () => {
    const onChange = vi.fn();
    let submitted: Record<string, FormDataEntryValue> = {};

    await act(async () => {
      root.render(
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitted = Object.fromEntries(new FormData(e.currentTarget).entries());
          }}
        >
          <Select aria-label="Transport" name="transport" defaultValue="streamableHttp" onChange={onChange}>
            <option value="streamableHttp">Streamable HTTP</option>
            <option value="sse">Server-sent events (SSE)</option>
            <option value="legacy" disabled>
              Legacy (disabled)
            </option>
          </Select>
          <button type="submit">Save</button>
        </form>,
      );
    });

    expect(host.querySelector('select')).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Transport"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toContain('Streamable HTTP');

    await act(async () => {
      trigger.click();
    });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(items.map((el) => el.textContent?.trim())).toEqual([
      'Streamable HTTP',
      'Server-sent events (SSE)',
      'Legacy (disabled)',
    ]);
    expect(items[2]?.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      items[1]?.click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]?.target?.value).toBe('sse');
    expect(trigger.textContent).toContain('Server-sent events (SSE)');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    expect(submitted.transport).toBe('sse');
  });

  it('enforces required validation proxy on empty selection and passes once selected', async () => {
    let validBefore = true;
    let validAfter = false;
    await act(async () => {
      root.render(
        <form>
          <Select aria-label="Required field" name="req" defaultValue="" required>
            <option value="">Choose one</option>
            <option value="ok">Ready</option>
          </Select>
        </form>,
      );
    });
    const form = host.querySelector('form')!;
    validBefore = form.checkValidity();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Required field"]')!.click();
    });
    await act(async () => {
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[1]?.click();
    });
    validAfter = form.checkValidity();

    expect(validBefore).toBe(false);
    expect(validAfter).toBe(true);
  });

  it('portals into ancestor <dialog> so dropdowns inside Modal remain inside top-layer dialog', async () => {
    const dialog = document.createElement('dialog');
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    host.append(dialog);
    const modalRoot = createRoot(dialog);
    await act(async () => {
      modalRoot.render(
        <Select aria-label="Saved value type" defaultValue="variable">
          <optgroup label="Kinds">
            <option value="variable">Variable</option>
            <option value="secret">Secret</option>
          </optgroup>
        </Select>,
      );
    });

    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('button[aria-label="Saved value type"]')!.click();
    });
    const menu = dialog.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(dialog.querySelector('[role="menuitemradio"]')).not.toBeNull();
    await act(async () => modalRoot.unmount());
  });
});
