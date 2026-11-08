import React from 'react';
import {
  BUTTON_COLORS,
  SIDEBAR_PALETTES,
  setButtonColor,
  setSidebarPalette,
  useButtonColor,
  useSidebarPalette,
} from '../../lib/sidebarPalette';
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
  const button = useButtonColor();
  const preset = BUTTON_COLORS.some((choice) => choice.color === button);
  const paletteIndex = SIDEBAR_PALETTES.findIndex((p) => p.id === palette);
  const buttonIndex = BUTTON_COLORS.findIndex((choice) => choice.color === button);
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
      <fieldset className={styles.field}>
        <legend>Button color</legend>
        <div className={styles.swatches}>
          <div role="radiogroup" aria-label="Button color" className={styles.swatches}>
            {BUTTON_COLORS.map((choice, index) => (
              <button
                key={choice.color}
                type="button"
                role="radio"
                aria-label={choice.name}
                title={choice.name}
                aria-checked={button === choice.color}
                tabIndex={button === choice.color || (buttonIndex < 0 && index === 0) ? 0 : -1}
                data-button-choice={choice.name.toLowerCase()}
                className={styles.swatch}
                style={{ '--swatch': choice.color } as React.CSSProperties}
                onClick={() => setButtonColor(choice.color)}
                onKeyDown={radioKeys(BUTTON_COLORS, index, (next) => setButtonColor(next.color))}
              />
            ))}
          </div>
          <label className={styles.custom} data-selected={!preset}>
            Custom
            <input
              type="color"
              aria-label="Custom button color"
              data-testid="button-color-custom"
              value={button}
              onChange={(event) => setButtonColor(event.currentTarget.value)}
            />
          </label>
        </div>
      </fieldset>
    </div>
  );
}
