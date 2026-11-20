import { useCloseWindow } from '../../hooks/useCloseWindow';
import { usePraxisStore } from '../../state/store.js';
import { ScreenBody, ScreenButton } from './ScreenUI.js';
import styles from './Screen.module.css';

/** Where the connect popup returns: it closes itself; the opener sees the new state through its live query. */
export function AppConnectedScreen() {
  const store = usePraxisStore();
  useCloseWindow();
  return (
    <ScreenBody>
      <p className={styles.intro} role="status">Sign-in finished. You can close this window.</p>
      <div className={styles.actions}>
        <ScreenButton tone="primary" onClick={() => store.setActiveSheet('apps')}>
          Open the App Directory
        </ScreenButton>
      </div>
    </ScreenBody>
  );
}
