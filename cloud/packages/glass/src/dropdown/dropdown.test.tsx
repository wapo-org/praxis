import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DotMeter, GlassDropdown } from '../index';

describe('GlassDropdown (@praxis/glass)', () => {
  it('exposes all compound sub-components required by DROPDOWN_SPEC.md', () => {
    expect(GlassDropdown).toBeDefined();
    expect(GlassDropdown.Trigger).toBeDefined();
    expect(GlassDropdown.Content).toBeDefined();
    expect(GlassDropdown.ActionGrid).toBeDefined();
    expect(GlassDropdown.TileItem).toBeDefined();
    expect(GlassDropdown.Search).toBeDefined();
    expect(GlassDropdown.Header).toBeDefined();
    expect(GlassDropdown.Label).toBeDefined();
    expect(GlassDropdown.Group).toBeDefined();
    expect(GlassDropdown.Item).toBeDefined();
    expect(GlassDropdown.CheckboxItem).toBeDefined();
    expect(GlassDropdown.RadioGroup).toBeDefined();
    expect(GlassDropdown.RadioItem).toBeDefined();
    expect(GlassDropdown.Sub).toBeDefined();
    expect(GlassDropdown.SubTrigger).toBeDefined();
    expect(GlassDropdown.SubContent).toBeDefined();
    expect(GlassDropdown.Separator).toBeDefined();
    expect(GlassDropdown.VirtualList).toBeDefined();
  });

  it('renders the Apple Notes 35-frame reference replica (ActionGrid, TileItems, SubTriggers, CheckboxItem, Separator, and destructive Item)', () => {
    const html = renderToStaticMarkup(
      <GlassDropdown open submenuMode="morph" align="end" side="bottom">
        <GlassDropdown.Trigger>More Actions</GlassDropdown.Trigger>
        <GlassDropdown.Content minWidth={268} maxHeight={460}>
          <GlassDropdown.ActionGrid columns={3}>
            <GlassDropdown.TileItem icon={<span>[scan]</span>}>Scan</GlassDropdown.TileItem>
            <GlassDropdown.TileItem icon={<span>[pin]</span>} active>
              Pin Note
            </GlassDropdown.TileItem>
            <GlassDropdown.TileItem icon={<span>[lock]</span>}>Lock</GlassDropdown.TileItem>
          </GlassDropdown.ActionGrid>

          <GlassDropdown.Item icon={<span>[find]</span>}>Find in Note</GlassDropdown.Item>
          <GlassDropdown.Item icon={<span>[move]</span>}>Move Note</GlassDropdown.Item>

          <GlassDropdown.Sub id="recent-notes" label="Recent Notes">
            <GlassDropdown.SubTrigger>Recent Notes</GlassDropdown.SubTrigger>
            <GlassDropdown.SubContent>
              <GlassDropdown.Item lines={3}>
                am i missing something? the protestors are over...
              </GlassDropdown.Item>
            </GlassDropdown.SubContent>
          </GlassDropdown.Sub>

          <GlassDropdown.CheckboxItem checked onCheckedChange={() => {}}>
            Suggest Results
          </GlassDropdown.CheckboxItem>

          <GlassDropdown.Separator variant="section" />

          <GlassDropdown.Item tone="destructive">Delete</GlassDropdown.Item>
        </GlassDropdown.Content>
      </GlassDropdown>,
    );

    expect(html).toContain('data-slot="dropdown-action-grid"');
    expect(html).toContain('Scan');
    expect(html).toContain('Pin Note');
    expect(html).toContain('Lock');
    expect(html).toContain('Find in Note');
    expect(html).toContain('Move Note');
    expect(html).toContain('Recent Notes');
    expect(html).toContain('role="menuitemcheckbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('data-tone="destructive"');
    expect(html).toContain('Delete');
    // At root level (subPath = []), morph SubContent is not yet rendered
    expect(html).not.toContain('am i missing something?');
  });

  it('morphs in-place when subPath targets a Sub menu (IMG_7769–IMG_7774 elevation to header + multi-line items)', () => {
    const html = renderToStaticMarkup(
      <GlassDropdown
        open
        submenuMode="morph"
        subPath={['recent-notes']}
        align="end"
        side="bottom"
      >
        <GlassDropdown.Trigger>More Actions</GlassDropdown.Trigger>
        <GlassDropdown.Content minWidth={268} maxHeight={460}>
          <GlassDropdown.ActionGrid columns={3}>
            <GlassDropdown.TileItem icon={<span>[scan]</span>}>Scan</GlassDropdown.TileItem>
            <GlassDropdown.TileItem icon={<span>[pin]</span>}>Pin Note</GlassDropdown.TileItem>
            <GlassDropdown.TileItem icon={<span>[lock]</span>}>Lock</GlassDropdown.TileItem>
          </GlassDropdown.ActionGrid>

          <GlassDropdown.Item>Find in Note</GlassDropdown.Item>

          <GlassDropdown.Sub id="recent-notes" label="Recent Notes">
            <GlassDropdown.SubTrigger>Recent Notes</GlassDropdown.SubTrigger>
            <GlassDropdown.SubContent>
              <GlassDropdown.Item lines={3}>
                am i missing something? the protestors are over...
              </GlassDropdown.Item>
              <GlassDropdown.Separator variant="hairline" />
              <GlassDropdown.Item lines={3}>
                Using this repository, and plus find some for search...
              </GlassDropdown.Item>
              <GlassDropdown.Separator variant="hairline" />
              <GlassDropdown.Item lines={3}>
                figure of around 40% refers to ethnic kazakhs...
              </GlassDropdown.Item>
              <GlassDropdown.Separator variant="hairline" />
              <GlassDropdown.Item lines={3}>
                Hi, I got disconnected again. My name is Artem...
              </GlassDropdown.Item>
              <GlassDropdown.Separator variant="hairline" />
              <GlassDropdown.Item lines={3}>
                Hi Fiero, / okay so to summarise the total code...
              </GlassDropdown.Item>
            </GlassDropdown.SubContent>
          </GlassDropdown.Sub>

          <GlassDropdown.Item tone="destructive">Delete</GlassDropdown.Item>
        </GlassDropdown.Content>
      </GlassDropdown>,
    );

    // Elevated submenu sticky header is rendered
    expect(html).toContain('Recent Notes');
    // All 5 multi-line child note items are rendered with 3-line clamp
    expect(html).toContain('am i missing something? the protestors are over...');
    expect(html).toContain('Using this repository, and plus find some for search...');
    expect(html).toContain('figure of around 40% refers to ethnic kazakhs...');
    expect(html).toContain('Hi, I got disconnected again. My name is Artem...');
    expect(html).toContain('Hi Fiero, / okay so to summarise the total code...');
    expect(html).toContain('-webkit-line-clamp:3');
    // Parent root items and top ActionGrid are replaced by the elevated submenu view
    expect(html).not.toContain('Find in Note');
    expect(html).not.toContain('data-slot="dropdown-action-grid"');
  });

  it('supports cascade submenu mode alongside RadioGroup and RadioItem selection', () => {
    const onValueChange = vi.fn();
    const html = renderToStaticMarkup(
      <GlassDropdown open submenuMode="cascade" subPath={['math-results']}>
        <GlassDropdown.Trigger>Options</GlassDropdown.Trigger>
        <GlassDropdown.Content>
          <GlassDropdown.Header title="Note Settings" subtitle="Configure behavior" />
          <GlassDropdown.Group label="Computation">
            <GlassDropdown.Sub id="math-results" label="Math Results">
              <GlassDropdown.SubTrigger value="Insert">Math Results</GlassDropdown.SubTrigger>
              <GlassDropdown.SubContent>
                <GlassDropdown.RadioGroup value="insert" onValueChange={onValueChange}>
                  <GlassDropdown.RadioItem value="insert">Insert Results</GlassDropdown.RadioItem>
                  <GlassDropdown.RadioItem value="suggest">Suggest Results</GlassDropdown.RadioItem>
                </GlassDropdown.RadioGroup>
              </GlassDropdown.SubContent>
            </GlassDropdown.Sub>
          </GlassDropdown.Group>
        </GlassDropdown.Content>
      </GlassDropdown>,
    );

    expect(html).toContain('Note Settings');
    expect(html).toContain('Computation');
    expect(html).toContain('Insert Results');
    expect(html).toContain('Suggest Results');
    expect(html).toContain('role="menuitemradio"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
  });

  it('virtualizes 500 items inside Search + VirtualList so only the windowed slice is mounted in the DOM', () => {
    const models = Array.from({ length: 500 }, (_, i) => ({
      id: `model-${i + 1}`,
      name: `Synthetic Model #${i + 1}`,
      speed: (i % 5) + 1,
      intelligence: ((i + 2) % 5) + 1,
    }));

    const html = renderToStaticMarkup(
      <GlassDropdown open>
        <GlassDropdown.Trigger value="128k">Synthetic Model #1</GlassDropdown.Trigger>
        <GlassDropdown.Content minWidth={320} maxHeight={360}>
          <GlassDropdown.Search
            value="Synthetic"
            onValueChange={() => {}}
            placeholder="Filter 500+ models…"
          />
          <GlassDropdown.VirtualList
            items={models}
            itemHeight={50}
            height={250}
            overscan={4}
            renderItem={(m) => (
              <GlassDropdown.Item
                key={m.id}
                badge={<DotMeter value={m.speed} label="⚡" />}
                trailingAction={<button type="button">★</button>}
              >
                {m.name}
              </GlassDropdown.Item>
            )}
          />
        </GlassDropdown.Content>
      </GlassDropdown>,
    );

    expect(html).toContain('data-slot="dropdown-search"');
    expect(html).toContain('aria-label="Clear search"');
    // First items inside the initial viewport + overscan are rendered
    expect(html).toContain('Synthetic Model #1');
    expect(html).toContain('Synthetic Model #10');
    // Far-off items (e.g., #250, #500) are not mounted in the DOM
    expect(html).not.toContain('Synthetic Model #250');
    expect(html).not.toContain('Synthetic Model #500');
  });
});
