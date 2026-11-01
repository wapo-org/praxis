import React from 'react';
import {
  ScreenBody,
  ScreenButton,
  ScreenHeader,
  SheetDialog,
  TaskError,
  useScreenTask,
} from './ScreenUI';

/** Destructive confirmation for DELETE /v1/account: the API needs the password unless the session is fresh. */
export function DeleteAccountSheet({
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
    <SheetDialog label="Delete account" onDismiss={() => !task.busy && onDismiss()}>
      <ScreenHeader title="Delete account" />
      <ScreenBody>
        <form
          className="screen-delete-account"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <h2 className="screen-consent-heading">Delete your account?</h2>
          <p className="screen-intro">
            This permanently deletes your account on {server}: all chats and messages, runs,
            attachments, skills, connectors and their sign-ins, provider keys, settings and
            consents. Every device is signed out. This can’t be undone.
          </p>
          <label className="screen-field">
            Password
            <input
              type="password"
              autoComplete="current-password"
              data-testid="delete-account-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <p className="screen-footnote">
            Signed in less than five minutes ago? You can leave the password empty.
          </p>
          <TaskError error={task.error} />
          <ScreenButton type="submit" tone="destructive" disabled={task.busy}>
            {task.busy ? 'Deleting…' : 'Delete account permanently'}
          </ScreenButton>
          <ScreenButton disabled={task.busy} onClick={onDismiss}>
            Cancel
          </ScreenButton>
        </form>
      </ScreenBody>
    </SheetDialog>
  );
}
