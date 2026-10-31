import { useAccount } from '../../lib/account';
import { Card, ScreenButton, Section, TaskError } from './ScreenUI';
export function AccountSettings() {
  const account = useAccount();
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
    </Section>
  );
}
