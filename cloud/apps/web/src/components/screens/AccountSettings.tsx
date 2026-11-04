import React from 'react';
import { useAccount } from '../../lib/account';
import { Trash2 } from '../../lib/icons';
import { Card, Section, TaskError, useScreenTask } from './ScreenUI';
import styles from './DeleteConfirm.module.css';

/** Inline account deletion: an explicit two-step confirm inside the page. */
export function AccountSettings() {
  const account = useAccount();
  const [deleting, setDeleting] = React.useState(false);
  if (!account) return null;
  return (
    <Section title="Signed in as">
      <Card>
        <div className={styles.row}>
          <span className={styles.rowCopy}>
            <span>{account.userId}</span>
            <span className={styles.detail}>Server: {account.server}</span>
          </span>
        </div>
        <button
          type="button"
          className={`${styles.row} ${styles.navRow}`}
          disabled={account.busy}
          onClick={() => void account.signOut()}
        >
          Sign out
        </button>
      </Card>
      <TaskError error={account.error || null} />
      <Card>
        <button
          type="button"
          className={`${styles.row} ${styles.navRow} ${styles.rowDestructive}`}
          data-testid="delete-account-row"
          onClick={() => setDeleting(true)}
        >
          <span className={styles.rowIcon}>
            <Trash2 size={18} aria-hidden="true" />
          </span>
          <span className={styles.rowCopy}>Delete account</span>
        </button>
      </Card>
      {deleting ? (
        <DeleteAccountConfirm
          server={account.server}
          onDelete={account.deleteAccount}
          onDismiss={() => setDeleting(false)}
        />
      ) : null}
    </Section>
  );
}

/** The destructive confirmation lives inline (no modal, no scrim). */
function DeleteAccountConfirm({
  server,
  onDelete,
  onDismiss,
}: {
  server: string;
  onDelete: (password: string) => Promise<void>;
  onDismiss: () => void;
}) {
  const [password, setPassword] = React.useState('');
  const task = useScreenTask();
  const submit = () => void task.run(() => onDelete(password));
  return (
    <div className={styles.confirm} data-testid="delete-account-confirm">
      <h2 className={styles.heading}>Delete your account?</h2>
      <p className={styles.intro}>
        This permanently deletes your account on {server}: all chats and messages, runs,
        attachments, skills, connectors and their sign-ins, provider keys, settings and
        consents. Every device is signed out. This can't be undone.
      </p>
      <label className={styles.field}>
        Password
        <input
          type="password"
          autoComplete="current-password"
          data-testid="delete-account-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <p className={styles.footnote}>
        Signed in less than five minutes ago? You can leave the password empty.
      </p>
      <TaskError error={task.error} />
      <button
        type="button"
        className={styles.destructive}
        disabled={task.busy}
        onClick={submit}
      >
        {task.busy ? 'Deleting…' : 'Delete account permanently'}
      </button>
      <button
        type="button"
        className={styles.secondary}
        disabled={task.busy}
        onClick={onDismiss}
      >
        Cancel
      </button>
    </div>
  );
}
