import React from 'react';
import { SIDEBAR_PALETTES, setSidebarPalette, useSidebarPalette } from '../../lib/sidebarPalette';
import styles from './SidebarLookControl.module.css';

/** Arrow keys, Home and End move the choice, like a native radio group. */
function radioKeys<T>(choices: readonly T[], index: number, pick: (value: T) => void) {
  return (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const offset =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!offset && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + offset + choices.length) % choices.length;
    pick(choices[next]!);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
}

/** The owner's palette panel (sidebar-design.html, press P), as Settings rows. Changes apply live. */
export function SidebarLookControl() {
  const palette = useSidebarPalette();
  const paletteIndex = SIDEBAR_PALETTES.findIndex((p) => p.id === palette);
  return (
    <div className={styles.look} data-testid="sidebar-look">
      <fieldset className={styles.field}>
        <legend>Sidebar palette</legend>
        <div role="radiogroup" aria-label="Sidebar palette" className={styles.swatches}>
          {SIDEBAR_PALETTES.map((p, index) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-label={p.name}
              title={p.name}
              aria-checked={palette === p.id}
              tabIndex={palette === p.id || (paletteIndex < 0 && index === 0) ? 0 : -1}
              data-palette-choice={p.id}
              className={styles.swatch}
              style={{ '--swatch': p.base } as React.CSSProperties}
              onClick={() => setSidebarPalette(p.id)}
              onKeyDown={radioKeys(SIDEBAR_PALETTES, index, (next) => setSidebarPalette(next.id))}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}
