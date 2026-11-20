import { composioAppName } from '@praxis/protocol';
import { type AppConnect, useAppConnect } from '../../hooks/useAppConnect';
import { useAppConnections } from '../../hooks/useAppConnections';
import { appState, connectVerb, type AppState } from '../../lib/apps';
import { Check } from '../../lib/icons';
import styles from './ElicitationCards.module.css';

/** Inline connect for apps a run needed (`composio.connect-required`); a failed connection asks to sign in again. */
export function AppConnectCards({ toolkits }: { toolkits: readonly string[] }) {
  const connections = useAppConnections();
  const actions = useAppConnect();
  return toolkits.map((toolkit) => (
    <AppConnectCard key={toolkit} toolkit={toolkit} state={appState(connections, toolkit)} actions={actions} />
  ));
}

function AppConnectCard({ toolkit, state, actions }: { toolkit: string; state: AppState; actions: AppConnect }) {
  const name = composioAppName(toolkit);
  if (state === 'connected') {
    return (
      <p className={styles.settled} data-testid={`app-connect-done-${toolkit}`} role="status">
        <span className={styles.settledIcon} aria-hidden="true">
          <Check size={16} />
        </span>
        <span className={styles.settledText}>
          <span className={styles.settledVerb}>{name} connected</span>
          <span className={styles.settledSummary}>Send your request again to use it.</span>
        </span>
      </p>
    );
  }
  const verb = connectVerb(state);
  const busy = actions.busy === toolkit;
  return (
    <section className={styles.card} data-testid={`app-connect-card-${toolkit}`} aria-label={`${verb} ${name}`}>
      <div className={styles.body}>
        <p className={styles.message}>
          {state === 'failed' ? `${name} needs you to sign in again.` : `This needs ${name}.`}
        </p>
        <p className={styles.hint}>You sign in on {name}’s own page. Then send your request again.</p>
        {busy || !actions.error ? null : (
          <p className={styles.error} role="alert">
            {actions.error}
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            data-tone="primary"
            disabled={actions.busy !== null || state === 'loading' || state === 'unavailable'}
            onClick={() => actions.connect(toolkit)}
          >
            {busy ? 'Opening…' : `${verb} ${name}`}
          </button>
        </div>
      </div>
    </section>
  );
}
