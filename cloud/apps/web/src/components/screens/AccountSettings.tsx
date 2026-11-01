import React from 'react';
import { useAccount } from '../../lib/account';
import { Trash2 } from '../../lib/icons';
import { DeleteAccountSheet } from './DeleteAccountSheet';
import { Card, ScreenButton, Section, TaskError } from './ScreenUI';
export function AccountSettings() {
  const account = useAccount();
  const [deleting, setDeleting] = React.useState(false);
  if (!account) return null;
  return (
    <Section title="Account">
      <Card>
        <div className="screen-row-copy" style={{ padding: 14 }}>
          <strong>{account.userId}</strong>
          <span className="screen-detail">Server: {account.server}</span>
        </div>
      </Card>
      <TaskError error={account.error || null} />
      <ScreenButton disabled={account.busy} onClick={() => void account.signOut()}>
        Sign out
      </ScreenButton>
      <Card>
        <button
          type="button"
          className="screen-row screen-nav-row screen-row--destructive"
          data-testid="delete-account-row"
          onClick={() => setDeleting(true)}
        >
          <span className="screen-row-icon">
            <Trash2 size={18} aria-hidden="true" />
          </span>
          <span className="screen-row-copy">
            <strong>Delete account</strong>
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
