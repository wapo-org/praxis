import React from 'react';
import { useAccount } from '../../lib/account';
import { Trash2 } from '../../lib/icons';
import { DeleteAccountSheet } from './DeleteAccountSheet';
import { Card, Section, TaskError } from './ScreenUI';
import styles from './Screen.module.css';
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
          <span className={styles.rowCopy}>
            Delete account
          </span>
        </button>
      </Card>
      {deleting && (
        <DeleteAccountSheet
          server={account.server}
          onDelete={account.deleteAccount}
          onDismiss={() => setDeleting(false)}
        />
      )}
    </Section>
  );
}
