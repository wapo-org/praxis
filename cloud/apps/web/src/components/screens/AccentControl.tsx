import { ACCENTS, setAccent, useAccent } from '../../lib/accent';
import { Check } from '../../lib/icons';
import styles from './AccentControl.module.css';
export function AccentControl() {
  const value = useAccent();
  return (
    <fieldset className={styles.field}>
      <legend>Accent</legend>
      <div role="radiogroup" aria-label="Accent" className={styles.swatches}>
        {ACCENTS.map((accent, index) => (
          <button
            key={accent}
            type="button"
            role="radio"
            aria-label={accent[0]!.toUpperCase() + accent.slice(1)}
            aria-checked={value === accent}
            tabIndex={value === accent ? 0 : -1}
            data-accent-choice={accent}
            className={styles.swatch}
            title={accent[0]!.toUpperCase() + accent.slice(1)}
            onClick={() => setAccent(accent)}
            onKeyDown={(event) => {
              const offset =
                event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : 0;
              if (!offset && event.key !== 'Home' && event.key !== 'End') return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? ACCENTS.length - 1
                    : (index + offset + ACCENTS.length) % ACCENTS.length;
              setAccent(ACCENTS[next]!);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('button')
                [next]?.focus();
            }}
          >
            {value === accent ? <Check size={16} /> : null}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
